const test = require('node:test');
const assert = require('node:assert');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const dbManager = require('../database/dbManager');
const reminderChecker = require('../passives/reminderChecker');
const { addCalendarInZone } = require('../utils/timezone');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Known older reminder bugs, kept running as todo until they're fixed
const KNOWN = { todo: 'known bug, listed under Bugs in the roadmap' };
const TICK = 5000;
// Whole second so next_trigger maths is exact
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const T0_SEC = T0 / 1000;

function db() {
    return dbManager.getDatabase('reminders_db');
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db().run(sql, params, function (err) { return err ? reject(err) : resolve(this.lastID); });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

async function waitFor(check, ms = 3000) {
    for (let waited = 0; waited < ms && !check(); waited += 25) {
        await wait(25);
    }
}

async function reset() {
    await run('DELETE FROM reminder_users');
    await run('DELETE FROM reminders');
    await run('DELETE FROM reminder_settings');
    await run('INSERT INTO reminder_settings (guild_id, channel_id) VALUES (?, ?)', ['g', 'c']);
}

function addReminder({ title = 'R', value = 0, unit = 'once', remaining = 1, guild = 'g', trigger, zone = 'UTC' }) {
    return run(
        `INSERT INTO reminders (title, description, interval_value, interval_unit, repeat_count,
            remaining_repeats, creator_id, guild_id, next_trigger, timezone)
         VALUES (?, NULL, ?, ?, ?, ?, 'u', ?, ?, ?)`,
        [title, value, unit, remaining ?? 0, remaining, guild, trigger, zone]);
}

// Fake Discord client, `send` decides what each send does
function fakeClient({ fetch, send } = {}) {
    const calls = { fetches: 0, sends: [] };
    const client = {
        channels: {
            fetch: async (id) => {
                calls.fetches++;
                if (fetch) return fetch(id);
                return {
                    send: async (payload) => {
                        calls.sends.push(payload);
                        if (send) return send(payload);
                    }
                };
            }
        }
    };
    return { client, calls };
}

async function pump(t, n) {
    for (let i = 0; i < n; i++) {
        t.mock.timers.tick(TICK);
        await wait(150);
    }
}

function startClock(t) {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
}

test.before(() => dbManager.initializeDatabases());
test.after(async () => {
    await dbManager.closeAllConnections();
    removeDir(dir);
});
test.beforeEach(reset);

test('execute called twice (ready again) still sends a slow reminder once', async (t) => {
    await addReminder({ trigger: T0_SEC });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, calls } = fakeClient({ send: () => gate });

    startClock(t);
    await reminderChecker.execute(client);
    await reminderChecker.execute(client);

    await pump(t, 3);
    release();
    await wait(150);
    await pump(t, 3);

    assert.strictEqual(calls.sends.length, 1, 'two intervals sent the same reminder twice');
    assert.deepStrictEqual(await all('SELECT id FROM reminders'), []);
});

test('a recurring reminder whose send fails is not retried every 5 s', async (t) => {
    await addReminder({ value: 1, unit: 'hours', remaining: 3, trigger: T0_SEC });
    const { client, calls } = fakeClient({ send: () => { throw new Error('Missing Permissions'); } });

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 5);

    assert.strictEqual(calls.sends.length, 1, 'failed send was retried on every tick');
});

// Comment above advanceOrDeleteReminder says a repeat is only consumed when actually sent
test('a recurring reminder whose send fails keeps its remaining repeats', KNOWN, async (t) => {
    await addReminder({ value: 1, unit: 'hours', remaining: 3, trigger: T0_SEC });
    const { client } = fakeClient({ send: () => { throw new Error('Missing Permissions'); } });

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 1);

    const [row] = await all('SELECT remaining_repeats, next_trigger FROM reminders');
    assert.strictEqual(row.remaining_repeats, 3, 'a send that failed still used up a repeat');
});

test('a reminder whose channel was deleted is fetched once, not every tick', async (t) => {
    await addReminder({ value: 1, unit: 'hours', remaining: null, trigger: T0_SEC });
    const { client, calls } = fakeClient({ fetch: async () => { throw new Error('Unknown Channel'); } });

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 5);

    assert.strictEqual(calls.fetches, 1);
    const [row] = await all('SELECT next_trigger FROM reminders');
    assert.strictEqual(row.next_trigger, T0_SEC + 3600);
});

// Any failure after the send leaves next_trigger in the past, so the row is due again next tick
test('a failure after a successful send does not resend every 5 s', async (t) => {
    await addReminder({ value: 1, unit: 'days', remaining: null, trigger: T0_SEC, zone: 'Not/AZone' });
    const { client, calls } = fakeClient();

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 4);

    assert.strictEqual(calls.sends.length, 1, `sent ${calls.sends.length} times in 20 s`);
});

test('recurring grace boundary, 300 s late is sent and 301 s late is skipped', async (t) => {
    const at = T0_SEC + 5;
    await addReminder({ title: 'on-time', value: 1, unit: 'hours', remaining: 2, trigger: at - 300 });
    await addReminder({ title: 'missed', value: 1, unit: 'hours', remaining: 2, trigger: at - 301 });
    const { client, calls } = fakeClient();

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 1);

    const titles = calls.sends.map((p) => p.embeds[0].toJSON().title);
    assert.deepStrictEqual(titles, ['Reminder: on-time']);
    const rows = await all('SELECT title, remaining_repeats, next_trigger FROM reminders ORDER BY title');
    assert.deepStrictEqual(rows, [
        { title: 'missed', remaining_repeats: 2, next_trigger: at - 301 + 3600 },
        { title: 'on-time', remaining_repeats: 1, next_trigger: at - 300 + 3600 }
    ]);
});

test('a reminder due on the exact tick second fires, one second later waits', async (t) => {
    const at = T0_SEC + 5;
    await addReminder({ title: 'now', trigger: at });
    await addReminder({ title: 'later', trigger: at + 1 });
    const { client, calls } = fakeClient();

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 1);
    assert.deepStrictEqual(calls.sends.map((p) => p.embeds[0].toJSON().title), ['Reminder: now']);

    await pump(t, 1);
    assert.strictEqual(calls.sends.length, 2, 'next-second reminder missed the following tick');
});

test('many due reminders are each sent exactly once', async (t) => {
    await run('INSERT INTO reminder_settings (guild_id, channel_id) VALUES (?, ?)', ['g2', 'c2']);
    for (let i = 0; i < 40; i++) {
        await addReminder({ title: `r${i}`, guild: i % 2 ? 'g' : 'g2', trigger: T0_SEC - i });
    }
    const { client, calls } = fakeClient();

    startClock(t);
    await reminderChecker.execute(client);
    t.mock.timers.tick(TICK);
    await waitFor(() => calls.sends.length >= 40);
    await wait(200);
    await pump(t, 3);

    assert.strictEqual(calls.sends.length, 40);
    assert.strictEqual(new Set(calls.sends.map((p) => p.embeds[0].toJSON().title)).size, 40);
    assert.deepStrictEqual(await all('SELECT id FROM reminders'), []);
});

test('daily 8 pm New York reminder stays 8 pm across spring forward', async (t) => {
    const mar7_8pmEst = Date.UTC(2026, 2, 8, 1, 0) / 1000;
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: mar7_8pmEst * 1000 });
    await addReminder({ value: 1, unit: 'days', remaining: null, trigger: mar7_8pmEst, zone: 'America/New_York' });
    const { client, calls } = fakeClient();

    await reminderChecker.execute(client);
    await pump(t, 1);

    assert.strictEqual(calls.sends.length, 1);
    const [row] = await all('SELECT next_trigger FROM reminders');
    assert.strictEqual(row.next_trigger, Date.UTC(2026, 2, 9, 0, 0) / 1000, 'not 20:00 EDT on Mar 8');
});

// 02:30 does not exist on spring-forward day, the next day must go back to 02:30
test('daily 2:30 am New York reminder returns to 2:30 after the skipped hour', KNOWN, () => {
    const mar7 = Date.UTC(2026, 2, 7, 7, 30) / 1000;
    const mar8 = addCalendarInZone(mar7, 'days', 1, 'America/New_York');
    const mar9 = addCalendarInZone(mar8, 'days', 1, 'America/New_York');
    assert.strictEqual(new Date(mar9 * 1000).toISOString(), '2026-03-09T06:30:00.000Z',
        'drifted to a different local hour for good');
});

test('monthly reminder on Jan 31 lands in February, not March', KNOWN, () => {
    const jan31 = Date.UTC(2026, 0, 31, 12) / 1000;
    const next = new Date(addCalendarInZone(jan31, 'months', 1, 'UTC') * 1000);
    assert.strictEqual(next.getUTCMonth(), 1, `landed on ${next.toISOString()}`);
});

test('a paused reminder runs again once the 10 min pause is over', async (t) => {
    const id = await addReminder({ value: 1, unit: 'days', remaining: null, trigger: T0_SEC, zone: 'Not/AZone' });
    const { client, calls } = fakeClient();

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 2);
    assert.strictEqual(calls.sends.length, 1);

    await run('UPDATE reminders SET timezone = ? WHERE id = ?', ['UTC', id]);
    t.mock.timers.setTime(T0 + 10 * 60 * 1000 + 6000);
    await pump(t, 2);

    const [row] = await all('SELECT next_trigger FROM reminders');
    assert.strictEqual(row.next_trigger, T0_SEC + 86400, 'pause never lifted');
});

test('a recurring reminder cancelled mid-send is not brought back', async (t) => {
    await addReminder({ value: 1, unit: 'hours', remaining: null, trigger: T0_SEC });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, calls } = fakeClient({ send: () => gate });

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 2);
    await run('DELETE FROM reminders');
    release();
    await wait(150);
    await pump(t, 2);

    assert.strictEqual(calls.sends.length, 1);
    assert.deepStrictEqual(await all('SELECT id FROM reminders'), []);
});

// Overlapping tick whose SELECT read the row before the first tick deleted it, but whose
// callback lands after inFlight was cleared, only reachable with a faked late callback
// since one sqlite3 connection delivers results in completion order
test('a stale SELECT result from an overlapping tick does not send twice', { todo: 'theoretical, needs a faked late SELECT callback' }, async (t) => {
    await addReminder({ trigger: T0_SEC });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, calls } = fakeClient({ send: () => gate });

    const handle = db();
    const realAll = handle.all;
    let selects = 0;
    let deliverStale;
    handle.all = function (sql, params, cb) {
        if (!/FROM reminders WHERE next_trigger/.test(sql)) return realAll.call(this, sql, params, cb);
        selects++;
        if (selects !== 2) return realAll.call(this, sql, params, cb);
        return realAll.call(this, sql, params, (err, rows) => { deliverStale = () => cb(err, rows); });
    };
    t.after(() => { handle.all = realAll; });

    startClock(t);
    await reminderChecker.execute(client);
    await pump(t, 2);
    assert.strictEqual(typeof deliverStale, 'function');

    release();
    await wait(150);
    deliverStale();
    await wait(150);

    assert.strictEqual(calls.sends.length, 1, 'deleted one-time reminder was sent again');
});
