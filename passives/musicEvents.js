// DisTube event wiring + the interactive "now playing" control panel.
//
// This is NOT an auto-loaded client passive (it has no `name`); app.js calls
// register(client) explicitly after DisTube is constructed. It listens to DisTube
// events and maintains one control-panel message per guild.

const { ButtonStyle } = require('discord.js');
const v2 = require('../utils/componentsV2');
const volumeStore = require('../utils/volumeStore');

// guildId -> the panel Message currently shown for that guild.
const panels = new Map();

const { AQUA: PLAYING_COLOR, PEACH: PAUSED_COLOR, PINK: ERROR_COLOR } = require('../utils/colors');
// About this many messages below it push the panel out of view
const BURIED_AFTER_MESSAGES = 3;

// guildId -> the panel work still running, so two events never post two panels
const panelWork = new Map();

// Discord refuses a text block over 4000 characters, then the panel stopped updating
const MAX_NAME_LENGTH = 200;
const MAX_LINK_LENGTH = 512;

// guilds with a click redraw already waiting, a burst of clicks needs only one
const clickRedraws = new Set();

// Cut by code point so an emoji on the cut isn't split in half
function shortName(name) {
    if (!name) {
        return 'Unknown';
    }
    const chars = Array.from(name);
    return chars.length > MAX_NAME_LENGTH ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join('')}…` : name;
}

function songTitle(song) {
    const name = `**${shortName(song.name)}**`;
    // A long direct media link would push the panel past the limit, the name alone is enough
    if (!song.url || song.url.length > MAX_LINK_LENGTH) {
        return name;
    }
    return `**[${shortName(song.name)}](${song.url})**`;
}

function logFailedDelete(error) {
    // Unknown Message means a user already deleted it, anything else leaves a dead panel up
    if (error.code !== 10008) {
        console.error('Could not delete the old music panel:', error.message);
    }
}

function buildNowPlayingPanel(queue) {
    if (!queue || !queue.songs || queue.songs.length === 0) {
        throw new Error('buildNowPlayingPanel requires a queue with songs');
    }
    const song = queue.songs[0];
    const paused = queue.paused;

    const lines = [
        `## ${paused ? '⏸️ Paused' : '🎵 Now Playing'}`,
        songTitle(song),
        `\`${song.formattedDuration}\`${song.uploader && song.uploader.name ? ` • ${shortName(song.uploader.name)}` : ''}`,
        `🔊 Volume: **${queue.volume}%**`
    ];

    // One line whatever the queue length, so the buttons stay put, the Queue button lists the rest
    if (queue.songs.length > 1) {
        const remaining = queue.songs.length - 2;
        const more = remaining > 0 ? ` · ${remaining} more` : '';
        lines.push(`⏭️ Up Next: **${shortName(queue.songs[1].name)}**${more}`);
    }

    const heading = lines.join('\n');
    const components = [];
    if (song.thumbnail) {
        components.push(v2.section({ texts: [heading], thumbnail: song.thumbnail }));
    } else {
        components.push(v2.textDisplay(heading));
    }
    components.push(v2.separator());
    components.push(v2.buttonRow(
        v2.button({ id: 'music:playpause', emoji: paused ? '▶️' : '⏸️', label: paused ? 'Resume' : 'Pause', style: ButtonStyle.Primary }),
        v2.button({ id: 'music:skip', emoji: '⏭️', label: 'Skip' }),
        v2.button({ id: 'music:stop', emoji: '⏹️', label: 'Stop', style: ButtonStyle.Danger })
    ));
    components.push(v2.buttonRow(
        v2.button({ id: 'music:voldown', emoji: '🔉', label: 'Vol -' }),
        v2.button({ id: 'music:volup', emoji: '🔊', label: 'Vol +' }),
        v2.button({ id: 'music:queue', emoji: '📜', label: 'Queue' })
    ));

    return v2.container({ color: paused ? PAUSED_COLOR : PLAYING_COLOR, components });
}

// Runs panel work for one guild in order, an edit and a repost racing left two panels
function queuePanelWork(guildId, work) {
    const run = (panelWork.get(guildId) || Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    panelWork.set(guildId, settled);
    settled.then(() => {
        if (panelWork.get(guildId) === settled) {
            panelWork.delete(guildId);
        }
    });
    return run;
}

async function isBuried(message) {
    try {
        const below = await message.channel.messages.fetch({ after: message.id, limit: BURIED_AFTER_MESSAGES });
        return below.size >= BURIED_AFTER_MESSAGES;
    } catch (error) {
        // Without Read Message History the panel is edited where it is
        console.error('Could not check the music panel position:', error.message);
        return false;
    }
}

async function drawPanel(queue, repostIfBuried) {
    if (!queue.songs || queue.songs.length === 0) {
        return;
    }
    const existing = panels.get(queue.id);
    const buried = Boolean(existing) && repostIfBuried && await isBuried(existing);
    // Built after the position check, a Pause or volume click during it was drawn over
    // and outside the edit's catch, a build error there was taken for a deleted panel
    const payload = v2.buildPayload({ components: buildNowPlayingPanel(queue) });
    if (existing && !buried) {
        try {
            await existing.edit(payload);
            return;
        } catch (error) {
            // Panel message was deleted, post a new one
            panels.delete(queue.id);
        }
    }
    try {
        const message = await queue.textChannel.send(payload);
        panels.set(queue.id, message);
    } catch (error) {
        console.error('Failed to post music panel:', error.message);
        return;
    }
    // Old one goes after the new one is up, so there's never a moment without controls
    if (existing && panels.get(queue.id) !== existing) {
        await existing.delete().catch(logFailedDelete);
    }
}

// Post a fresh panel or edit the existing one in place
// With repostIfBuried a panel that has scrolled away is posted again at the bottom
function refreshPanel(queue, { repostIfBuried = false } = {}) {
    if (!queue || !queue.textChannel) {
        return Promise.resolve();
    }
    return queuePanelWork(queue.id, () => drawPanel(queue, repostIfBuried));
}

function removePanel(guildId) {
    return queuePanelWork(guildId, async () => {
        const message = panels.get(guildId);
        panels.delete(guildId);
        if (message) {
            await message.delete().catch(logFailedDelete);
        }
    });
}

function applySavedVolume(queue) {
    const saved = volumeStore.get(queue.id);
    if (typeof saved === 'number' && queue.volume !== saved) {
        try {
            queue.setVolume(saved);
        } catch (error) {
            console.error('Failed to apply saved volume:', error.message);
        }
    }
}

// A paused player that gets stop() stays paused, silence padding only drains while playing,
// and DisTube won't start a new song on a paused player, so the next queue started silent
function releasePlayer(queue) {
    try {
        if (queue.voice) {
            queue.voice.stop(true);
        }
    } catch (error) {
        console.error('Failed to reset the music player:', error.message);
    }
}

// AudioPlayer.pause only works while playing, so a Pause clicked between songs or while one buffers
// set the queue's flag but the song played anyway, the pause is applied once audio starts instead
const heldPlayers = new WeakSet();

function holdPause(dt, queue) {
    const player = queue.voice && queue.voice.audioPlayer;
    if (!player || heldPlayers.has(player)) {
        return;
    }
    heldPlayers.add(player);
    player.on('stateChange', (oldState, newState) => {
        const current = dt.getQueue(queue.id);
        if (newState.status === 'playing' && current && current.paused && current.voice.audioPlayer === player) {
            player.pause();
        }
    });
}

// DisTube's skip ends the song with a soft stop, a paused player ignores it so Skip did nothing
// until Resume, and a Pause landing in the silence right after a Skip froze it the same way
// Two skips at once both see paused, the second resume finds it playing and that's fine
async function skipSong(queue) {
    if (queue.paused) {
        await queue.resume().catch((error) => {
            if (error.errorCode !== 'RESUMED') {
                throw error;
            }
        });
    }
    await queue.skip();
    releasePlayer(queue);
}

function register(client) {
    if (!client || !client.distube) {
        throw new Error('register requires a client with DisTube initialized');
    }
    const dt = client.distube;

    dt.on('initQueue', (queue) => holdPause(dt, queue));
    dt.on('playSong', (queue) => {
        applySavedVolume(queue);
        refreshPanel(queue, { repostIfBuried: true }).catch(err => console.error('panel(playSong):', err.message));
    });
    dt.on('addSong', (queue) => {
        refreshPanel(queue).catch(err => console.error('panel(addSong):', err.message));
    });
    dt.on('addList', (queue) => {
        refreshPanel(queue).catch(err => console.error('panel(addList):', err.message));
    });
    dt.on('finish', (queue) => {
        removePanel(queue.id).catch(() => {});
    });
    dt.on('disconnect', (queue) => {
        removePanel(queue.id).catch(() => {});
    });
    dt.on('empty', (queue) => {
        removePanel(queue.id).catch(() => {});
    });
    dt.on('deleteQueue', (queue) => {
        removePanel(queue.id).catch(() => {});
        releasePlayer(queue);
    });
    dt.on('error', (error, queue) => {
        console.error('DisTube error:', error && error.message ? error.message : error);
        if (queue && queue.textChannel) {
            v2.send(queue.textChannel, {
                components: v2.infoPanel({
                    color: ERROR_COLOR,
                    heading: 'Music Error',
                    body: 'Something went wrong while playing that track. It may be unavailable or region-locked.'
                })
            }).catch(() => {});
        }
    });

    // MUSIC_DEBUG=1 logs every DisTube and ffmpeg step, otherwise a stuck play leaves no trace
    if (process.env.MUSIC_DEBUG === '1') {
        dt.on('debug', (message) => console.log('[music]', message));
        dt.on('ffmpegDebug', (message) => console.log('[ffmpeg]', message));
        console.log('Music debug logging on.');
    }

    console.log('Music event handlers registered.');
}

// A click edits the message it came from, if that was an old panel or a repost was under way
// the panel left showing may predate the click, so it's redrawn after the panel work
function syncPanelAfterClick(queue, message) {
    const current = panels.get(queue.id);
    const stale = Boolean(current && message && current.id !== message.id);
    if (!queue.textChannel || !(stale || panelWork.has(queue.id)) || clickRedraws.has(queue.id)) {
        return;
    }
    clickRedraws.add(queue.id);
    queuePanelWork(queue.id, () => {
        // Cleared as it starts, so a click after this point still gets drawn
        clickRedraws.delete(queue.id);
        return drawPanel(queue, false);
    }).catch((error) => console.error('panel(click):', error.message));
}

module.exports = { register, refreshPanel, removePanel, buildNowPlayingPanel, releasePlayer, skipSong, syncPanelAfterClick };
