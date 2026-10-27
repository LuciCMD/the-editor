const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const childProcess = require('child_process');
const { DisTubeHandler, Song } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin, ytdlpJson, playlistArgs, startVideoId } = require('../utils/ytdlpPlugin');

const PL = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
const FLAT = ['--flat-playlist', '--playlist-end', '100'];

// Fake yt-dlp process, the test drives its output and exit by hand
function fakeSpawn(t) {
    const calls = [];
    t.mock.method(childProcess, 'spawn', (file, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killCount = 0;
        child.kill = () => { child.killCount += 1; return true; };
        calls.push({ args, child });
        return child;
    });
    return calls;
}

function respond(child, json, code = 0) {
    child.stdout.emit('data', Buffer.from(JSON.stringify(json)));
    child.emit('close', code);
}

const tick = () => new Promise((r) => setImmediate(r));

// ---- playlistArgs: links that should play one video

// A video in a real playlist loads the list from that video (author, 2026-10-26), only Mixes play one
test('hunt: a Shorts link inside a playlist loads the list from that Short', () => {
    assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/shorts/mw3kSNIxjqo?list=${PL}`), FLAT);
    assert.strictEqual(startVideoId(`https://www.youtube.com/shorts/mw3kSNIxjqo?list=${PL}`), 'mw3kSNIxjqo');
});

test('hunt: a Shorts link inside a Mix plays just that Short', () => {
    // real yt-dlp fails with "This playlist type is unviewable" when flattened
    assert.deepStrictEqual(playlistArgs('https://youtube.com/shorts/6eFcSesrP6A?list=RDvtY8pM-H65c'), ['--no-playlist']);
});

test('hunt: an embed link for one video inside a list loads the list from that video', () => {
    assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/embed/mw3kSNIxjqo?list=${PL}`), FLAT);
    assert.strictEqual(startVideoId(`https://www.youtube.com/embed/mw3kSNIxjqo?list=${PL}`), 'mw3kSNIxjqo');
});

test('hunt: a live link inside a list loads the list from that video', () => {
    assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/live/mw3kSNIxjqo?list=${PL}`), FLAT);
    assert.strictEqual(startVideoId(`https://www.youtube.com/live/mw3kSNIxjqo?list=${PL}`), 'mw3kSNIxjqo');
});

// ---- playlistArgs: cases that already behave

test('hunt: odd casing in scheme and host still counts as YouTube', () => {
    assert.deepStrictEqual(playlistArgs('HTTPS://WWW.YouTube.COM/watch?v=abc&list=RDx'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs(`https://M.YOUTUBE.COM/playlist?list=${PL}`), FLAT);
    assert.deepStrictEqual(playlistArgs('https://YOUTU.BE/abc?list=RDx'), ['--no-playlist']);
});

test('hunt: list order and extra params do not matter', () => {
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?list=RDx&index=4&v=abc'), ['--no-playlist']);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc&list=RDx&start_radio=1&t=30s'), ['--no-playlist']);
});

test('hunt: watch?list= without v is a playlist page', () => {
    assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/watch?list=${PL}`), FLAT);
    assert.deepStrictEqual(playlistArgs(`https://music.youtube.com/playlist?list=OLAK5uy_abc`), FLAT);
    assert.deepStrictEqual(playlistArgs(`https://www.youtube.com/embed/videoseries?list=${PL}`), FLAT);
});

// Every link without a video in a list gets the flat track list, which changes nothing for one video
test('hunt: links without a list never get --no-playlist', () => {
    assert.deepStrictEqual(playlistArgs('https://youtu.be/abc'), FLAT);
    assert.deepStrictEqual(playlistArgs('https://youtu.be/abc?si=xyz&t=5'), FLAT);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc&index=4'), FLAT);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/shorts/abc'), FLAT);
});

test('hunt: percent-encoded params are decoded before checking', () => {
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?%76=abc&%6Cist=RDx'), ['--no-playlist']);
    // an encoded ampersand inside v is one value, there is no list
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com/watch?v=abc%26list%3DRDx'), FLAT);
});

// Lookalikes are other sites, so they get the plain cap, never --no-playlist or flat
test('hunt: lookalike hosts never get the YouTube single-video rule', () => {
    const capped = ['--playlist-end', '100'];
    assert.deepStrictEqual(playlistArgs('https://youtube.com.evil.example/watch?v=a&list=b'), capped);
    assert.deepStrictEqual(playlistArgs('https://notyoutube.com/watch?v=a&list=b'), capped);
    assert.deepStrictEqual(playlistArgs('https://www.youtube.com@evil.example/watch?v=a&list=b'), capped);
});

test('hunt: search strings that contain list= are left alone', () => {
    assert.deepStrictEqual(playlistArgs('ytsearch1:watch?v=a&list=b'), []);
    assert.deepStrictEqual(playlistArgs('ytsearch1:https://www.youtube.com/watch?list=PL1'), []);
    assert.deepStrictEqual(playlistArgs(''), []);
});

// ---- resolve with flat playlist shapes

test('hunt: flat entries with missing title, duration, thumbnails and url still build songs', async (t) => {
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve(`https://www.youtube.com/playlist?list=${PL}`, {});
    await tick();
    respond(calls[0].child, {
        _type: 'playlist', id: PL, title: 'L', extractor: 'youtube:tab',
        webpage_url: `https://www.youtube.com/playlist?list=${PL}`,
        entries: [
            { _type: 'url', ie_key: 'Youtube', id: 'priv', title: '[Private video]', duration: null, url: 'https://www.youtube.com/watch?v=priv', thumbnails: [] },
            { _type: 'url', id: 'bare' },
            { _type: 'url', ie_key: 'Youtube', id: 'ok', title: 'Fine', duration: 200, url: 'https://www.youtube.com/watch?v=ok' }
        ]
    });
    // Private videos are skipped since 2026-10-26, they only failed when their turn came
    const playlist = await pending;
    assert.deepStrictEqual(playlist.songs.map((s) => s.id), ['bare', 'ok']);
    assert.strictEqual(playlist.songs[0].duration, 0);
    assert.strictEqual(playlist.songs[0].thumbnail, undefined);
    assert.strictEqual(playlist.songs[0].source, 'youtube');
    assert.strictEqual(playlist.duration, 200);
    assert.ok(playlist.songs.every((s) => s.playlist === playlist));
});

test('hunt: a flat playlist with no entries is a clear error', async (t) => {
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve(`https://www.youtube.com/playlist?list=${PL}`, {});
    await tick();
    respond(calls[0].child, { _type: 'playlist', id: PL, extractor: 'youtube:tab', entries: [] });
    await assert.rejects(pending, (e) => e.errorCode === 'YTDLP_ERROR' && /empty/.test(e.message));
});

test('hunt: a playlist with a null entry (failed track) skips it instead of a TypeError', async (t) => {
    // yt-dlp -J without --flat-playlist can leave null for a track that failed to extract
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve('https://soundcloud.com/a/sets/b', {});
    await tick();
    respond(calls[0].child, {
        _type: 'playlist', id: 'b', extractor: 'soundcloud:set',
        entries: [null, { id: '1', extractor: 'soundcloud', title: 'T', webpage_url: 'https://soundcloud.com/a/t', duration: 10 }]
    });
    const playlist = await pending;
    assert.deepStrictEqual(playlist.songs.map((s) => s.name), ['T']);
});

test('hunt: getStreamURL on a flat song asks for the watch link and returns the audio url', async (t) => {
    const calls = fakeSpawn(t);
    const plugin = new YtDlpPlugin();
    const song = new Song({ plugin, source: 'youtube', playFromSource: true, id: 'ok', url: 'https://www.youtube.com/watch?v=ok' }, {});
    const pending = plugin.getStreamURL(song);
    await tick();
    assert.strictEqual(calls[0].args[0], 'https://www.youtube.com/watch?v=ok');
    assert.ok(calls[0].args.includes('ba/ba*'));
    respond(calls[0].child, { id: 'ok', url: 'https://audio.example/ok' });
    assert.strictEqual(await pending, 'https://audio.example/ok');
});

// ---- ytdlpJson timeout races

test('hunt: exit before the timer resolves and never kills', async (t) => {
    const calls = fakeSpawn(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = ytdlpJson('u', [], 1000);
    respond(calls[0].child, { ok: 1 });
    t.mock.timers.tick(5000);
    assert.deepStrictEqual(await pending, { ok: 1 });
    assert.strictEqual(calls[0].child.killCount, 0);
});

test('hunt: timer first, then a late good exit, still rejects once with the timeout', async (t) => {
    const calls = fakeSpawn(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const pending = ytdlpJson('u', [], 1000);
    t.mock.timers.tick(1000);
    respond(calls[0].child, { late: true });
    calls[0].child.emit('close', 1);
    calls[0].child.emit('error', new Error('after'));
    await assert.rejects(pending, /timed out after 1 s/);
    assert.strictEqual(calls[0].child.killCount, 1);
});

test('hunt: spawn error then close rejects with the spawn error and clears the timer', async (t) => {
    const calls = fakeSpawn(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = t.mock.method(console, 'error', () => {});
    const pending = ytdlpJson('u', [], 1000);
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    calls[0].child.emit('error', enoent);
    calls[0].child.emit('close', -2);
    t.mock.timers.tick(5000);
    await assert.rejects(pending, (e) => e === enoent);
    assert.strictEqual(calls[0].child.killCount, 0);
    assert.strictEqual(errors.mock.callCount(), 0, 'timeout fired after the run already failed');
});

test('hunt: kill that reports failure through an error event still gives one timeout rejection', async (t) => {
    const calls = fakeSpawn(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const pending = ytdlpJson('u', [], 1000);
    calls[0].child.kill = () => { calls[0].child.emit('error', new Error('kill EPERM')); return false; };
    t.mock.timers.tick(1000);
    await assert.rejects(pending, /timed out/);
});

test('hunt: a kill that throws still rejects instead of hanging', { todo: 'theoretical, Node kill only throws on EINVAL or ENOSYS' }, async (t) => {
    // Node only throws from kill for EINVAL or ENOSYS, so this is theoretical
    const calls = fakeSpawn(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const pending = ytdlpJson('u', [], 1000);
    calls[0].child.kill = () => { throw new Error('kill EINVAL'); };
    try {
        t.mock.timers.tick(1000);
    } catch {
        // the throw escapes the timer callback, in the bot that is an uncaught exception
    }
    const outcome = await Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        new Promise((r) => setImmediate(() => r('still pending')))
    ]);
    assert.strictEqual(outcome, 'rejected');
});

test('hunt: chunked stdout across several data events parses', async (t) => {
    const calls = fakeSpawn(t);
    const pending = ytdlpJson('u');
    const text = JSON.stringify({ title: 'caf\\u00e9', n: 'x'.repeat(200000) });
    const child = calls[0].child;
    for (let i = 0; i < text.length; i += 65536) child.stdout.emit('data', Buffer.from(text.slice(i, i + 65536)));
    child.emit('close', 0);
    const info = await pending;
    assert.strictEqual(info.n.length, 200000);
});

test('hunt: non-zero exit carries stderr and the url never ends up as an option', async (t) => {
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve('https://www.youtube.com/watch?v=gone', {});
    await tick();
    assert.strictEqual(calls[0].args[0], 'https://www.youtube.com/watch?v=gone');
    calls[0].child.stderr.emit('data', 'ERROR: Video unavailable');
    calls[0].child.emit('close', 1);
    await assert.rejects(pending, /Video unavailable/);
});

// ---- outside this change, found while tracing how /play reaches the plugin

test('hunt (pre-existing): a /play search reaches the yt-dlp plugin', async () => {
    const yt = new YtDlpPlugin();
    let reached = null;
    yt.searchSong = async (query) => { reached = query; return null; };
    const handler = new DisTubeHandler({ plugins: [new SpotifyPlugin(), yt], debug() {}, options: {} });
    // play.js now sends plain text as is
    await handler.resolve('never gonna give you up', {}).catch(() => {});
    assert.strictEqual(reached, 'never gonna give you up', 'search never reached YtDlpPlugin, DisTube threw NO_RESULT');
});

// ---- second round, against the search and flat-for-every-link fixes

const handlerWith = (...plugins) => new DisTubeHandler({ plugins, debug() {}, options: {} });

test('hunt: a flat SoundCloud set gives songs that can be played', async (t) => {
    // real yt-dlp 2026.10.26 on soundcloud.com/forss/sets/soulhack returns url_transparent entries like these
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve('https://soundcloud.com/forss/sets/soulhack', {});
    await tick();
    respond(calls[0].child, {
        _type: 'playlist', id: '2284613', title: 'Soulhack', extractor: 'soundcloud:set',
        webpage_url: 'https://soundcloud.com/forss/sets/soulhack',
        entries: [
            { album: 'Soulhack', ie_key: 'Soundcloud', id: '290', _type: 'url_transparent', url: 'https://soundcloud.com/forss/city-ports' },
            { album: 'Soulhack', ie_key: 'Soundcloud', id: '296', _type: 'url_transparent', url: 'https://api-v2.soundcloud.com/tracks/296' }
        ]
    });
    const playlist = await pending;
    assert.deepStrictEqual(playlist.songs.map((s) => s.url),
        ['https://soundcloud.com/forss/city-ports', 'https://api-v2.soundcloud.com/tracks/296'],
        'songs have no url so getStreamURL throws YTDLP_PLUGIN_INVALID_SONG for every track');
});

test('hunt: a channel home link does not queue its Videos, Live and Shorts tabs as songs', async (t) => {
    // real yt-dlp on youtube.com/@TaylorSwift with --flat-playlist returns three nested tab playlists
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve('https://www.youtube.com/@TaylorSwift', {});
    await tick();
    const tab = (name, path) => ({
        _type: 'playlist', id: 'UCqECaJ8Gagnn7YCbPEzWH6g', title: `Taylor Swift - ${name}`, extractor: 'youtube:tab',
        webpage_url: `https://www.youtube.com/@TaylorSwift/${path}`,
        entries: [{ _type: 'url', ie_key: 'Youtube', id: `${path}1`, title: 'T', url: `https://www.youtube.com/watch?v=${path}1` }]
    });
    respond(calls[0].child, {
        _type: 'playlist', id: 'UCqECaJ8Gagnn7YCbPEzWH6g', title: 'Taylor Swift', extractor: 'youtube:tab',
        entries: [tab('Videos', 'videos'), tab('Live', 'streams'), tab('Shorts', 'shorts')]
    });
    const result = await pending.catch((e) => e);
    if (result instanceof Error) {
        return;
    }
    const tabs = result.songs.filter((s) => /\/@TaylorSwift\/(videos|streams|shorts)$/.test(s.url));
    assert.deepStrictEqual(tabs.map((s) => s.name), [], 'each tab plays as a song, getStreamURL then fully resolves the tab and times out');
});

test('hunt: a channel Playlists tab does not queue whole playlists as songs', async (t) => {
    // real yt-dlp on /@TaylorSwift/playlists gives 30 entries like this, each a playlist link
    const calls = fakeSpawn(t);
    const pending = new YtDlpPlugin().resolve('https://www.youtube.com/@TaylorSwift/playlists', {});
    await tick();
    respond(calls[0].child, {
        _type: 'playlist', id: 'UCq', title: 'Taylor Swift - Playlists', extractor: 'youtube:tab',
        entries: [{ _type: 'url', ie_key: 'YoutubeTab', id: 'PLINj2JJM1jxMKUSiMcZPYvORDFh5sa8XH', title: 'The Life of a Showgirl', url: 'https://www.youtube.com/playlist?list=PLINj2JJM1jxMKUSiMcZPYvORDFh5sa8XH' }]
    });
    const result = await pending.catch((e) => e);
    if (result instanceof Error) {
        return;
    }
    const lists = result.songs.filter((s) => /[?&]list=/.test(s.url || ''));
    assert.deepStrictEqual(lists.map((s) => s.name), [], 'a playlist link became one song, playing it resolves the full list with no cap');
});

test('hunt: search text starting with a dash cannot become a yt-dlp option', async (t) => {
    const calls = fakeSpawn(t);
    const pending = handlerWith(new SpotifyPlugin(), new YtDlpPlugin()).resolve('--exec calc', {});
    await tick();
    assert.strictEqual(calls[0].args[0], 'ytsearch1:--exec calc');
    respond(calls[0].child, { _type: 'playlist', entries: [{ _type: 'url', ie_key: 'Youtube', id: 'a', title: 'A', url: 'https://www.youtube.com/watch?v=a' }] });
    assert.strictEqual((await pending).url, 'https://www.youtube.com/watch?v=a');
});

test('hunt: one-word search and ytsearch prefixes are handled', async (t) => {
    const calls = fakeSpawn(t);
    const yt = new YtDlpPlugin();
    const cases = [['despacito', 'ytsearch1:despacito'], ['YTSEARCH5:a b', 'YTSEARCH5:a b'], ['song ytsearch1:x', 'ytsearch1:song ytsearch1:x']];
    for (const [query, expected] of cases) {
        const pending = yt.searchSong(query, {});
        await tick();
        const call = calls[calls.length - 1];
        assert.strictEqual(call.args[0], expected);
        respond(call.child, { _type: 'playlist', entries: [null, { _type: 'url', ie_key: 'Youtube', id: 'a', title: 'A', url: 'https://www.youtube.com/watch?v=a' }] });
        assert.strictEqual((await pending).id, 'a');
    }
});

test('hunt: a search with no results is a DisTube error, not a hang', async (t) => {
    const calls = fakeSpawn(t);
    const pending = handlerWith(new SpotifyPlugin(), new YtDlpPlugin()).resolve('zzzz nothing', {});
    await tick();
    respond(calls[0].child, { _type: 'playlist', entries: [] });
    await assert.rejects(pending, (e) => e.errorCode === 'CANNOT_RESOLVE_SONG');
});

test('hunt: a Spotify track searches YouTube then gets the audio url', async (t) => {
    const calls = fakeSpawn(t);
    const spotify = new SpotifyPlugin();
    const handler = handlerWith(spotify, new YtDlpPlugin());
    const song = new Song({ plugin: spotify, source: 'spotify', playFromSource: false, id: 's', name: 'Anti-Hero', uploader: { name: 'Taylor Swift' }, url: 'https://open.spotify.com/track/s' }, {});
    const pending = handler.attachStreamInfo(song);
    await tick();
    assert.strictEqual(calls[0].args[0], 'ytsearch1:Anti-Hero Taylor Swift');
    respond(calls[0].child, { _type: 'playlist', entries: [{ _type: 'url', ie_key: 'Youtube', id: 'b1', title: 'Anti-Hero', url: 'https://www.youtube.com/watch?v=b1' }] });
    await tick();
    assert.strictEqual(calls[1].args[0], 'https://www.youtube.com/watch?v=b1');
    respond(calls[1].child, { id: 'b1', url: 'https://audio.example/b1' });
    await pending;
    assert.strictEqual(song.stream.song.stream.url, 'https://audio.example/b1');
});
