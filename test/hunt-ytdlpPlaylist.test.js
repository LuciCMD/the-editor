const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const childProcess = require('child_process');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const { YtDlpPlugin, playlistArgs, startVideoId, buildSong } = require('../utils/ytdlpPlugin');
const musicEvents = require('../passives/musicEvents');
const musicButtons = require('../components/music');

test.after(() => removeDir(dir));

const FLAT = ['--flat-playlist', '--playlist-end', '100'];

function fakeYtdlp(t, json) {
    const calls = [];
    t.mock.method(childProcess, 'spawn', (file, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        calls.push(args);
        setImmediate(() => {
            child.stdout.emit('data', JSON.stringify(typeof json === 'function' ? json(args) : json));
            child.emit('close', 0);
        });
        return child;
    });
    return calls;
}

const flatEntry = (id, extra = {}) => ({ _type: 'url', ie_key: 'Youtube', id, title: `Song ${id}`, duration: 200, url: `https://www.youtube.com/watch?v=${id}`, ...extra });
const playlist = (entries) => ({ _type: 'playlist', id: 'PLx', title: 'List', extractor: 'youtube:tab', webpage_url: 'https://www.youtube.com/playlist?list=PLx', entries });

test('hunt: a repeated linked video starts the queue at its first appearance', async (t) => {
    fakeYtdlp(t, playlist(['a', 'b', 'a', 'c'].map((id) => flatEntry(id))));
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=a&list=PLx', {});
    assert.deepStrictEqual(result.songs.map((s) => s.id), ['a', 'b', 'a', 'c']);
});

// The tracks before the linked video follow the last one (2026-10-26)
test('hunt: the linked video last in the list starts the queue, the rest follow', async (t) => {
    fakeYtdlp(t, playlist(['a', 'b', 'c'].map((id) => flatEntry(id))));
    const result = await new YtDlpPlugin().resolve('https://youtu.be/c?list=PLx&si=share123', {});
    assert.deepStrictEqual(result.songs.map((s) => s.id), ['c', 'a', 'b']);
});

test('hunt: youtu.be links with a list, with and without a video, start in the right place', () => {
    assert.strictEqual(startVideoId('https://youtu.be/abc?list=PL1&si=xyz'), 'abc');
    assert.strictEqual(startVideoId('https://youtu.be/abc/?list=PL1'), 'abc');
    assert.strictEqual(startVideoId('https://youtu.be/?list=PL1'), null);
    assert.deepStrictEqual(playlistArgs('https://youtu.be/abc?list=PL1'), FLAT);
    assert.deepStrictEqual(playlistArgs('https://youtu.be/abc?list=RDabc'), ['--no-playlist']);
});

test('hunt: an empty list param is a plain video link', () => {
    assert.strictEqual(startVideoId('https://www.youtube.com/watch?v=abc&list='), null);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc&list='), FLAT);
});

test('hunt: a lowercase rd list is not a Mix', () => {
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc&list=rdabc'), FLAT);
    assert.strictEqual(startVideoId('https://www.youtube.com/watch?v=abc&list=rdabc'), 'abc');
});

test('hunt: Spotify links, searches and non-links are left alone', () => {
    assert.strictEqual(startVideoId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), null);
    assert.deepStrictEqual(playlistArgs('ytsearch1:middle of the night'), []);
    assert.deepStrictEqual(playlistArgs('middle of the night'), []);
    assert.strictEqual(startVideoId('ytsearch1:https://www.youtube.com/watch?v=a&list=PL1'), null);
});

// Seen with yt-dlp on 2026-10-26, list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs is "The Hit List", 52 tracks
test('hunt: a song link from a YouTube Music curated playlist (RDCLAK) loads the playlist', () => {
    const link = 'https://music.youtube.com/watch?v=78wrful9cVU&list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs';
    assert.deepStrictEqual(playlistArgs(link), FLAT);
    assert.strictEqual(startVideoId(link), '78wrful9cVU');
});

// A link to track 150 of a long playlist, the flat load stops at 100
test('hunt: a linked video past the first 100 tracks still starts the queue there', async (t) => {
    const calls = fakeYtdlp(t, (args) => {
        let [startAt, end] = [1, 300];
        if (args.includes('--playlist-end')) {
            end = Number(args[args.indexOf('--playlist-end') + 1]);
        }
        if (args.includes('--playlist-items')) {
            [startAt, end] = args[args.indexOf('--playlist-items') + 1].split(':').map(Number);
        }
        const ids = Array.from({ length: 300 }, (_, i) => `v${i + 1}`).slice(startAt - 1, end);
        return playlist(ids.map((id) => flatEntry(id)));
    });
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=v150&list=PLx&index=150', {});
    assert.ok(calls.length >= 1);
    assert.strictEqual(result.songs[0].id, 'v150', `queue started at ${result.songs[0].id}`);
});

// Real shape from a reported playlist on 2026-10-26, entries 10 to 13 are
// private videos, yt-dlp lists them with no title and no duration and each fails when it comes up
const PRIVATE = { title: null, duration: null, view_count: null, availability: null, channel_url: null, ie_key: 'Youtube', id: 'AGYaDXNmqzU', _type: 'url', url: 'https://www.youtube.com/watch?v=AGYaDXNmqzU' };

test('hunt: private videos in a playlist are not queued', async (t) => {
    fakeYtdlp(t, playlist([flatEntry('CMF3qeu7fHY'), PRIVATE, flatEntry('b')]));
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=CMF3qeu7fHY&list=PLexamplePlaylist000000000000000', {});
    assert.deepStrictEqual(result.songs.map((s) => s.id), ['CMF3qeu7fHY', 'b']);
});

function untitledQueue() {
    const plugin = new YtDlpPlugin();
    return {
        id: 'guild9',
        paused: false,
        volume: 50,
        voiceChannel: { id: 'vc9' },
        songs: [flatEntry('a'), PRIVATE, flatEntry('b')].map((e) => buildSong(plugin, e, {}))
    };
}

// buildSong leaves name undefined when yt-dlp gives no title
test('hunt: Up Next on the panel never shows "undefined" for an untitled track', () => {
    const text = JSON.stringify(musicEvents.buildNowPlayingPanel(untitledQueue()));
    assert.doesNotMatch(text, /\d\. (null|undefined)/);
});

test('hunt: the Queue button never shows "undefined" for an untitled track', async () => {
    const queue = untitledQueue();
    let text = '';
    await musicButtons.execute({
        customId: 'music:queue',
        guildId: queue.id,
        member: { voice: { channel: { id: 'vc9' } } },
        reply: async (payload) => { text = JSON.stringify(payload); }
    }, { distube: { getQueue: () => queue } });
    assert.match(text, /Music Queue/);
    assert.doesNotMatch(text, /\d\. (null|undefined)/);
});

// ---- re-check after the RDCLAK, private-entry, rotation and --playlist-items fixes

// yt-dlp honours --playlist-items and --playlist-end like the real one, total is the list length now
function windowedList(t, total) {
    return fakeYtdlp(t, (args) => {
        let [startAt, end] = [1, total];
        if (args.includes('--playlist-end')) {
            end = Number(args[args.indexOf('--playlist-end') + 1]);
        }
        if (args.includes('--playlist-items')) {
            [startAt, end] = args[args.indexOf('--playlist-items') + 1].split(':').map(Number);
        }
        const ids = Array.from({ length: total }, (_, i) => `v${i + 1}`).slice(startAt - 1, end);
        return playlist(ids.map((id) => flatEntry(id)));
    });
}

// Someone removed tracks since the link was copied, index=150 now points past the end of a 120-track list
test('hunt: a stale index past the end of the list still plays the linked video', async (t) => {
    windowedList(t, 120);
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=v110&list=PLx&index=150', {})
        .catch((error) => error);
    assert.ok(!(result instanceof Error), `/play failed with "${result.message}"`);
    assert.strictEqual(result.songs[0].id, 'v110');
});

// index is 1-based at copy time, two tracks removed above it moves the video to 148
test('hunt: a stale index a little off still starts at the linked video', async (t) => {
    windowedList(t, 300);
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=v148&list=PLx&index=150', {});
    assert.strictEqual(result.songs[0].id, 'v148', `queue started at ${result.songs[0].id}`);
});

// YouTube's Share button gives youtu.be/ID?list=…&si=… with no index
test('hunt: a share link to a video past track 100 starts the queue there', {
    todo: 'KNOWN without index the cap still cuts the linked video off and the queue starts at track 1'
}, async (t) => {
    windowedList(t, 300);
    const result = await new YtDlpPlugin().resolve('https://youtu.be/v150?list=PLx&si=abc', {});
    assert.strictEqual(result.songs[0].id, 'v150', `queue started at ${result.songs[0].id}`);
});

test('hunt: index within the first 100 keeps the normal load and rotation', async (t) => {
    const calls = windowedList(t, 300);
    const result = await new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=v40&list=PLx&index=40', {});
    assert.ok(calls[0].includes('--playlist-end'));
    assert.deepStrictEqual(result.songs.slice(0, 2).map((s) => s.id), ['v40', 'v41']);
    assert.strictEqual(result.songs.at(-1).id, 'v39');
    assert.strictEqual(result.songs.length, 100);
});

test('hunt: odd index values fall back to the normal load', () => {
    for (const index of ['0', '-5', 'abc', '', '100']) {
        assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/watch?v=x&list=PLx&index=${index}`), FLAT, `index=${index}`);
    }
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/playlist?list=PLx&index=150'), FLAT, 'no linked video, no window');
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=x&list=RDx&index=150'), ['--no-playlist']);
});

test('hunt: RDCLAK lists load flat but other RD lists stay Mixes', () => {
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=x&list=RDCLAK5uy_abc'), FLAT);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=x&list=RDMM'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=x&list=RDAMVMx'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=x&list=RDEMabc'), ['--no-playlist']);
});

test('hunt: a playlist of only private videos says so, not "lists other lists"', async (t) => {
    fakeYtdlp(t, playlist([PRIVATE, { ...PRIVATE, id: 'p2', title: '[Deleted video]' }]));
    const error = await new YtDlpPlugin().resolve('https://www.youtube.com/playlist?list=PLx', {}).catch((e) => e);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /lists other lists/, `user is told "${error.message}"`);
});

test('hunt: untitled SoundCloud flat entries are still queued', async (t) => {
    fakeYtdlp(t, { _type: 'playlist', id: 's', extractor: 'soundcloud:set', entries: [{ _type: 'url', ie_key: 'Soundcloud', id: '1', url: 'https://soundcloud.com/a/t' }] });
    const result = await new YtDlpPlugin().resolve('https://soundcloud.com/a/sets/b', {});
    assert.deepStrictEqual(result.songs.map((s) => s.id), ['1']);
});
