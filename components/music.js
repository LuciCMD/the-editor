// Handles button clicks on the now-playing control panel (customId prefix "music").

const v2 = require('../utils/componentsV2');
const volumeStore = require('../utils/volumeStore');
const musicEvents = require('../passives/musicEvents');

const VOLUME_STEP = 10;
const { PINK: ERROR_COLOR, AQUA: INFO_COLOR } = require('../utils/colors');
const MAX_QUEUE_LIST = 20;

function errorReply(interaction, body) {
    return v2.reply(interaction, {
        ephemeral: true,
        components: v2.infoPanel({ color: ERROR_COLOR, heading: 'Music', body })
    });
}

async function showQueue(interaction, queue) {
    const list = queue.songs
        .slice(0, MAX_QUEUE_LIST)
        .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.name || 'Unknown'} \`${s.formattedDuration}\``)
        .join('\n');
    const remaining = queue.songs.length - MAX_QUEUE_LIST;
    const more = remaining > 0 ? `\n…and ${remaining} more` : '';
    return v2.reply(interaction, {
        ephemeral: true,
        components: v2.infoPanel({ color: INFO_COLOR, heading: 'Music Queue', body: list + more })
    });
}

module.exports = {
    id: 'music',
    async execute(interaction, client) {
        const action = (interaction.customId || '').split(':')[1];
        const queue = client.distube.getQueue(interaction.guildId);

        if (!queue || queue.songs.length === 0) {
            return errorReply(interaction, 'Nothing is playing right now.');
        }

        // Require the user to share the bot's voice channel before controlling it.
        const userChannel = interaction.member && interaction.member.voice
            ? interaction.member.voice.channel
            : null;
        if (!userChannel || !queue.voiceChannel || userChannel.id !== queue.voiceChannel.id) {
            return errorReply(interaction, 'You must be in the same voice channel to control playback.');
        }

        if (action === 'queue') {
            return showQueue(interaction, queue);
        }

        // Actions that end playback: ack silently and let DisTube events remove
        // the panel. Actions that keep playing: refresh the panel in place.
        try {
            switch (action) {
                // pause and resume are async in DisTube 5, unawaited the panel showed the old state
                // They wait while DisTube looks up a track, often past Discord's 3 s, so the click is acked first
                // A second click landing first is harmless, the panel then shows the real state
                case 'playpause': {
                    await interaction.deferUpdate();
                    await (queue.paused ? queue.resume() : queue.pause()).catch((error) => {
                        if (error.errorCode !== 'PAUSED' && error.errorCode !== 'RESUMED') {
                            throw error;
                        }
                    });
                    // Stopped meanwhile, the deleteQueue handler removes the panel
                    if (client.distube.getQueue(interaction.guildId) !== queue || queue.songs.length === 0) {
                        return;
                    }
                    musicEvents.syncPanelAfterClick(queue, interaction.message);
                    const payload = v2.buildPayload({ components: musicEvents.buildNowPlayingPanel(queue) });
                    delete payload.flags; // editReply cannot change message flags
                    return interaction.editReply(payload);
                }

                case 'voldown':
                case 'volup': {
                    const delta = action === 'volup' ? VOLUME_STEP : -VOLUME_STEP;
                    const next = volumeStore.set(queue.id, queue.volume + delta);
                    queue.setVolume(next);
                    musicEvents.syncPanelAfterClick(queue, interaction.message);
                    return v2.update(interaction, { components: musicEvents.buildNowPlayingPanel(queue) });
                }

                case 'skip':
                    await interaction.deferUpdate();
                    if (queue.songs.length > 1) {
                        await musicEvents.skipSong(queue); // playSong event refreshes the panel
                    } else {
                        queue.stop(); // finish/disconnect event removes the panel
                    }
                    return;

                case 'stop':
                    await interaction.deferUpdate();
                    queue.stop();
                    return;

                default:
                    return errorReply(interaction, 'Unknown action.');
            }
        } catch (error) {
            console.error(`Music control "${action}" failed:`, error.message);
            if (!interaction.replied && !interaction.deferred) {
                return errorReply(interaction, 'That control failed. Please try again.');
            }
        }
    }
};
