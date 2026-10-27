// Hunts the fixed-size panel, the per-guild panel chain and the repost of a buried panel
// Fake channels keep a real message history so "messages after the panel" is counted like Discord does

process.env.NODE_ENV = 'test'; // DisTube skips its ffmpeg check

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const voiceLib = require('@discordjs/voice');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { DisTube } = require('distube');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const musicEvents = require('../passives/musicEvents');
const musicButtons = require('../components/music');
const { YtDlpPlugin, buildSong } = require('../utils/ytdlpPlugin');

test.after(() => removeDir(dir));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function songs(count, name = (i) => `Song ${i}`) {
    return Array.from({ length: count }, (_, i) => ({ name: name(i), url: `https://www.youtube.com/watch?v=${i}`, formattedDuration: '3:00' }));
}

let nextId = 1000;

// discord.js gives a deleted message's edit or delete a DiscordAPIError with code 10008
function unknownMessage() {
    return Object.assign(new Error('Unknown Message'), { code: 10008 });
}

// A text channel with an ordered history, hooks let a test hold send, fetch or delete mid-flight
function modelChannel() {
    const history = [];
    const channel = {
        history,
        editLog: [],
        fetchCalls: [],
        hooks: {},
        messages: {
            fetch: async (opts) => {
                channel.fetchCalls.push(opts);
                if (channel.hooks.fetch) {
                    await channel.hooks.fetch(opts);
                }
                const at = history.findIndex((m) => m.id === opts.after);
                const after = history.slice(at + 1).filter((m) => !m.deleted).slice(0, opts.limit);
                return { size: after.length };
            }
        },
        send: async (payload) => {
            if (channel.hooks.send) {
                await channel.hooks.send(payload);
            }
            const message = {
                id: String(nextId++),
                channel,
                bot: true,
                text: JSON.stringify(payload),
                edits: 0,
                deleted: false
            };
            message.edit = async (p) => {
                if (message.deleted) {
                    throw unknownMessage();
                }
                message.text = JSON.stringify(p);
                message.edits += 1;
                channel.editLog.push({ id: message.id, paused: /Paused/.test(message.text) });
            };
            message.delete = async () => {
                if (channel.hooks.delete) {
                    await channel.hooks.delete(message);
                }
                if (message.deleted) {
                    throw unknownMessage();
                }
                message.deleted = true;
            };
            history.push(message);
            return message;
        },
        userPost(count = 1) {
            for (let i = 0; i < count; i++) {
                history.push({ id: String(nextId++), bot: false, deleted: false });
            }
        },
        livePanels: () => history.filter((m) => m.bot && !m.deleted)
    };
    return channel;
}

function modelQueue(id, channel, count = 3) {
    return { id, paused: false, volume: 50, songs: songs(count), textChannel: channel };
}

// What a Vol+ click does to the clicked panel, see components/music.js
function volumeClickOn(message, queue) {
    queue.volume += 10;
    const payload = { components: [musicEvents.buildNowPlayingPanel(queue)] };
    message.text = JSON.stringify(payload);
}

// ---- the stale payload, built before the isBuried round trip

test('hunt: a Vol+ click while the playSong refresh checks the panel position is not overwritten', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('stale1', channel);
    t.after(() => musicEvents.removePanel('stale1'));
    await musicEvents.refreshPanel(queue);
    const [panel] = channel.livePanels();

    const gate = deferred();
    channel.hooks.fetch = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    await delay(5);
    volumeClickOn(panel, queue); // the click's interaction.update lands while the fetch is out
    gate.resolve();
    await refresh;

    assert.strictEqual(queue.volume, 60);
    assert.match(channel.livePanels().at(-1).text, /Volume: \*\*60%\*\*/, 'panel shows the volume from before the click');
});

test('hunt: a Vol+ click on the old panel while it is being reposted shows on the new panel', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('stale2', channel);
    t.after(() => musicEvents.removePanel('stale2'));
    await musicEvents.refreshPanel(queue);
    const [oldPanel] = channel.livePanels();
    channel.userPost(3);

    const gate = deferred();
    channel.hooks.fetch = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    await delay(5);
    volumeClickOn(oldPanel, queue);
    gate.resolve();
    await refresh;

    const live = channel.livePanels();
    assert.strictEqual(live.length, 1);
    assert.notStrictEqual(live[0], oldPanel, 'buried panel should have been reposted');
    assert.match(live[0].text, /Volume: \*\*60%\*\*/, 'reposted panel shows the volume from before the click');
});

// ---- the chain

test('hunt: a step that throws does not stop later panel work for that guild', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('chain1', channel);
    t.after(() => musicEvents.removePanel('chain1'));
    queue.songs = [null]; // buildNowPlayingPanel throws on a null song
    // The panel is built inside the send's try since the click fix, so the throw is logged, not raised
    t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue).catch(() => {});
    queue.songs = songs(2);
    await musicEvents.refreshPanel(queue);
    assert.strictEqual(channel.livePanels().length, 1);
});

test('hunt: a rejected removePanel delete does not stop the next panel', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('chain2', channel);
    t.after(() => musicEvents.removePanel('chain2'));
    await musicEvents.refreshPanel(queue);
    channel.hooks.delete = async () => { throw new Error('Service Unavailable'); };
    await musicEvents.removePanel('chain2');
    channel.hooks.delete = null;
    await musicEvents.refreshPanel(queue);
    assert.strictEqual(channel.history.filter((m) => m.bot).length, 2, 'next refresh should post a fresh panel');
});

// discord.js REST gives up after 15 s per attempt and 3 retries, so a real hang lasts about a minute
test('hunt: a Discord call that never settles does not hold back the queue-ended cleanup', {
    todo: 'KNOWN RISK the chain has no step timeout, one hung send or fetch blocks every later panel step for the guild'
}, async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('chain3', channel);
    channel.hooks.send = () => new Promise(() => {});
    musicEvents.refreshPanel(queue).catch(() => {});
    let removed = false;
    musicEvents.removePanel('chain3').then(() => { removed = true; });
    await delay(300);
    assert.strictEqual(removed, true, 'removePanel is still waiting behind the hung send');
});

test('hunt: other guilds are not held up by one guild\'s slow panel work', async (t) => {
    const slow = modelChannel();
    const fast = modelChannel();
    slow.hooks.send = () => new Promise(() => {});
    musicEvents.refreshPanel(modelQueue('chain4slow', slow)).catch(() => {});
    t.after(() => musicEvents.removePanel('chain4fast'));
    await musicEvents.refreshPanel(modelQueue('chain4fast', fast));
    assert.strictEqual(fast.livePanels().length, 1);
});

// ---- repost and removal racing

test('hunt: removePanel while a repost is still sending leaves no panel behind', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('race1', channel);
    await musicEvents.refreshPanel(queue);
    channel.userPost(3);
    const gate = deferred();
    channel.hooks.send = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    const removed = musicEvents.removePanel('race1');
    queue.songs = [];
    await delay(5);
    gate.resolve();
    await Promise.all([refresh, removed]);
    assert.strictEqual(channel.livePanels().length, 0, 'an orphan panel was left after the queue ended');
});

test('hunt: removePanel while the old panel is being deleted after a repost leaves no panel', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('race2', channel);
    await musicEvents.refreshPanel(queue);
    channel.userPost(3);
    const gate = deferred();
    channel.hooks.delete = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    await delay(5);
    const removed = musicEvents.removePanel('race2');
    gate.resolve();
    await Promise.all([refresh, removed]);
    assert.strictEqual(channel.livePanels().length, 0);
});

test('hunt: two playSong refreshes back to back on a buried panel post one new panel', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('race3', channel);
    t.after(() => musicEvents.removePanel('race3'));
    await musicEvents.refreshPanel(queue);
    channel.userPost(5);
    await Promise.all([
        musicEvents.refreshPanel(queue, { repostIfBuried: true }),
        musicEvents.refreshPanel(queue, { repostIfBuried: true }),
        musicEvents.refreshPanel(queue)
    ]);
    assert.strictEqual(channel.livePanels().length, 1);
    assert.strictEqual(channel.history.filter((m) => m.bot).length, 2, 'the second refresh reposted a panel that was already at the bottom');
});

test('hunt: the position check asks for messages after the panel itself', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('fetch1', channel);
    t.after(() => musicEvents.removePanel('fetch1'));
    await musicEvents.refreshPanel(queue);
    const [panel] = channel.livePanels();
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.deepStrictEqual(channel.fetchCalls, [{ after: panel.id, limit: 3 }]);
});

test('hunt: messages deleted below the panel no longer count as burying it', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('fetch2', channel);
    t.after(() => musicEvents.removePanel('fetch2'));
    await musicEvents.refreshPanel(queue);
    channel.userPost(3);
    for (const m of channel.history.slice(1)) {
        m.deleted = true;
    }
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(channel.history.filter((m) => m.bot).length, 1);
});

// ---- the old panel gone or undeletable

test('hunt: a buried panel a user deleted is replaced quietly', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('gone1', channel);
    t.after(() => musicEvents.removePanel('gone1'));
    const errors = t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    channel.history[0].deleted = true;
    channel.userPost(4);
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(channel.livePanels().length, 1);
    assert.strictEqual(errors.mock.callCount(), 0);
});

test('hunt: an in-view panel a user deleted is replaced on the next song', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('gone2', channel);
    t.after(() => musicEvents.removePanel('gone2'));
    await musicEvents.refreshPanel(queue);
    channel.history[0].deleted = true;
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(channel.livePanels().length, 1);
    await musicEvents.refreshPanel(queue);
    assert.strictEqual(channel.livePanels()[0].edits, 1, 'the replacement should be tracked and edited');
});

test('hunt: an old panel that could not be deleted after a repost is logged', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('gone3', channel);
    t.after(() => musicEvents.removePanel('gone3'));
    const errors = t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    channel.userPost(3);
    channel.hooks.delete = async () => { throw new Error('Service Unavailable'); };
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    channel.hooks.delete = null;
    assert.strictEqual(channel.livePanels().length, 2, 'repro needs the old panel left behind');
    assert.ok(errors.mock.callCount() > 0, 'an orphan panel with live buttons was left and nothing was logged');
});

test('hunt: a failed repost keeps the old panel as the tracked one', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('gone4', channel);
    t.after(() => musicEvents.removePanel('gone4'));
    t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    channel.userPost(3);
    channel.hooks.send = async () => { throw new Error('Missing Permissions'); };
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    channel.hooks.send = null;
    assert.strictEqual(channel.livePanels().length, 1);
    await musicEvents.removePanel('gone4');
    assert.strictEqual(channel.livePanels().length, 0, 'old panel was forgotten and left behind');
});

// ---- events through register

test('hunt: finish, deleteQueue, then a new queue in the same guild ends with one panel in the new channel', async () => {
    const distube = new EventEmitter();
    const log = console.log;
    console.log = () => {};
    try {
        musicEvents.register({ distube });
    } finally {
        console.log = log;
    }
    const first = modelChannel();
    const second = modelChannel();
    const oldQueue = modelQueue('reuse1', first, 1);
    distube.emit('playSong', oldQueue);
    assert.ok(await until(() => first.livePanels().length === 1));
    first.userPost(3);
    oldQueue.songs = [];
    distube.emit('finish', oldQueue);
    distube.emit('deleteQueue', oldQueue);
    distube.emit('addSong', oldQueue); // a late event for the dead queue
    const newQueue = modelQueue('reuse1', second, 1);
    distube.emit('playSong', newQueue);
    await delay(50);
    assert.strictEqual(first.livePanels().length, 0, 'old queue panel left behind');
    assert.strictEqual(second.livePanels().length, 1);
    assert.strictEqual(second.fetchCalls.length, 0, 'new queue should post fresh, not check an old panel');
    await musicEvents.removePanel('reuse1');
});

// ---- the Up Next line

test('hunt: Up Next falls back to Unknown and counts the rest right', () => {
    const text = (list) => JSON.stringify(musicEvents.buildNowPlayingPanel({ paused: false, volume: 50, songs: list }));
    assert.match(text([...songs(1), { name: '', formattedDuration: '1:00' }]), /Up Next: \*\*Unknown\*\*"/);
    assert.match(text([...songs(1), { formattedDuration: '1:00' }]), /Up Next: \*\*Unknown\*\*"/);
    assert.match(text(songs(3)), /Up Next: \*\*Song 1\*\* · 1 more/);
    assert.doesNotMatch(text(songs(1)), /Up Next/);
});

test('hunt (pre-existing): long titles still give a panel Discord accepts', () => {
    const long = songs(2, (i) => `${i}`.repeat(2000));
    assert.doesNotThrow(() => musicEvents.buildNowPlayingPanel({ paused: false, volume: 50, songs: long }));
});

// ---- real DisTube Queue and voice player, see hunt-musicPlayback.test.js for the harness idea

const GUILD = '111111111111111111';
const VC = '222222222222222222';
const FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

const until = async (check, ms = 1500) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            return false;
        }
        await delay(10);
    }
    return true;
};

function fakeStream(id) {
    const input = new PassThrough({ objectMode: true });
    const stream = new EventEmitter();
    let timer = null;
    stream.id = id;
    stream.seekTime = 0;
    stream.audioResource = voiceLib.createAudioResource(input, { inputType: voiceLib.StreamType.Opus });
    stream.spawn = () => {
        timer = setInterval(() => {
            if (input.readableLength < 5 && !input.writableEnded) {
                input.write(FRAME);
            }
        }, 10);
        input.write(FRAME);
    };
    stream.end = () => {
        clearInterval(timer);
        if (!input.writableEnded) {
            input.end();
        }
    };
    stream.kill = () => {
        clearInterval(timer);
        input.destroy();
    };
    stream.setVolume = () => {};
    return stream;
}

function harness(t, textChannel, { lookupMs = 0 } = {}) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const distube = new DisTube(client, {
        emitNewSongOnly: true,
        emitAddSongWhenCreatingQueue: false,
        emitAddListWhenCreatingQueue: false,
        plugins: [new YtDlpPlugin()]
    });
    const errors = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    musicEvents.register({ distube });

    const streams = [];
    const played = [];
    let closed = false;
    distube.queues.playSong = async (queue, emitPlaySong = true) => {
        if (closed) {
            return;
        }
        if (queue.stopped || !queue.songs.length) {
            await queue.stop();
            return;
        }
        const song = queue.songs[0];
        if (lookupMs) {
            await delay(lookupMs);
        }
        const stream = fakeStream(song.id);
        streams.push(stream);
        await queue.voice.play(stream);
        played.push(song.id);
        if (emitPlaySong) {
            distube.emit('playSong', queue, song);
        }
    };

    const plugin = distube.plugins[0];
    const channel = {
        id: VC,
        guildId: GUILD,
        type: ChannelType.GuildVoice,
        client,
        joinable: true,
        full: false,
        toString: () => `<#${VC}>`,
        guild: {
            id: GUILD,
            name: 'Guild',
            voiceAdapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
            members: { me: { voice: { channel: { id: VC } } } }
        }
    };

    async function newQueue(ids) {
        const voice = distube.voices.create(channel);
        voice.audioPlayer.behaviors.noSubscriber = voiceLib.NoSubscriberBehavior.Play;
        voice.join = async () => voice;
        const queue = await distube.queues.create(channel, textChannel);
        queue.songs.push(...ids.map((id) => buildSong(plugin, { id, title: `Song ${id}`, webpage_url: `https://www.youtube.com/watch?v=${id}`, duration: 180 }, {})));
        return queue;
    }

    const status = () => {
        const voice = distube.voices.get(GUILD);
        return voice ? voice.audioPlayer.state.status : 'none';
    };

    // The click edits the message it was made on, like interaction.update and editReply do
    function click(action, message) {
        const interaction = {
            customId: `music:${action}`,
            guildId: GUILD,
            member: { voice: { channel: { id: VC } } },
            message,
            replied: false,
            deferred: false,
            update: async (payload) => { interaction.replied = true; await message.edit(payload); },
            deferUpdate: async () => { interaction.deferred = true; },
            reply: async () => { interaction.replied = true; },
            editReply: async (payload) => { await message.edit(payload); }
        };
        return musicButtons.execute(interaction, { distube });
    }

    t.after(async () => {
        closed = true;
        const queue = distube.getQueue(GUILD);
        if (queue) {
            queue.remove();
        }
        for (const stream of streams) {
            stream.kill();
        }
        const voice = distube.voices.get(GUILD);
        if (voice) {
            voice.leave();
        }
        const connection = voiceLib.getVoiceConnection(GUILD);
        if (connection && connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
            connection.destroy();
        }
        await musicEvents.removePanel(GUILD);
        client.destroy();
    });

    return { distube, newQueue, streams, played, status, click, errors };
}

// Pause waits on DisTube's task queue, which the song change holds until playSong has fired,
// so the click's editReply lands while the playSong refresh is still out checking the position
for (const buried of [false, true]) {
    test(`hunt: Pause clicked while the next song loads leaves the panel saying Paused (${buried ? 'buried, reposted' : 'in view, edited'})`, async (t) => {
        const textChannel = modelChannel();
        const h = harness(t, textChannel, { lookupMs: 200 });
        const queue = await h.newQueue(['a', 'b']);
        await h.distube.queues.playSong(queue);
        assert.ok(await until(() => textChannel.livePanels().length === 1), 'first panel never posted');
        assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing));
        if (buried) {
            textChannel.userPost(3);
        }
        textChannel.hooks.fetch = () => delay(80); // one Discord round trip

        h.streams[0].end();
        assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Idle), 'song a did not end');
        await h.click('playpause', textChannel.livePanels()[0]);
        assert.ok(await until(() => h.played.includes('b')));
        await delay(250);

        assert.strictEqual(queue.paused, true);
        assert.ok(textChannel.editLog.some((e) => e.paused), 'repro needs the click to have drawn Paused first');
        const live = textChannel.livePanels();
        assert.strictEqual(live.length, 1);
        assert.match(live[0].text, /Song b/);
        assert.match(live[0].text, /Paused/, 'song b is paused but the panel says Now Playing with a Pause button');
    });
}

test('hunt: Vol+ on the panel after a song change reaches the panel that is shown', async (t) => {
    const textChannel = modelChannel();
    const h = harness(t, textChannel);
    const queue = await h.newQueue(['a', 'b']);
    await h.distube.queues.playSong(queue);
    assert.ok(await until(() => textChannel.livePanels().length === 1));
    textChannel.userPost(3);
    await h.click('skip', textChannel.livePanels()[0]);
    assert.ok(await until(() => h.played.includes('b')));
    assert.ok(await until(() => textChannel.history.filter((m) => m.bot).length === 2 && textChannel.livePanels().length === 1), 'buried panel was not reposted on skip');
    await h.click('volup', textChannel.livePanels()[0]);
    assert.match(textChannel.livePanels()[0].text, new RegExp(`Volume: \\*\\*${queue.volume}%\\*\\*`));
    const controlErrors = h.errors.mock.calls.filter((c) => /Music control/.test(String(c.arguments[0])));
    assert.strictEqual(controlErrors.length, 0);
});

// ---- re-check after the payload-after-fetch, syncPanelAfterClick, delete logging and shortName fixes

// A volume click through components/music.js on a fake queue, the click edits the message it was made on
function volumeClick(queue, message, action = 'volup') {
    const interaction = {
        customId: `music:${action}`,
        guildId: queue.id,
        member: { voice: { channel: { id: 'vc' } } },
        message,
        replied: false,
        deferred: false,
        update: async (payload) => { interaction.replied = true; await message.edit(payload); },
        reply: async () => { interaction.replied = true; }
    };
    return musicButtons.execute(interaction, { distube: { getQueue: () => queue } });
}

function clickableQueue(id, channel) {
    const queue = modelQueue(id, channel);
    queue.voiceChannel = { id: 'vc' };
    queue.setVolume = (v) => { queue.volume = v; };
    return queue;
}

test('hunt: a click on the tracked panel with no panel work queues no extra edit', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync1', channel);
    t.after(() => musicEvents.removePanel('sync1'));
    await musicEvents.refreshPanel(queue);
    await delay(5); // the chain entry is cleared a few microtasks after the step, a real click comes later
    const [panel] = channel.livePanels();
    await volumeClick(queue, panel);
    await delay(20);
    assert.strictEqual(panel.edits, 1, 'only the click itself should edit the panel');
    assert.strictEqual(channel.history.filter((m) => m.bot).length, 1);
});

// After a restart the map is empty and the old panel's buttons still work
test('hunt: a click on a panel the bot no longer tracks posts no new panel', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync2', channel);
    t.after(() => musicEvents.removePanel('sync2'));
    const leftover = await channel.send({ components: [] });
    await volumeClick(queue, leftover);
    await delay(20);
    assert.strictEqual(channel.history.filter((m) => m.bot).length, 1, 'a click posted a second panel');
    assert.match(leftover.text, /Volume: \*\*60%\*\*/);
});

test('hunt: a click while the queue-ended cleanup runs posts nothing afterwards', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync3', channel);
    await musicEvents.refreshPanel(queue);
    const [panel] = channel.livePanels();
    const gate = deferred();
    channel.hooks.delete = () => gate.promise;
    const removed = musicEvents.removePanel('sync3');
    // the click was already past its queue check when the queue ended
    musicEvents.syncPanelAfterClick(queue, panel);
    queue.songs = [];
    gate.resolve();
    await removed;
    await delay(20);
    assert.strictEqual(channel.livePanels().length, 0, 'a refresh after the queue ended put a panel back');
});

test('hunt: a Vol+ click on the old panel while the repost is still sending shows on the new panel', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync4', channel);
    t.after(() => musicEvents.removePanel('sync4'));
    await musicEvents.refreshPanel(queue);
    const [oldPanel] = channel.livePanels();
    channel.userPost(3);
    const gate = deferred();
    channel.hooks.send = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    await delay(5); // payload is built, the send is out
    await volumeClick(queue, oldPanel);
    channel.hooks.send = null;
    gate.resolve();
    await refresh;
    await delay(20);
    const live = channel.livePanels();
    assert.strictEqual(live.length, 1);
    assert.notStrictEqual(live[0], oldPanel);
    assert.match(live[0].text, /Volume: \*\*60%\*\*/, 'new panel kept the volume from before the click');
});

test('hunt: a click on an orphan panel brings the tracked panel up to date', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync5', channel);
    t.after(() => musicEvents.removePanel('sync5'));
    t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    const [orphan] = channel.livePanels();
    channel.userPost(3);
    channel.hooks.delete = async () => { throw new Error('Service Unavailable'); };
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    channel.hooks.delete = null;
    const tracked = channel.livePanels().at(-1);
    await volumeClick(queue, orphan);
    await delay(20);
    assert.match(tracked.text, /Volume: \*\*60%\*\*/);
});

// Each click during panel work queues one more refresh, so a burst of clicks is a burst of edits
test('hunt: ten Vol+ clicks during one slow position check stay within Discord\'s edit rate', async (t) => {
    const channel = modelChannel();
    const queue = clickableQueue('sync6', channel);
    t.after(() => musicEvents.removePanel('sync6'));
    await musicEvents.refreshPanel(queue);
    const [panel] = channel.livePanels();
    const gate = deferred();
    channel.hooks.fetch = () => gate.promise;
    const refresh = musicEvents.refreshPanel(queue, { repostIfBuried: true });
    await delay(5);
    for (let i = 0; i < 10; i++) {
        await volumeClick(queue, panel, i % 2 ? 'voldown' : 'volup');
    }
    gate.resolve();
    await refresh;
    await delay(50);
    const chainEdits = panel.edits - 10 - 1; // minus the clicks and the playSong refresh
    assert.ok(chainEdits <= 1, `${chainEdits} extra edits queued by clicks`);
});

// A build error inside the edit's try was taken for a deleted panel, then the send threw too
test('hunt: a panel that cannot be built for a song does not drop the shown panel from tracking', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('build1', channel);
    t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    queue.songs = [{ name: 'Long link', url: `https://example.com/${'a'.repeat(4000)}`, formattedDuration: '3:00' }];
    await musicEvents.refreshPanel(queue).catch(() => {});
    queue.songs = [];
    await musicEvents.removePanel('build1');
    assert.strictEqual(channel.livePanels().length, 0, 'the queue ended and its panel stayed up with live buttons');
});

// "a step that throws" no longer rejects since the build moved into the send's try, this keeps a step that rejects covered
test('hunt: a step that rejects outright does not stop later panel work for that guild', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('chain5', channel);
    t.after(() => musicEvents.removePanel('chain5'));
    let broken = true;
    const list = songs(2);
    Object.defineProperty(queue, 'songs', {
        get() {
            if (broken) {
                throw new Error('queue torn down');
            }
            return list;
        }
    });
    await assert.rejects(musicEvents.refreshPanel(queue), /queue torn down/);
    broken = false;
    await musicEvents.refreshPanel(queue);
    assert.strictEqual(channel.livePanels().length, 1);
});

test('hunt: a queue-ended panel that could not be deleted is logged', async (t) => {
    const channel = modelChannel();
    const queue = modelQueue('gone5', channel);
    const errors = t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    channel.hooks.delete = async () => { throw new Error('Service Unavailable'); };
    await musicEvents.removePanel('gone5');
    assert.strictEqual(channel.livePanels().length, 1, 'repro needs the panel left behind');
    assert.ok(errors.mock.callCount() > 0, 'a panel for an ended queue stayed up and nothing was logged');
});

test('hunt: long titles, uploader and Up Next together stay under the limit and keep the ellipsis', () => {
    const long = 'x'.repeat(5000);
    const queue = { paused: false, volume: 50, songs: [{ name: long, url: 'https://www.youtube.com/watch?v=a', formattedDuration: '3:00', uploader: { name: long } }, { name: long }] };
    const text = JSON.stringify(musicEvents.buildNowPlayingPanel(queue));
    assert.ok(text.includes(`${'x'.repeat(199)}…`));
    assert.ok(!text.includes('x'.repeat(200)));
    assert.match(JSON.stringify(musicEvents.buildNowPlayingPanel({ ...queue, songs: [{ name: 'a'.repeat(200), formattedDuration: '1:00' }] })), new RegExp(`\\*\\*a{200}\\*\\*`), 'a name of exactly 200 should stay whole');
});

test('hunt: an emoji on the cut is not split into half a character', () => {
    const name = `${'x'.repeat(198)}🎵🎵🎵`;
    const json = JSON.stringify(musicEvents.buildNowPlayingPanel({ paused: false, volume: 50, songs: [{ name, formattedDuration: '1:00' }] }));
    assert.doesNotMatch(json, /\\ud83c(?!\\udf)/i, 'lone high surrogate in the panel text');
});
