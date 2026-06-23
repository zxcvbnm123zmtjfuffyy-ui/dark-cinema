import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils, Encoders } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

let client = null;
let streamer = null;
let isStreaming = false;
let isReady = false;
let currentFile = null;
let activeCommand = null;
let initPromise = null;

const VIDEO_DIR = path.join(process.cwd(), 'video');
const VIDEO_FILE = path.join(VIDEO_DIR, 'episode.mp4');

async function initClient() {
    if (client && isReady) return true;
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) {
            initPromise = null;
            return reject(new Error('DISCORD_TOKEN مفقود'));
        }

        try {
            client = new Client({ checkUpdate: false });
            streamer = new Streamer(client);
        } catch (e) {
            initPromise = null;
            return reject(new Error(`Client: ${e.message}`));
        }

        client.once('ready', () => {
            console.log(`✅ Discord: ${client.user.tag}`);
            isReady = true;
            initPromise = null;
            resolve(true);
        });

        client.on('error', (e) => {
            console.error('❌ Discord error:', e.message);
            isReady = false;
        });

        client.on('disconnect', () => {
            isReady = false;
            isStreaming = false;
        });

        client.login(token).catch(e => {
            initPromise = null;
            isReady = false;
            reject(new Error(`فشل تسجيل الدخول: ${e.message}`));
        });
    });

    return initPromise;
}

initClient().catch(e => console.error('init error:', e.message));

function cleanup() {
    isStreaming = false;
    activeCommand = null;
    try { streamer?.leaveVoice(); } catch {}
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
        if (!isReady) await initClient();

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `سيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.isVoice()) {
            return { success: false, message: 'الروم غير موجود أو ليس صوتياً' };
        }

        try { streamer.leaveVoice(); } catch {}
        await new Promise(r => setTimeout(r, 500));

        console.log(`🎧 الانضمام إلى: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ تم الانضمام إلى الروم الصوتي');

        const encoder = Encoders.software({
            x264: { preset: 'ultrafast' }
        });

        const { command, output } = prepareStream(VIDEO_FILE, {
            encoder: encoder,
            height: 720,
            frameRate: 30,
            bitrateVideo: 2500,
            videoCodec: Utils.normalizeVideoCodec('H264'),
        });

        console.log('✅ prepareStream جاهز');
        activeCommand = command;

        command.on('error', (err) => {
            console.error('❌ ffmpeg error:', err.message);
            isStreaming = false;
            activeCommand = null;
        });

        command.on('start', (cmd) => {
            console.log('[ffmpeg]', cmd.slice(0, 150));
        });

        isStreaming = true;
        currentFile = VIDEO_FILE;

        await playStream(output, streamer, { type: 'go-live' });
        console.log('✅ انتهى الفيديو');
        isStreaming = false;

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (err) {
        console.error('❌ startBroadcast error:', err.message);
        isStreaming = false;
        return { success: false, message: err.message };
    }
}

export async function stopBroadcast() {
    if (!isStreaming && !activeCommand) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }

    console.log('[stopBroadcast] إيقاف البث...');

    try {
        if (activeCommand) {
            activeCommand.kill('SIGKILL');
            activeCommand = null;
        }
        try { streamer?.stopStream(); } catch {}
        try { streamer?.leaveVoice(); } catch {}
        isStreaming = false;
        console.log('✅ تم إيقاف البث');
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
        hasVideo: fs.existsSync(VIDEO_FILE),
        videoFile: VIDEO_FILE
    };
}
