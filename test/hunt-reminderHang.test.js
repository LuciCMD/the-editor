const test = require('node:test');
const assert = require('node:assert');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const dbManager = require('../database/dbManager');
const reminderChecker = require('../passives/reminderChecker');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        dbManager.getDatabase('reminders_db').run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

test.before(() => dbManager.initializeDatabases());
test.after(async () => {
    await dbManager.closeAllConnections();
    removeDir(dir);
});

// Own file since the stuck guard is module state and would break any later test
test('a send that never settles does not stop every other reminder', async (t) => {
    const due = Math.floor(Date.now() / 1000) - 1;
    await run('INSERT INTO reminder_settings (guild_id, channel_id) VALUES (?, ?), (?, ?)', ['a', 'stuck', 'b', 'ok']);
    for (const guild of ['a', 'b']) {
        await run(
            `INSERT INTO reminders (title, description, interval_value, interval_unit, repeat_count,
                remaining_repeats, creator_id, guild_id, next_trigger, timezone)
             VALUES (?, NULL, 0, 'once', 1, 1, 'u', ?, ?, 'UTC')`, [guild, guild, due]);
    }

    const sentTo = [];
    const client = {
        channels: {
            fetch: async (id) => ({
                send: (payload) => {
                    if (id === 'stuck') return new Promise(() => {});
                    sentTo.push(id);
                    return Promise.resolve(payload);
                }
            })
        }
    };

    t.mock.timers.enable({ apis: ['setInterval'] });
    await reminderChecker.execute(client);
    // 2 minutes of ticks
    for (let i = 0; i < 24; i++) {
        t.mock.timers.tick(5000);
        await wait(30);
    }

    assert.deepStrictEqual(sentTo, ['ok'], 'one hung send blocked guild b and every later reminder');
});
