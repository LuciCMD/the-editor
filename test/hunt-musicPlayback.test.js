// Drives the real DisTube Queue, DisTubeVoice and @discordjs/voice AudioPlayer with fake audio streams
// Only the stream lookup and ffmpeg are replaced, so pause, skip and stop take DisTube's own paths

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

const GUILD = '111111111111111111';
const VC = '222222222222222222';
const BOT = '333333333333333333';
const OWNER = '444444444444444444';
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

// Stands in for DisTubeStream, feeds opus frames at about real time until ended or killed
function fakeStream(id, { feedOnSpawn = true } = {}) {
    const input = new PassThrough({ objectMode: true });
    const stream = new EventEmitter();
    let timer = null;
    stream.id = id;
    stream.spawned = false;
    stream.seekTime = 0;
    stream.audioResource = voiceLib.createAudioResource(input, { inputType: voiceLib.StreamType.Opus });
    stream.feed = () => {
        if (timer || input.destroyed) {
            return;
        }
        timer = setInterval(() => {
            if (input.readableLength < 5 && !input.writableEnded) {
                input.write(FRAME);
            }
        }, 10);
        input.write(FRAME);
    };
    stream.spawn = () => {
        stream.spawned = true;
        if (feedOnSpawn) {
            stream.feed();
        }
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

function fakeTextChannel() {
    return {
        send: async () => ({ edit: async () => {}, delete: async () => {} })
    };
}

function harness(t, { lookupMs = 0, feedOnSpawn = true, botUser = null, register = true } = {}) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    if (botUser) {
        client.user = botUser;
    }
    const distube = new DisTube(client, {
        emitNewSongOnly: true,
        emitAddSongWhenCreatingQueue: false,
        emitAddListWhenCreatingQueue: false,
        plugins: [new YtDlpPlugin()]
    });
    distube.setMaxListeners(50);
    const errors = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    if (register) {
        musicEvents.register({ distube });
    }

    const streams = [];
    const played = [];
    // DisTube's playSong without the yt-dlp lookup and ffmpeg, lookupMs stands for getStreamURL
    let closed = false;
    distube.queues.playSong = async (queue, emitPlaySong = true) => {
        // Teardown forces the player idle, a stuck skip would then start a song nobody stops
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
        const stream = fakeStream(song.id, { feedOnSpawn });
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
            ownerId: OWNER,
            name: 'Guild',
            voiceAdapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
            members: { me: { voice: { channel: { id: VC } } } }
        }
    };

    async function newQueue(ids) {
        const voice = distube.voices.create(channel);
        // No Discord connection is ever Ready here, so the player must not autopause
        voice.audioPlayer.behaviors.noSubscriber = voiceLib.NoSubscriberBehavior.Play;
        voice.join = async () => voice;
        const queue = await distube.queues.create(channel, fakeTextChannel());
        queue.songs.push(...ids.map((id) => buildSong(plugin, { id, title: `Song ${id}`, webpage_url: `https://www.youtube.com/watch?v=${id}`, duration: 180 }, {})));
        return queue;
    }

    const player = () => distube.voices.get(GUILD) && distube.voices.get(GUILD).audioPlayer;
    const status = () => (player() ? player().state.status : 'none');
    const current = () => {
        const p = player();
        const stream = p && p.state.resource && streams.find((s) => s.audioResource === p.state.resource);
        return stream ? stream.id : null;
    };

    function click(action) {
        const calls = [];
        const started = Date.now();
        const interaction = {
            customId: `music:${action}`,
            guildId: GUILD,
            member: { voice: { channel: { id: VC } } },
            replied: false,
            deferred: false,
            update: async (payload) => { interaction.replied = true; calls.push({ type: 'update', ms: Date.now() - started, text: JSON.stringify(payload) }); },
            deferUpdate: async () => { interaction.deferred = true; calls.push({ type: 'deferUpdate', ms: Date.now() - started }); },
            reply: async (payload) => { interaction.replied = true; calls.push({ type: 'reply', ms: Date.now() - started, text: JSON.stringify(payload) }); },
            editReply: async (payload) => { calls.push({ type: 'editReply', ms: Date.now() - started, text: JSON.stringify(payload) }); }
        };
        return { done: musicButtons.execute(interaction, { distube }), calls };
    }

    t.after(() => {
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
        for (const group of [undefined, BOT]) {
            const connection = voiceLib.getVoiceConnection(GUILD, group);
            if (connection && connection.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
        }
        client.destroy();
    });

    return { distube, client, channel, newQueue, streams, played, player, status, current, click, errors };
}

// Playing, with the queue's paused flag telling the truth
async function startPlaying(h, ids) {
    const queue = await h.newQueue(ids);
    await h.distube.queues.playSong(queue);
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing), `player never started, status ${h.status()}`);
    return queue;
}

test('hunt: stop while paused, then a new queue in the same voice connection plays right away', async (t) => {
    const h = harness(t);
    const first = await startPlaying(h, ['a']);
    await h.click('playpause').done;
    assert.strictEqual(first.paused, true);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Paused);

    const stop = h.click('stop');
    await stop.done;
    assert.ok(await until(() => !h.distube.getQueue(GUILD)), 'queue was not removed');
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Idle, 'player left paused after Stop');

    const second = await h.newQueue(['b']);
    assert.strictEqual(second.voice, first.voice, 'harness should reuse the DisTubeVoice like the bot does');
    await h.distube.queues.playSong(second);
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing && h.current() === 'b'),
        `new song did not start, status ${h.status()}, current ${h.current()}`);
    assert.strictEqual(second.paused, false);
    assert.strictEqual(h.streams[1].spawned, true, 'new stream was parked as pausingStream instead of starting');
});

// Proves the harness reproduces the reported bug, so the test above means something
test('hunt: without the deleteQueue reset the next song is parked behind the paused player', async (t) => {
    const h = harness(t, { register: false });
    const first = await startPlaying(h, ['a']);
    await first.pause();
    await first.stop();
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Paused, 'DisTube or the voice library changed, repro no longer holds');
    const second = await h.newQueue(['b']);
    await h.distube.queues.playSong(second);
    await delay(100);
    assert.strictEqual(h.streams[1].spawned, false);
    assert.strictEqual(second.paused, false, 'panel would say Now Playing over silence');
});

test('hunt: /stop command while paused, then /play, starts the new song', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a', 'b']);
    await h.click('playpause').done;
    const stopCommand = require('../commands/music/stop');
    await stopCommand.execute({ guild: { id: GUILD, ownerId: OWNER, name: 'Guild' }, reply: async () => {} }, { distube: h.distube });
    assert.ok(await until(() => !h.distube.getQueue(GUILD)));
    const next = await h.newQueue(['c']);
    await h.distube.queues.playSong(next);
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing && h.current() === 'c'));
});

test('hunt: Skip on the panel with one song while paused stops cleanly and the next /play is not paused', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a']);
    await h.click('playpause').done;
    await h.click('skip').done;
    assert.ok(await until(() => !h.distube.getQueue(GUILD)));
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Idle);
    const next = await h.newQueue(['b']);
    await h.distube.queues.playSong(next);
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing && h.current() === 'b'));
});

test('hunt: alternating Pause and Resume clicks keep the panel, the flag and the player in step', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a']);
    for (let i = 0; i < 6; i++) {
        const click = h.click('playpause');
        await click.done;
        const shouldBePaused = i % 2 === 0;
        assert.strictEqual(queue.paused, shouldBePaused, `click ${i + 1} flag`);
        assert.strictEqual(h.status() === voiceLib.AudioPlayerStatus.Paused, shouldBePaused, `click ${i + 1} player ${h.status()}`);
        assert.match(click.calls.at(-1).text, shouldBePaused ? /Paused/ : /Now Playing/);
    }
});

test('hunt: five Pause clicks at once end with the flag and the player agreeing, no error replies', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a']);
    const clicks = Array.from({ length: 5 }, () => h.click('playpause'));
    await Promise.all(clicks.map((c) => c.done));
    assert.strictEqual(queue.paused, h.status() === voiceLib.AudioPlayerStatus.Paused);
    for (const c of clicks) {
        assert.strictEqual(c.calls[0].type, 'deferUpdate');
        assert.ok(!c.calls.some((call) => call.type === 'reply'), 'a click got an error reply');
    }
    assert.strictEqual(h.errors.mock.callCount(), 0);
});

// DisTube's skip calls a non-forced stop, a paused player keeps its state so the song never ends
test('hunt: Skip while paused moves on to the next song', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a', 'b']);
    await h.click('playpause').done;
    const skip = h.click('skip');
    await skip.done;
    assert.deepStrictEqual(queue.songs.map((s) => s.id), ['b'], 'DisTube already moved songs[0] to b');
    const moved = await until(() => h.played.includes('b'), 1000);
    assert.ok(moved, `next song never loaded, player ${h.status()} still on ${h.current()}, panel not refreshed`);
});

test('hunt: Pause clicked right after Skip still moves on to the next song', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a', 'b']);
    const skip = h.click('skip');
    const pause = h.click('playpause');
    await Promise.all([skip.done, pause.done]);
    const moved = await until(() => h.played.includes('b'), 1000);
    assert.ok(moved, `next song never loaded, player ${h.status()} still on ${h.current()}`);
});

// Between songs the player is idle while yt-dlp looks up the next track, then buffering until ffmpeg
// sends audio, AudioPlayer.pause only works while playing, but Queue.pause sets paused anyway
test('hunt: Pause while the next song is being looked up leaves the flag and the player agreeing', async (t) => {
    const h = harness(t, { lookupMs: 300 });
    const queue = await startPlaying(h, ['a', 'b']);
    h.streams[0].end();
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Idle), 'song a did not end');
    const click = h.click('playpause');
    await click.done;
    assert.ok(await until(() => h.played.includes('b')));
    await delay(150);
    assert.match(click.calls.at(-1).text, /Paused/, 'panel after the click');
    assert.strictEqual(queue.paused, true);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Paused, `panel says Paused but song b is ${h.status()}`);
});

test('hunt: Pause while a song is still buffering pauses it', async (t) => {
    const h = harness(t, { feedOnSpawn: false });
    const queue = await h.newQueue(['a']);
    await h.distube.queues.playSong(queue);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Buffering);
    await h.click('playpause').done;
    assert.strictEqual(queue.paused, true);
    h.streams[0].feed(); // ffmpeg's first audio arrives
    await delay(150);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Paused, `panel says Paused but the song is ${h.status()}`);
});

// Discord drops a component interaction that isn't answered within 3 s
test('hunt: a Pause click between songs is answered before the next track lookup finishes', async (t) => {
    const h = harness(t, { lookupMs: 1200 });
    await startPlaying(h, ['a', 'b']);
    h.streams[0].end();
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Idle), 'song a did not end');
    const click = h.click('playpause');
    await click.done;
    assert.ok(click.calls.length > 0);
    assert.ok(click.calls[0].ms < 500, `first answer to Discord came after ${click.calls[0].ms} ms, the lookup took 1200 ms`);
});

test('hunt: Pause clicked while someone runs /stop gives no error reply', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a', 'b']);
    const stopCommand = require('../commands/music/stop');
    await stopCommand.execute({ guild: { id: GUILD, ownerId: OWNER, name: 'Guild' }, reply: async () => {} }, { distube: h.distube });
    const click = h.click('playpause');
    await click.done;
    // "Nothing is playing" is the right answer for a stale panel, the bug was "That control failed"
    const replies = click.calls.filter((c) => c.type === 'reply' && /control failed/.test(c.text));
    assert.strictEqual(replies.length, 0, `got ${replies.map((r) => r.text).join(' ')}`);
});

test('hunt: deleteQueue after /leave tore the voice down does not throw or log', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a']);
    const voice = queue.voice;
    voice.leave();
    assert.ok(await until(() => !h.distube.getQueue(GUILD)));
    queue.remove(); // a late stop from /leave
    await delay(20);
    const releaseErrors = h.errors.mock.calls.filter((c) => /reset the music player/.test(String(c.arguments[0])));
    assert.strictEqual(releaseErrors.length, 0);
});

// DisTube joins under the bot's user id as the voice group, /join and /leave use the default group
test('hunt (pre-existing): /leave finds and leaves the connection DisTube made', {
    todo: 'KNOWN /leave looks in the default voice group, DisTube joined under the bot id, so the bot stays in voice'
}, async (t) => {
    const h = harness(t, { botUser: { id: BOT } });
    await startPlaying(h, ['a']);
    assert.ok(voiceLib.getVoiceConnection(GUILD, BOT), 'harness should join under the bot id like the bot');
    const leave = require('../commands/music/leave');
    let body = '';
    await leave.execute({
        guildId: GUILD,
        guild: { id: GUILD, ownerId: OWNER, name: 'Guild' },
        reply: async (payload) => { body = JSON.stringify(payload); }
    }, { distube: h.distube });
    await delay(50);
    const connection = voiceLib.getVoiceConnection(GUILD, BOT);
    assert.ok(!connection || connection.state.status === voiceLib.VoiceConnectionStatus.Destroyed,
        `reply said ${/Left the voice channel/.test(body) ? '"Left the voice channel"' : body} but the bot is still connected`);
});

test('hunt (pre-existing): /play works after /join', {
    todo: 'KNOWN /join makes a default-group connection, DisTube then refuses with VOICE_ALREADY_CREATED'
}, async (t) => {
    const h = harness(t, { botUser: { id: BOT } });
    const join = require('../commands/music/join');
    await join.execute({
        guildId: GUILD,
        guild: h.channel.guild,
        member: { voice: { channel: h.channel } },
        reply: async () => {}
    });
    assert.ok(voiceLib.getVoiceConnection(GUILD), '/join should have connected');
    assert.doesNotThrow(() => h.distube.voices.create(h.channel));
});

// ---- re-check after the holdPause, deferred playpause and skipSong fixes

// The click is already past the getQueue check when the stop lands, so the stopped-meanwhile branch runs
test('hunt: a Pause click still in flight when /stop lands ends quietly', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a', 'b']);
    const click = h.click('playpause');
    queue.stop();
    await click.done;
    assert.ok(await until(() => !h.distube.getQueue(GUILD)));
    assert.deepStrictEqual(click.calls.map((c) => c.type), ['deferUpdate'], 'nothing should be drawn over a stopped queue');
    const controlErrors = h.errors.mock.calls.filter((c) => /Music control/.test(String(c.arguments[0])));
    assert.strictEqual(controlErrors.length, 0, controlErrors.map((c) => c.arguments.join(' ')).join('\n'));
});

test('hunt: Pause then Resume while a song buffers lets it play once audio arrives', async (t) => {
    const h = harness(t, { feedOnSpawn: false });
    const queue = await h.newQueue(['a']);
    await h.distube.queues.playSong(queue);
    await h.click('playpause').done;
    await h.click('playpause').done;
    assert.strictEqual(queue.paused, false);
    h.streams[0].feed();
    assert.ok(await until(() => h.status() === voiceLib.AudioPlayerStatus.Playing), `status ${h.status()}`);
    await delay(100);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Playing);
});

// holdPause hooks the player once, a reused DisTubeVoice must not pile up listeners
test('hunt: several stop and play cycles on one voice keep a single pause hold', async (t) => {
    const h = harness(t);
    for (const id of ['a', 'b', 'c']) {
        const queue = await startPlaying(h, [id]);
        await queue.stop();
    }
    const player = h.distube.voices.get(GUILD).audioPlayer;
    assert.ok(player.listenerCount('stateChange') <= 1, `${player.listenerCount('stateChange')} stateChange listeners`);
});

// After /leave or a dropped connection DisTube builds a new DisTubeVoice with a new AudioPlayer
test('hunt: the pause hold works on the new player after the voice was rebuilt', async (t) => {
    const h = harness(t, { feedOnSpawn: false });
    const first = await h.newQueue(['a']);
    const oldPlayer = first.voice.audioPlayer;
    first.voice.leave();
    assert.ok(await until(() => !h.distube.getQueue(GUILD)));
    const second = await h.newQueue(['b']);
    assert.notStrictEqual(second.voice.audioPlayer, oldPlayer, 'harness should build a new player');
    await h.distube.queues.playSong(second);
    await h.click('playpause').done;
    h.streams.at(-1).feed();
    await delay(150);
    assert.strictEqual(second.paused, true);
    assert.strictEqual(h.status(), voiceLib.AudioPlayerStatus.Paused, `song b is ${h.status()}`);
});

test('hunt: two Skip clicks at once while paused skip twice without an error', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a', 'b', 'c']);
    await h.click('playpause').done;
    const first = h.click('skip');
    const second = h.click('skip');
    await Promise.all([first.done, second.done]);
    const controlErrors = h.errors.mock.calls.filter((c) => /Music control/.test(String(c.arguments[0])));
    assert.strictEqual(controlErrors.length, 0, controlErrors.map((c) => c.arguments.join(' ')).join('\n'));
    assert.ok(await until(() => h.played.includes('c')), `played ${h.played.join(',')}`);
});

test('hunt: panel Skip and /skip at once while paused both go through', async (t) => {
    const h = harness(t);
    await startPlaying(h, ['a', 'b', 'c']);
    await h.click('playpause').done;
    const skipCommand = require('../commands/music/skip');
    let body = '';
    const panel = h.click('skip');
    const command = skipCommand.execute({ guild: { id: GUILD, ownerId: OWNER, name: 'Guild' }, reply: async (p) => { body = JSON.stringify(p); } }, { distube: h.distube });
    await Promise.all([panel.done, command]);
    assert.doesNotMatch(body, /error occurred/, '/skip reported an error');
    assert.ok(await until(() => h.played.includes('c')), `played ${h.played.join(',')}`);
});

test('hunt: Skip while playing plays the next song unpaused and the panel follows', async (t) => {
    const h = harness(t);
    const queue = await startPlaying(h, ['a', 'b']);
    await h.click('skip').done;
    assert.ok(await until(() => h.current() === 'b' && h.status() === voiceLib.AudioPlayerStatus.Playing), `status ${h.status()} on ${h.current()}`);
    assert.strictEqual(queue.paused, false);
});
