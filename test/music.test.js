const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const voice = require('@discordjs/voice');
const { DisTubeError } = require('distube');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const musicEvents = require('../passives/musicEvents');
const musicButtons = require('../components/music');

test.after(() => removeDir(dir));

const VOICE_CHANNEL = { id: 'vc1' };

// Like DisTube 5, paused only changes after the task queue lets the call through
function fakeQueue({ paused = false } = {}) {
    const later = () => new Promise((resolve) => setImmediate(resolve));
    return {
        id: 'guild1',
        paused,
        volume: 50,
        voiceChannel: VOICE_CHANNEL,
        songs: [{ name: 'Song', url: 'https://www.youtube.com/watch?v=a', formattedDuration: '3:00' }],
        async pause() {
            await later();
            if (this.paused) {
                throw new DisTubeError('PAUSED');
            }
            this.paused = true;
        },
        async resume() {
            await later();
            if (!this.paused) {
                throw new DisTubeError('RESUMED');
            }
            this.paused = false;
        }
    };
}

function clickPlayPause(queue) {
    const updates = [];
    const interaction = {
        customId: 'music:playpause',
        guildId: queue.id,
        member: { voice: { channel: VOICE_CHANNEL } },
        deferred: false,
        deferUpdate: async () => { interaction.deferred = true; },
        editReply: async (payload) => { updates.push(JSON.stringify(payload)); },
        reply: async (payload) => { updates.push(`reply ${JSON.stringify(payload)}`); }
    };
    const client = { distube: { getQueue: () => queue } };
    return { done: musicButtons.execute(interaction, client), updates };
}

test('Pause shows the panel as paused right away', async () => {
    const queue = fakeQueue();
    const { done, updates } = clickPlayPause(queue);
    await done;
    assert.strictEqual(queue.paused, true);
    assert.match(updates[0], /Paused/, 'panel still showed Now Playing after pausing');
    assert.match(updates[0], /Resume/);
});

test('Resume shows the panel as playing right away', async () => {
    const queue = fakeQueue({ paused: true });
    const { done, updates } = clickPlayPause(queue);
    await done;
    assert.strictEqual(queue.paused, false);
    assert.match(updates[0], /Now Playing/, 'panel still showed Paused after resuming');
});

// Two quick clicks both read "playing", the second pause throws PAUSED inside DisTube
test('two quick Pause clicks leave it paused with no error', async (t) => {
    const queue = fakeQueue();
    const errors = t.mock.method(console, 'error', () => {});
    const first = clickPlayPause(queue);
    const second = clickPlayPause(queue);
    await Promise.all([first.done, second.done]);
    assert.strictEqual(queue.paused, true);
    assert.match(second.updates[0], /Paused/);
    assert.doesNotMatch(second.updates[0], /^reply/, 'second click got an error reply');
    assert.strictEqual(errors.mock.callCount(), 0);
});

// Seen on the test bot, stop while paused and the next /play stayed silent until Resume was pressed
test('stopping a paused queue leaves the player ready for the next song', async (t) => {
    const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } });
    const input = new PassThrough();
    // A player left paused keeps the process alive, so a failure would hang the suite
    t.after(() => {
        player.stop(true);
        input.destroy();
    });
    player.play(voice.createAudioResource(input, { inputType: voice.StreamType.Opus }));
    input.write(Buffer.from([0xf8, 0xff, 0xfe]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(player.state.status, voice.AudioPlayerStatus.Playing);

    player.pause();
    player.stop();
    assert.strictEqual(player.state.status, voice.AudioPlayerStatus.Paused, 'voice library changed, repro no longer holds');

    const distube = new EventEmitter();
    musicEvents.register({ distube });
    distube.emit('deleteQueue', { id: 'guild2', voice: { stop: (force) => player.stop(force) } });
    assert.strictEqual(player.state.status, voice.AudioPlayerStatus.Idle, 'player stayed paused after the queue was stopped');
});

function songs(count) {
    return Array.from({ length: count }, (_, i) => ({ name: `Song ${i}`, url: `https://www.youtube.com/watch?v=${i}`, formattedDuration: '3:00' }));
}

// Seen on the test bot, Up Next grew with the queue and pushed the panel around
test('the panel stays the same size however long the queue is', () => {
    const text = (count) => JSON.stringify(musicEvents.buildNowPlayingPanel({ paused: false, volume: 50, songs: songs(count) }));
    const short = text(2);
    const long = text(50);
    assert.match(long, /Up Next: \*\*Song 1\*\* · 48 more/);
    assert.doesNotMatch(long, /Song 2\b/, 'more than one upcoming song is listed');
    assert.strictEqual(long.split('\\n').length, short.split('\\n').length, 'panel grew with the queue');
    assert.doesNotMatch(short, /more/, 'one song up next needs no count');
});

// A panel message whose channel reports `below` messages after it
function fakeChannel(guildId, below = () => 0) {
    const sent = [];
    const channel = {
        messages: { fetch: async () => ({ size: below() }) },
        send: async () => {
            const message = { id: `m${sent.length}`, channel, edits: 0, deleted: false };
            message.edit = async () => { message.edits += 1; };
            message.delete = async () => { message.deleted = true; };
            sent.push(message);
            return message;
        }
    };
    const queue = { id: guildId, paused: false, volume: 50, songs: songs(3), textChannel: channel };
    return { queue, sent, channel };
}

test('a panel that has scrolled away is posted again at the bottom when a song starts', async (t) => {
    let below = 0;
    const { queue, sent } = fakeChannel('repost1', () => below);
    t.after(() => musicEvents.removePanel('repost1'));
    await musicEvents.refreshPanel(queue);
    below = 3;
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(sent.length, 2, 'buried panel was edited where nobody can see it');
    assert.strictEqual(sent[0].deleted, true, 'old panel was left behind');
    assert.strictEqual(sent[0].edits, 0);
});

test('a panel still in view is edited in place', async (t) => {
    let below = 0;
    const { queue, sent } = fakeChannel('repost2', () => below);
    t.after(() => musicEvents.removePanel('repost2'));
    await musicEvents.refreshPanel(queue);
    below = 2;
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].edits, 1);
});

test('adding songs edits the panel where it is, only a new song moves it', async (t) => {
    let below = 0;
    const { queue, sent } = fakeChannel('repost3', () => below);
    t.after(() => musicEvents.removePanel('repost3'));
    await musicEvents.refreshPanel(queue);
    below = 10;
    await musicEvents.refreshPanel(queue);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].edits, 1);
});

test('without Read Message History the panel is edited in place and the reason logged', async (t) => {
    const { queue, sent, channel } = fakeChannel('repost4');
    t.after(() => musicEvents.removePanel('repost4'));
    const errors = t.mock.method(console, 'error', () => {});
    await musicEvents.refreshPanel(queue);
    channel.messages.fetch = async () => { throw new Error('Missing Access'); };
    await musicEvents.refreshPanel(queue, { repostIfBuried: true });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].edits, 1);
    assert.strictEqual(errors.mock.callCount(), 1);
});

// The first song's playSong and a quick second /play's addSong both found no panel and both posted
test('two panel updates at once post one panel', async (t) => {
    const { queue, sent } = fakeChannel('repost5');
    t.after(() => musicEvents.removePanel('repost5'));
    await Promise.all([musicEvents.refreshPanel(queue, { repostIfBuried: true }), musicEvents.refreshPanel(queue)]);
    assert.strictEqual(sent.length, 1, 'two panels were posted');
});

test('a panel update queued behind the queue ending posts nothing', async (t) => {
    const { queue, sent } = fakeChannel('repost6');
    await musicEvents.refreshPanel(queue);
    const removed = musicEvents.removePanel('repost6');
    queue.songs = [];
    await Promise.all([removed, musicEvents.refreshPanel(queue)]);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].deleted, true);
});

test('a queue without a voice connection is deleted without an error', (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    musicEvents.releasePlayer({ id: 'guild3' });
    musicEvents.releasePlayer({ id: 'guild3', voice: { stop() { throw new Error('gone'); } } });
    assert.strictEqual(errors.mock.callCount(), 1);
});
