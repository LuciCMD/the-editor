const test = require('node:test');
const assert = require('node:assert');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const dbManager = require('../database/dbManager');
const reminderChecker = require('../passives/reminderChecker');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Promised delay, not read from the module so a slower poll fails here
const FIVE_SECONDS = 5000;

function run(sql, params) {
    return new Promise((resolve, reject) => {
        dbManager.getDatabase('reminders_db').run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

async function waitFor(check, ms = 2000) {
    for (let waited = 0; waited < ms && !check(); waited += 25) {
        await wait(25);
    }
}

test.before(() => dbManager.initializeDatabases());
test.after(async () => {
    test.mock.timers.reset();
    await dbManager.closeAllConnections();
    removeDir(dir);
});

test('a due reminder is sent on the first 5 s check and only once while a slow send runs', async () => {
    const due = Math.floor(Date.now() / 1000) - 1;
    await run('INSERT INTO reminder_settings (guild_id, channel_id) VALUES (?, ?)', ['g', 'c']);
    await run(
        `INSERT INTO reminders (title, description, interval_value, interval_unit, repeat_count,
            remaining_repeats, creator_id, guild_id, next_trigger, timezone)
         VALUES ('Stand up', NULL, 0, 'once', 0, NULL, 'u', 'g', ?, 'UTC')`, [due]);

    let fetches = 0;
    const sent = [];
    let releaseFetch;
    const slowFetch = new Promise((resolve) => { releaseFetch = resolve; });
    const client = {
        channels: {
            fetch: () => {
                fetches++;
                return slowFetch;
            }
        }
    };

    // Only setInterval is faked, so sqlite callbacks and the waits below still run in real time
    test.mock.timers.enable({ apis: ['setInterval'] });
    await reminderChecker.execute(client);

    test.mock.timers.tick(FIVE_SECONDS);
    await waitFor(() => fetches > 0);
    assert.strictEqual(fetches, 1, 'no check ran within 5 s of the reminder being due');

    // Next tick lands while the first send is still waiting on Discord
    test.mock.timers.tick(FIVE_SECONDS);
    await wait(200);
    assert.strictEqual(fetches, 1, 'a second check overlapped the first and would send twice');

    releaseFetch({ send: async (payload) => sent.push(payload) });
    await waitFor(() => sent.length > 0);
    await wait(100);

    test.mock.timers.tick(FIVE_SECONDS);
    await wait(200);
    assert.strictEqual(sent.length, 1, 'reminder was sent more than once');
    assert.strictEqual(fetches, 1, 'one-time reminder was picked up again after sending');
});
