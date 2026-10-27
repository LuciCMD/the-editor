const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const childProcess = require('child_process');
const { DisTubeHandler, Song } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin, ytdlpJson, playlistArgs, startVideoId, buildSong, stopProcess, MAX_PLAYLIST_TRACKS } = require('../utils/ytdlpPlugin');

const MIX = 'https://www.youtube.com/watch?v=6eFcSesrP6A&list=RDvtY8pM-H65c&index=4';
const PLAYLIST_PAGE = 'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';

// Stands in for the yt-dlp process, prints the JSON and exits unless hang is set
// json can be a function of the args, for tests where search and stream calls answer differently
function fakeYtdlp(t, { json, hang = false } = {}) {
    const calls = [];
    t.mock.method(childProcess, 'spawn', (file, args) => {
        const output = typeof json === 'function' ? json(args) : json;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; };
        calls.push({ file, args, child });
        if (!hang) {
            setImmediate(() => {
                child.stdout.emit('data', JSON.stringify(output));
                child.emit('close', 0);
            });
        }
        return child;
    });
    return calls;
}

test('a video inside a Mix plays just that video', () => {
    assert.deepStrictEqual(playlistArgs(MIX), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://youtu.be/6eFcSesrP6A?list=RDvtY8pM-H65c'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=s3a4OQR-10M&list=RDGMEMexampleMix000000000s3a4OQR-10M&start_radio=1'),
        ['--no-playlist']);
    assert.strictEqual(startVideoId(MIX), null);
});

// Seen on the test bot, a video link from a real playlist queued only that one video
test('a video inside a real playlist or album loads the list', () => {
    const flat = ['--flat-playlist', '--playlist-end', '100'];
    const link = 'https://www.youtube.com/watch?v=CMF3qeu7fHY&list=PLexamplePlaylist000000000000000&pp=8AUBsAgC';
    assert.deepStrictEqual(playlistArgs(link), flat);
    assert.deepStrictEqual(playlistArgs('https://music.youtube.com/watch?v=abc&list=OLAK5uy_x'), flat);
    assert.deepStrictEqual(playlistArgs('https://m.youtube.com/watch?v=abc&list=PL123'), flat);
    assert.strictEqual(startVideoId(link), 'CMF3qeu7fHY');
    assert.strictEqual(startVideoId('https://youtu.be/abc?list=PL123'), 'abc');
    assert.strictEqual(startVideoId('https://www.youtube.com/shorts/abc?list=PL123'), 'abc');
    assert.strictEqual(startVideoId(PLAYLIST_PAGE), null);
    assert.strictEqual(startVideoId('https://www.youtube.com/watch?v=abc'), null);
});

test('a video link inside a playlist starts the queue at that video', async (t) => {
    const entries = ['id0', 'id1', 'id2'].map((id) => ({ _type: 'url', ie_key: 'Youtube', id, title: id, url: `https://www.youtube.com/watch?v=${id}` }));
    fakeYtdlp(t, { json: { _type: 'playlist', id: 'PLx', title: 'List', extractor: 'youtube:tab', webpage_url: PLAYLIST_PAGE, entries } });
    const plugin = new YtDlpPlugin();
    const fromLink = await plugin.resolve('https://www.youtube.com/watch?v=id1&list=PLx', {});
    assert.deepStrictEqual(fromLink.songs.map((s) => s.id), ['id1', 'id2', 'id0'], 'tracks before the linked video were dropped');
    const missing = await plugin.resolve('https://www.youtube.com/watch?v=gone&list=PLx', {});
    assert.deepStrictEqual(missing.songs.map((s) => s.id), ['id0', 'id1', 'id2'], 'a video not in the list should play the list from the top');
});

test('a playlist page loads only the track list, capped at 100', () => {
    assert.deepStrictEqual(playlistArgs(PLAYLIST_PAGE), ['--flat-playlist', '--playlist-end', '100']);
    assert.strictEqual(MAX_PLAYLIST_TRACKS, 100);
});

test('Shorts, live and embed links inside a Mix play just that video', () => {
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/shorts/abc?list=RDabc'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/live/abc?list=RDabc'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/embed/abc?list=RDabc'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/embed/videoseries?list=PL123'),
        ['--flat-playlist', '--playlist-end', '100']);
});

// Other YouTube links load only the track list, other sites keep titles but stop at 100 tracks
test('YouTube links load only the track list, other sites are capped, searches are left alone', () => {
    const flat = ['--flat-playlist', '--playlist-end', '100'];
    assert.deepStrictEqual(playlistArgs('https://soundcloud.com/a/sets/b'), ['--playlist-end', '100']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/@NoCopyrightSounds/videos'), flat);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc'), flat);
    assert.deepStrictEqual(playlistArgs('ytsearch1:never gonna give you up'), []);
    assert.deepStrictEqual(playlistArgs('not a url'), []);
});

test('a failed track in a playlist is skipped, not the whole list', async (t) => {
    fakeYtdlp(t, {
        json: {
            _type: 'playlist', id: 'set', title: 'Set', extractor: 'soundcloud:set', webpage_url: 'https://soundcloud.com/a/sets/b',
            entries: [null, { _type: 'url', ie_key: 'Soundcloud', id: 't1', title: 'Track', url: 'https://soundcloud.com/a/t1' }]
        }
    });
    const playlist = await new YtDlpPlugin().resolve('https://soundcloud.com/a/sets/b', {});
    assert.strictEqual(playlist.songs.length, 1);
    assert.strictEqual(playlist.songs[0].name, 'Track');
});

test('a kill that throws still rejects instead of hanging', { timeout: 5000 }, async (t) => {
    const calls = fakeYtdlp(t, { hang: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const pending = ytdlpJson('https://www.youtube.com/watch?v=abc');
    calls[0].child.kill = () => { throw new Error('EINVAL'); };
    t.mock.timers.tick(60 * 1000);
    await assert.rejects(pending, /timed out/);
});

test('resolving a Mix link asks yt-dlp for the single video', async (t) => {
    const calls = fakeYtdlp(t, {
        json: { id: '6eFcSesrP6A', title: 'Song', extractor: 'youtube', webpage_url: 'https://www.youtube.com/watch?v=6eFcSesrP6A', duration: 200 }
    });
    const song = await new YtDlpPlugin().resolve(MIX, {});
    assert.ok(calls[0].args.includes('--no-playlist'), 'Mix was resolved as a whole playlist');
    assert.strictEqual(song.name, 'Song');
});

test('a playlist page becomes songs that fetch their audio later', async (t) => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
        _type: 'url', ie_key: 'Youtube', id: `id${i}`, title: `Track ${i}`,
        url: `https://www.youtube.com/watch?v=id${i}`, duration: 100 + i
    }));
    const calls = fakeYtdlp(t, {
        json: { _type: 'playlist', id: 'PLx', title: 'My List', extractor: 'youtube:tab', webpage_url: PLAYLIST_PAGE, entries }
    });
    const playlist = await new YtDlpPlugin().resolve(PLAYLIST_PAGE, {});
    assert.ok(calls[0].args.includes('--flat-playlist'), 'full details were fetched for every track');
    assert.strictEqual(playlist.songs.length, 3);
    assert.strictEqual(playlist.songs[1].url, 'https://www.youtube.com/watch?v=id1');
    assert.strictEqual(playlist.songs[1].name, 'Track 1');
    assert.strictEqual(playlist.songs[1].source, 'youtube');
});

// A full entry's url is the expiring media link, it must never become the song's page link
test('a full playlist entry without a page link never uses its media url', () => {
    const plugin = new YtDlpPlugin();
    const full = buildSong(plugin, { id: 'x', title: 'Clip', extractor: 'generic', url: 'https://cdn.example/media.mp4?expires=1' }, {});
    assert.strictEqual(full.url, undefined, 'media url was used as the song link');
    const flat = buildSong(plugin, { _type: 'url', ie_key: 'Youtube', id: 'y', title: 'T', url: 'https://www.youtube.com/watch?v=y' }, {});
    assert.strictEqual(flat.url, 'https://www.youtube.com/watch?v=y');
});

test('a yt-dlp run that never ends is stopped after 60 s with a clear error', { timeout: 5000 }, async (t) => {
    const calls = fakeYtdlp(t, { hang: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = t.mock.method(console, 'error', () => {});

    const pending = ytdlpJson(MIX);
    t.mock.timers.tick(60 * 1000);
    await assert.rejects(pending, /timed out after 60 s/);
    assert.strictEqual(calls[0].child.killed, true, 'hung yt-dlp process was left running');
    assert.ok(errors.mock.callCount() > 0, 'timeout was not logged');
});

// Seen on Windows, kill() ended only the launcher and the yt-dlp worker kept running
test('on Windows a stuck yt-dlp is stopped with its worker, by its own PID only', (t) => {
    const calls = fakeYtdlp(t, { hang: true });
    const child = { pid: 4321, killed: false, kill() { this.killed = true; } };
    stopProcess(child, 'win32');
    assert.strictEqual(calls.length, 1, 'no tree kill was started');
    assert.strictEqual(calls[0].file, 'taskkill');
    assert.deepStrictEqual(calls[0].args, ['/pid', '4321', '/T', '/F']);
});

test('elsewhere a stuck yt-dlp gets a plain kill', (t) => {
    const calls = fakeYtdlp(t, { hang: true });
    const child = { pid: 4321, killed: false, kill() { this.killed = true; } };
    stopProcess(child, 'linux');
    assert.strictEqual(child.killed, true);
    assert.strictEqual(calls.length, 0);
});

const SEARCH_RESULT = {
    _type: 'playlist', id: 'search', extractor: 'youtube:search',
    entries: [{ _type: 'url', ie_key: 'Youtube', id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 213 }]
};

function handlerWith(plugin) {
    return new DisTubeHandler({ plugins: [new SpotifyPlugin(), plugin], debug() {}, options: {} });
}

// DisTube only searches with extractor plugins, as a playable extractor every search found nothing
test('/play with a song name finds the first YouTube result', async (t) => {
    const calls = fakeYtdlp(t, { json: SEARCH_RESULT });
    const song = await handlerWith(new YtDlpPlugin()).resolve('never gonna give you up', {});
    assert.strictEqual(calls[0].args[0], 'ytsearch1:never gonna give you up');
    assert.ok(calls[0].args.includes('--flat-playlist'), 'search fetched full details');
    assert.strictEqual(song.name, 'Never Gonna Give You Up');
    assert.strictEqual(song.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('a search with no results is a clear no-result error', async (t) => {
    fakeYtdlp(t, { json: { _type: 'playlist', id: 'search', extractor: 'youtube:search', entries: [] } });
    await assert.rejects(handlerWith(new YtDlpPlugin()).resolve('zzzz no such song', {}),
        (e) => e.errorCode === 'NO_RESULT' || e.errorCode === 'CANNOT_RESOLVE_SONG');
});

// Spotify tracks have no audio of their own, DisTube searches YouTube for them the same way
test('a Spotify track gets its audio from a YouTube search', async (t) => {
    const calls = fakeYtdlp(t, {
        json: (args) => (args[0].startsWith('ytsearch1:') ? SEARCH_RESULT : { id: 'dQw4w9WgXcQ', url: 'https://audio.example/stream' })
    });
    const spotifyLike = { type: 'info-extractor', validate: () => true, createSearchQuery: () => 'Rick Astley - Never Gonna Give You Up' };
    const song = new Song({ plugin: spotifyLike, source: 'spotify', playFromSource: false, id: 'sp1',
        name: 'Never Gonna Give You Up', url: 'https://open.spotify.com/track/sp1' }, {});
    await handlerWith(new YtDlpPlugin()).attachStreamInfo(song);
    assert.strictEqual(calls[0].args[0], 'ytsearch1:Rick Astley - Never Gonna Give You Up');
    assert.strictEqual(song.stream.song.stream.url, 'https://audio.example/stream');
});

test('a timed-out resolve reaches DisTube as an error, not a hang', { timeout: 5000 }, async (t) => {
    fakeYtdlp(t, { hang: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});

    const pending = new YtDlpPlugin().resolve(PLAYLIST_PAGE, {});
    t.mock.timers.tick(60 * 1000);
    await assert.rejects(pending, /timed out/);
});
