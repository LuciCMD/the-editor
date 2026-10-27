const { MessageFlags } = require('discord.js');
const v2 = require('../../utils/componentsV2');

const { AQUA: PLAY_COLOR, PINK: ERROR_COLOR } = require('../../utils/colors');

module.exports = {
    data: {
        name: 'play',
        description: 'Plays a song from YouTube or Spotify.',
        options: [
            {
                name: 'song',
                type: 3, // STRING
                description: 'A URL, or search terms to look up on YouTube.',
                required: true
            }
        ]
    },

    async execute(interaction, client) {
        const song = interaction.options.getString('song');
        const voiceChannel = interaction.member && interaction.member.voice
            ? interaction.member.voice.channel
            : null;

        if (!voiceChannel) {
            return v2.reply(interaction, {
                ephemeral: true,
                components: v2.infoPanel({
                    color: ERROR_COLOR,
                    heading: 'Play Music',
                    body: 'You need to be in a voice channel to play music!'
                })
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Plain text goes to DisTube as is, it searches YouTube through the yt-dlp plugin
        const query = song.trim();

        try {
            await client.distube.play(voiceChannel, query, {
                textChannel: interaction.channel,
                member: interaction.member
            });
            await interaction.editReply({
                content: `🎶 Queued **${song}** — controls are on the player below.`
            });
        } catch (error) {
            console.error('Error playing song:', error);
            await interaction.editReply({
                content: '❌ Could not play that. The track may be unavailable, region-locked, or the search returned nothing.'
            });
        }
    }
};
