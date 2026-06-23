const { Client } = require('djs-selfbot-v13');
const { Streamer } = require('@dank074/discord-video-stream');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

let client = null;
let streamer = null;
let connection = null;
let player = null;
let isStreaming = false;
let isReady = false;

const VIDEO_DIR = path.join(process.cwd(), 'video');
const VIDEO_FILE = path.join(VIDEO_DIR, 'episode.mp4');

async function initClient() {
    if (client && isReady) return true;

    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN مفقود');

    try {
        client = new Client({ checkUpdate: false });
        streamer = new Streamer(client);

        await new Promise((resolve, reject) => {
            client.once('ready', () => {
                console.log(`✅ Discord: ${client.user.tag}`);
                isReady = true;
                resolve();
            });
            client.on('error', reject);
            client.login(token).catch(reject);
        });

        return true;
    } catch (err) {
        console.error('❌ فشل التهيئة:', err.message);
        throw err;
    }
}

async function startBroadcast() {
    console.log('[startBroadcast] بدء البث...');

    if (isStreaming) return { success: false, message: 'بث جاري بالفعل' };
    if (!fs.existsSync(VIDEO_FILE)) {
        return { success: false, message: `الملف غير موجود: ${VIDEO_FILE}` };
    }

    const guildId = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;
    if (!guildId || !channelId) {
        return { success: false, message: 'GUILD_ID / CHANNEL_ID مفقود' };
    }

    try {
        await initClient();

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `سيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.isVoice()) {
            return { success: false, message: 'الروم غير موجود أو ليس صوتياً' };
        }

        // محاولة الدخول عبر Streamer (طريقة البث المباشر)
        try {
            await streamer.joinVoice(guildId, channelId);
            console.log(`🎧 تم الانضمام إلى: ${channel.name} (via Streamer)`);
            
            // تجهيز البث باستخدام @dank074/discord-video-stream
            const { prepareStream, playStream, Utils } = require('@dank074/discord-video-stream');
            const { command, output } = prepareStream(VIDEO_FILE, {
                videoCodec: 'H264',
                width: 1280,
                height: 720,
                frameRate: 30,
                bitrateVideo: 2500,
                bitrateVideoMax: 3000,
                includeAudio: true,
                h26xPreset: 'ultrafast'
            });

            console.log('✅ prepareStream جاهز');

            command.on('error', (err) => {
                console.error('❌ ffmpeg error:', err.message);
                isStreaming = false;
            });

            command.on('start', (cmd) => {
                console.log('[ffmpeg]', cmd.slice(0, 150));
            });

            isStreaming = true;
            await playStream(output, streamer, { type: 'go-live' });
            console.log('🎥 بدأ البث بنجاح! (via Streamer)');
            
            return { success: true, message: '🎥 بدأ البث بنجاح!' };

        } catch (streamerError) {
            console.warn('⚠️ Streamer failed, falling back to @discordjs/voice:', streamerError.message);
            
            // الطريقة البديلة: @discordjs/voice (صوت فقط)
            connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });

            console.log(`🎧 تم الانضمام إلى: ${channel.name} (via @discordjs/voice)`);

            player = createAudioPlayer();
            connection.subscribe(player);

            const resource = createAudioResource(VIDEO_FILE, {
                inlineVolume: true,
                metadata: { title: path.basename(VIDEO_FILE) }
            });

            player.play(resource);
            isStreaming = true;

            player.on(AudioPlayerStatus.Idle, () => {
                console.log('✅ انتهى التشغيل');
                isStreaming = false;
            });

            player.on('error', (err) => {
                console.error('❌ خطأ في التشغيل:', err.message);
                isStreaming = false;
            });

            console.log('🎥 بدأ التشغيل بنجاح! (via @discordjs/voice)');
            return { success: true, message: '🎥 بدأ التشغيل بنجاح!' };
        }

    } catch (err) {
        console.error('❌ startBroadcast error:', err.message);
        isStreaming = false;
        return { success: false, message: err.message };
    }
}

async function stopBroadcast() {
    if (!isStreaming) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }

    try {
        // إيقاف Streamer
        try { streamer?.stopStream(); } catch {}
        try { streamer?.leaveVoice(); } catch {}

        // إيقاف @discordjs/voice
        if (player) {
            player.stop();
            player = null;
        }
        if (connection) {
            connection.destroy();
            connection = null;
        }

        isStreaming = false;
        console.log('🛑 تم إيقاف البث');
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (err) {
        console.error('❌ stopBroadcast error:', err.message);
        return { success: false, message: err.message };
    }
}

function getStatus() {
    return {
        isStreaming,
        isReady,
        user: client?.user?.tag ?? null,
        hasVideo: fs.existsSync(VIDEO_FILE)
    };
}

module.exports = { startBroadcast, stopBroadcast, getStatus };
