import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { MediaManager } from 'dispertisex';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

let client = null;
let manager = null;
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
        manager = new MediaManager(client, {
            cacheDir: './cache',
            maxCacheFiles: 10
        });

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

export async function startBroadcast() {
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

        // الانضمام للروم الصوتي
        await channel.join();
        console.log(`🎧 تم الانضمام إلى: ${channel.name}`);

        // البث باستخدام dispertisex - واجهة واحدة لكل شيء
        await manager.play(channelId, VIDEO_FILE, {
            streamType: 'video',
            quality: '720p',
            youtubeDelivery: 'file'
        });

        isStreaming = true;
        console.log('🎥 بدأ البث بنجاح!');

        // مراقبة انتهاء البث
        manager.on('finish', () => {
            console.log('✅ انتهى البث');
            isStreaming = false;
        });

        manager.on('error', (err) => {
            console.error('❌ خطأ في البث:', err.message);
            isStreaming = false;
        });

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (err) {
        console.error('❌ startBroadcast error:', err.message);
        isStreaming = false;
        return { success: false, message: err.message };
    }
}

export async function stopBroadcast() {
    if (!isStreaming) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }

    try {
        await manager.stop({ leaveVoice: true });
        isStreaming = false;
        console.log('🛑 تم إيقاف البث');
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (err) {
        console.error('❌ stopBroadcast error:', err.message);
        return { success: false, message: err.message };
    }
}

export function getStatus() {
    return {
        isStreaming,
        isReady,
        user: client?.user?.tag ?? null,
        hasVideo: fs.existsSync(VIDEO_FILE)
    };
}
