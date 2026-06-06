import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let client    = null;
let streamer  = null;
let isStreaming      = false;
let isReady          = false;
let currentFileId    = null;
let currentFilePath  = null;
let activeCommand    = null;
let initPromise      = null;

// ─── تهيئة الكلاينت ────────────────────────────────────────────────────────
async function initClient() {
    if (client && isReady) return true;
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) { initPromise = null; return reject(new Error('DISCORD_TOKEN مفقود')); }

        try {
            client   = new Client({ checkUpdate: false });
            streamer = new Streamer(client);
        } catch (e) {
            initPromise = null;
            return reject(new Error(`فشل إنشاء Client: ${e.message}`));
        }

        client.once('ready', () => {
            console.log(`✅ Discord: ${client.user.tag}`);
            isReady = true; initPromise = null;
            resolve(true);
        });
        client.on('error',      (e) => { console.error('❌ Discord:', e.message); isReady = false; });
        client.on('disconnect', ()  => { console.warn('⚠️ انقطع'); isReady = false; isStreaming = false; });
        client.login(token).catch((e) => {
            initPromise = null; isReady = false;
            reject(new Error(`فشل تسجيل الدخول: ${e.message}`));
        });
    });

    return initPromise;
}

initClient().catch((e) => console.error('⚠️ init:', e.message));

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(filePath, fileId) {
    console.log(`[startStream] filePath=${filePath}`);

    if (isStreaming) return { success: false, message: 'البث قيد التشغيل بالفعل' };
    if (!filePath)   return { success: false, message: 'لا يوجد مسار فيديو' };
    if (!fs.existsSync(filePath)) return { success: false, message: `الملف غير موجود: ${filePath}` };

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;
    if (!guildId || !channelId) return { success: false, message: 'GUILD_ID أو CHANNEL_ID مفقودان' };

    try {
        if (!isReady) { console.log('🔄 إعادة الاتصال...'); await initClient(); }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `السيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel)        return { success: false, message: `الروم غير موجود: ${channelId}` };
        if (!channel.isVoice()) return { success: false, message: `"${channel.name}" ليس صوتياً` };

        console.log(`🎧 الانضمام: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ انضم للروم');

        // ── تحديد codec ──
        let videoCodec;
        try {
            videoCodec = Utils?.normalizeVideoCodec
                ? Utils.normalizeVideoCodec('H264')
                : (Utils?.VideoCodec?.H264 ?? 'H264');
        } catch { videoCodec = 'H264'; }
        console.log(`[debug] videoCodec=${videoCodec}`);

        // ── prepareStream من الملف الخام مباشرة ──
        let command, output;
        try {
            const prepared = prepareStream(filePath, {
                width:           1280,
                height:          720,
                frameRate:       30,
                bitrateVideo:    2500,
                bitrateVideoMax: 3000,
                videoCodec,
                h26xPreset:      'ultrafast',
                includeAudio:    true,
            });
            command = prepared.command;
            output  = prepared.output;
            console.log('[debug] prepareStream نجح');
        } catch (e) {
            console.error('❌ prepareStream:', e.message);
            return { success: false, message: `prepareStream فشل: ${e.message}` };
        }

        if (!output) return { success: false, message: 'output فارغ من prepareStream' };

        if (command) {
            command.on('error', (err, stdout, stderr) => {
                console.error('❌ ffmpeg:', err.message);
                if (stderr) console.error('stderr:', stderr.slice(-300));
                isStreaming = false; activeCommand = null;
                deleteFile(currentFilePath);
            });
            command.on('start', (cmd) => console.log('[ffmpeg] start:', cmd.slice(0, 120)));
        }

        activeCommand   = command;
        currentFilePath = filePath;
        currentFileId   = fileId;
        isStreaming     = true;

        playStream(output, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو.');
                isStreaming = false; activeCommand = null;
                deleteFile(currentFilePath);
            })
            .catch((e) => {
                console.error('❌ playStream:', e.message);
                isStreaming = false; activeCommand = null;
                deleteFile(currentFilePath);
            });

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (error) {
        console.error('❌ startStream:', error.message, error.stack);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── إيقاف البث ────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming && !activeCommand) return { success: false, message: 'لا يوجد بث نشط' };
    try {
        if (activeCommand) { try { activeCommand.kill('SIGKILL'); } catch {} activeCommand = null; }
        streamer.stopStream();
        isStreaming = false;
        deleteFile(currentFilePath);
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (e) {
        isStreaming = false;
        return { success: false, message: e.message };
    }
}

// ─── حذف الفيديو بعد الانتهاء ─────────────────────────────────────────────
function deleteFile(fp) {
    currentFilePath = null; currentFileId = null;
    if (fp && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); console.log(`🗑️ حُذف: ${fp}`); }
        catch (e) { console.warn('⚠️ فشل الحذف:', e.message); }
    }
}

export function getStatus() {
    return { isStreaming, isReady, user: client?.user?.tag ?? null };
}
