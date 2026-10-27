// Custom DisTube extractor that shells out to the yt-dlp binary managed by
// @distube/yt-dlp, but fixes two problems with that package's built-in plugin:
//
//   1. It passed the deprecated `--no-call-home` flag, and recent yt-dlp prints
//      "Deprecated Feature: ..." to stderr.
//   2. Its wrapper merged stderr INTO stdout and JSON.parsed the combined text,
//      so ANY stderr line (a deprecation, a warning) crashed playback with
//      "Unexpected token ... is not valid JSON".
//
// Here we parse stdout ONLY (stderr is used solely for error messages) and never
// pass deprecated flags, so warnings can't break extraction again. The binary is
// still downloaded/updated by @distube/yt-dlp's `download()` (called in app.js).

const path = require('path');
const childProcess = require('child_process');
const { ExtractorPlugin, Playlist, Song, DisTubeError } = require('distube');

const IS_WINDOWS = Boolean(process.env.YTDLP_IS_WINDOWS) || process.platform === 'win32';
const YTDLP_DIR = process.env.YTDLP_DIR
    || path.join(path.dirname(require.resolve('@distube/yt-dlp')), '..', 'bin');
const YTDLP_FILENAME = process.env.YTDLP_FILENAME || `yt-dlp${IS_WINDOWS ? '.exe' : ''}`;
const YTDLP_PATH = path.join(YTDLP_DIR, YTDLP_FILENAME);

const BASE_ARGS = ['--dump-single-json', '--no-warnings', '--prefer-free-formats', '--skip-download', '--simulate'];

// A YouTube Mix never finished resolving, so every call gets a hard limit
const YTDLP_TIMEOUT_MS = 60 * 1000;
const MAX_PLAYLIST_TRACKS = 100;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'music.youtube.com', 'youtu.be']);
const FLAT_ARGS = ['--flat-playlist', '--playlist-end', String(MAX_PLAYLIST_TRACKS)];
const STALE_INDEX_SLACK = 50;

const isPlaylist = (info) => Array.isArray(info.entries);
const FLAT_TYPES = new Set(['url', 'url_transparent']);

function parseLink(input) {
    let url;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }
    return { url, host: url.hostname.toLowerCase().replace(/^(www|m)\./, '') };
}

// /embed/videoseries is a playlist, every other /shorts, /live or /embed path names one video
function linkedVideoId(url, host) {
    if (host === 'youtu.be') {
        return url.pathname.slice(1).split('/')[0] || null;
    }
    if (url.searchParams.get('v')) {
        return url.searchParams.get('v');
    }
    const match = /^\/(shorts|live|embed)\/(?!videoseries\b)([^/]+)/.exec(url.pathname);
    return match ? match[2] : null;
}

// Mix and radio lists (RD…) are endless and never finished resolving
// RDCLAK lists are YouTube Music's curated playlists, finite like any other
function isMixList(url) {
    const list = url.searchParams.get('list') || '';
    return list.startsWith('RD') && !list.startsWith('RDCLAK');
}

// The video a link inside a real playlist names, the queue starts there like it does on YouTube
// and the tracks before it follow the last one, so none are dropped
function startVideoId(input) {
    const link = parseLink(input);
    if (!link || !YOUTUBE_HOSTS.has(link.host) || !link.url.searchParams.get('list') || isMixList(link.url)) {
        return null;
    }
    return linkedVideoId(link.url, link.host);
}

// A video link inside a Mix plays only that video
// Other YouTube links only fetch the track list, each track's audio is looked up when it plays
// Other sites keep full details so titles show, flat SoundCloud sets come back untitled
function playlistArgs(input) {
    const link = parseLink(input);
    if (!link) {
        return [];
    }
    if (!YOUTUBE_HOSTS.has(link.host)) {
        return ['--playlist-end', String(MAX_PLAYLIST_TRACKS)];
    }
    if (isMixList(link.url) && linkedVideoId(link.url, link.host)) {
        return ['--no-playlist'];
    }
    // A link to a video past the cap loads 100 tracks around it, else it would never play
    // The window opens early since index goes stale when tracks above it are removed
    const index = Number.parseInt(link.url.searchParams.get('index'), 10);
    if (index > MAX_PLAYLIST_TRACKS && startVideoId(input)) {
        const first = index - STALE_INDEX_SLACK;
        return ['--flat-playlist', '--playlist-items', `${first}:${first + MAX_PLAYLIST_TRACKS - 1}`];
    }
    return [...FLAT_ARGS];
}

// A channel home lists its Videos, Live and Shorts tabs, a Playlists tab lists whole playlists,
// neither is one track and playing one would resolve a whole list without the cap
// Flat YouTube lists give private and deleted videos no title, each would fail when its turn came
// SoundCloud's flat entries have no title either but play fine, so only YouTube's are dropped
function isTrackEntry(entry) {
    if (!entry || entry._type === 'playlist' || entry.ie_key === 'YoutubeTab') {
        return false;
    }
    if (entry.ie_key === 'Youtube' && FLAT_TYPES.has(entry._type)) {
        return Boolean(entry.title) && !/^\[(Private|Deleted) video\]$/.test(entry.title);
    }
    return true;
}

// yt-dlp.exe is a launcher with a worker child and kill() only ends the launcher, seen leaving the
// worker running, so on Windows the tree under that one PID is ended
function stopProcess(child, platform = process.platform) {
    if (platform === 'win32' && child.pid) {
        childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            .on('error', () => child.kill());
        return;
    }
    child.kill();
}

// Run yt-dlp and resolve with parsed stdout JSON. Rejects with an error whose
// `.stderr` holds yt-dlp's diagnostics.
function ytdlpJson(url, extraArgs = [], timeoutMs = YTDLP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(YTDLP_PATH, [url, ...BASE_ARGS, ...extraArgs]);
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            try {
                stopProcess(child);
            } catch (killError) {
                console.error('Could not stop yt-dlp:', killError.message);
            }
            console.error(`yt-dlp gave up on ${url} after ${timeoutMs / 1000} s`, stderr.trim());
            reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000} s`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (settled) {
                return;
            }
            settled = true;
            if (code !== 0) {
                const err = new Error(`yt-dlp exited with code ${code}`);
                err.stderr = stderr.trim();
                return reject(err);
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (parseError) {
                const err = new Error('Failed to parse yt-dlp output');
                err.stderr = (stderr || stdout).trim();
                reject(err);
            }
        });
    });
}

function buildSong(plugin, info, options) {
    return new Song({
        plugin,
        // Flat playlist entries only carry ie_key and the page link in url, on a full entry url is
        // the expiring media link so it's only used for flat ones
        source: info.extractor || info.ie_key || 'youtube',
        playFromSource: true,
        id: info.id,
        name: info.title || info.fulltitle,
        url: info.webpage_url || info.original_url || (FLAT_TYPES.has(info._type) ? info.url : undefined),
        isLive: info.is_live,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0] && info.thumbnails[0].url),
        duration: info.is_live ? 0 : info.duration,
        uploader: { name: info.uploader, url: info.uploader_url },
        views: info.view_count,
        likes: info.like_count,
        dislikes: info.dislike_count,
        reposts: info.repost_count,
        ageRestricted: Boolean(info.age_limit) && info.age_limit >= 18
    }, options);
}

class YtDlpPlugin extends ExtractorPlugin {
    // Catch-all for links, keep it last in the DisTube plugins array
    validate() {
        return true;
    }

    async resolve(url, options) {
        const run = (args) => ytdlpJson(url, args).catch((e) => {
            throw new DisTubeError('YTDLP_ERROR', `${e.stderr || e.message || e}`);
        });
        const args = playlistArgs(url);
        let info = await run(args);
        // A stale index can point past the end of a shortened list, it then loads from the top
        if (isPlaylist(info) && info.entries.length === 0 && args.includes('--playlist-items')) {
            info = await run(FLAT_ARGS);
        }

        if (isPlaylist(info)) {
            // yt-dlp leaves null for a track it couldn't read, one bad track shouldn't sink the list
            const entries = info.entries.filter(isTrackEntry);
            if (entries.length === 0) {
                const unplayable = info.entries.length > 0 && info.entries.every((entry) => entry && entry.ie_key === 'Youtube');
                throw new DisTubeError('YTDLP_ERROR', unplayable
                    ? 'Every video in that playlist is private or deleted'
                    : info.entries.length
                        ? 'That link lists other lists, not tracks, try its Videos tab or a playlist link'
                        : 'The playlist is empty');
            }
            const start = startVideoId(url);
            const at = start ? entries.findIndex((entry) => entry.id === start) : -1;
            return new Playlist({
                source: info.extractor,
                songs: [...entries.slice(Math.max(at, 0)), ...entries.slice(0, Math.max(at, 0))]
                    .map((entry) => buildSong(this, entry, options)),
                id: String(info.id),
                name: info.title,
                url: info.webpage_url,
                thumbnail: info.thumbnails && info.thumbnails[0] && info.thumbnails[0].url
            }, options);
        }
        return buildSong(this, info, options);
    }

    // DisTube only sends searches to extractor plugins, as a playable extractor this was never
    // called, so /play with a song name and every Spotify track found nothing
    async searchSong(query, options) {
        const search = /^ytsearch\d*:/i.test(query) ? query : `ytsearch1:${query}`;
        const info = await ytdlpJson(search, ['--flat-playlist']).catch((e) => {
            throw new DisTubeError('YTDLP_ERROR', `${e.stderr || e.message || e}`);
        });
        const entry = isPlaylist(info) ? info.entries.find(isTrackEntry) : info;
        return entry ? buildSong(this, entry, options) : null;
    }

    async getStreamURL(song) {
        if (!song.url) {
            throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream url from invalid song.');
        }
        const info = await ytdlpJson(song.url, ['--format', 'ba/ba*']).catch((e) => {
            throw new DisTubeError('YTDLP_ERROR', `${e.stderr || e.message || e}`);
        });
        if (isPlaylist(info)) {
            throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream URL of an entire playlist');
        }
        return info.url;
    }

    getRelatedSongs() {
        return [];
    }
}

module.exports = { YtDlpPlugin, ytdlpJson, playlistArgs, startVideoId, buildSong, stopProcess, YTDLP_PATH, YTDLP_TIMEOUT_MS, MAX_PLAYLIST_TRACKS };
