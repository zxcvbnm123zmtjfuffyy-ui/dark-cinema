import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils, Encoders } from '@dank074/discord-video-stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { PassThrough } from 'stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegStatic);

let client            = null;
let streamer          = null;
let isStreaming       = false;
let isReady           = false;
let currentFilePath   = null;
let activeCommand     = null;   // ffmpeg الرئيسي (prepareStream)
let preProcessCmd     = null;   // ffmpeg التمهيدي (-re)
let initPromise       = null;

// ─── تهيئة ─────────────────────────────────────────────────────────────────
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

// ─── Pre-process: يقرأ الفيديو بسرعته الطبيعية ويحوله لـ stream ────────────
// الفكرة: ffmpeg -re يقرأ بنفس FPS الفيديو الأصلي
// prepareStream ياكل من الـ stream هذا فيتحكم فيه التوقيت تلقائياً
function createRateLimitedStream(filePath) {
    const passthrough = new PassThrough({
        highWaterMark: 256 * 1024   // 256KB — backpressure يمنع ffmpeg يقرأ أسرع من playStream
    });

    const cmd = ffmpeg(filePath)
        .inputOption('-re')          // ← يقرأ بسرعة الفيديو الحقيقية (1x)
        .outputOptions([
            '-c:v copy',             // نسخ بدون إعادة تشفير = أقل CPU
            '-c:a copy',
            '-f mpegts',             // MPEG-TS مناسب للـ streaming
            '-muxdelay 0',
            '-muxpreload 0',
        ])
        .on('start', (cmd) => console.log('[pre-ffmpeg] بدأ:', cmd.slice(0, 80)))
        .on('error', (err) => {
            if (!err.message.includes('SIGKILL') && !err.message.includes('SIGTERM')) {
                console.error('[pre-ffmpeg] خطأ:', err.message);
            }
            passthrough.destroy();
        })
        .on('end', () => {
            console.log('[pre-ffmpeg] انتهى');
            passthrough.end();
            preProcessCmd = null;
        });

    cmd.pipe(passthrough, { end: false });
    preProcessCmd = cmd;

    return passthrough;
}

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(filePath, fileId) {
    console.log(`[startStream] ${filePath}`);

    if (isStreaming)               return { success: false, message: 'البث قيد التشغيل بالفعل' };
    if (!filePath)                 return { success: false, message: 'لا يوجد مسار فيديو' };
    if (!fs.existsSync(filePath))  return { success: false, message: `الملف غير موجود: ${filePath}` };

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;
    if (!guildId || !channelId) return { success: false, message: 'GUILD_ID أو CHANNEL_ID مفقودان' };

    try {
        if (!isReady) { console.log('🔄 إعادة الاتصال...'); await initClient(); }

        const guild = client.guilds.cache.get(guildId);
        if (!guild)             return { success: false, message: `السيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel)           return { success: false, message: `الروم غير موجود: ${channelId}` };
        if (!channel.isVoice()) return { success: false, message: `"${channel.name}" ليس روماً صوتياً` };

        // نظّف الحالة القديمة
        try { streamer.leaveVoice(); } catch {}
        await new Promise(r => setTimeout(r, 800));

        console.log(`🎧 ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ في الروم');

        // ── إنشاء الـ stream المقيّد بالسرعة الطبيعية ──
        console.log('⚙️ تجهيز stream بسرعة الفيديو الطبيعية...');
        const inputStream = createRateLimitedStream(filePath);

        // ── prepareStream يستقبل stream بدل مسار ملف ──
        const encoder = Encoders.software({
            x264: { preset: 'ultrafast' },
            x265: { preset: 'ultrafast' }
        });

        let command, output;
        try {
            const prepared = prepareStream(inputStream, {
                encoder,
                height:          720,
                frameRate:       30,
                bitrateVideo:    2500,
                bitrateVideoMax: 3000,
                videoCodec:      Utils.normalizeVideoCodec('H264'),
            });
            command = prepared.command;
            output  = prepared.output;
            console.log('✅ prepareStream جاهز');
        } catch (e) {
            console.error('❌ prepareStream:', e.message);
            // أوقف الـ pre-process لو فشل
            if (preProcessCmd) { try { preProcessCmd.kill(); } catch {} preProcessCmd = null; }
            return { success: false, message: `prepareStream فشل: ${e.message}` };
        }

        if (!output) {
            if (preProcessCmd) { try { preProcessCmd.kill(); } catch {} preProcessCmd = null; }
            return { success: false, message: 'output فارغ من prepareStream' };
        }

        command.on('error', (err, stdout, stderr) => {
            if (!err.message.includes('SIGKILL')) {
                console.error('❌ ffmpeg encode error:', err.message);
                if (stderr) console.error('stderr:', stderr.slice(-300));
            }
            isStreaming = false; activeCommand = null;
            deleteFile(currentFilePath);
        });

        command.on('start', (cmd) => console.log('[ffmpeg encode] بدأ:', cmd.slice(0, 80)));

        activeCommand   = command;
        currentFilePath = filePath;
        isStreaming     = true;

        playStream(output, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو');
                isStreaming = false; activeCommand = null;
                try { streamer.leaveVoice(); } catch {}
                deleteFile(currentFilePath);
            })
            .catch((e) => {
                if (!e.message?.includes('SIGKILL')) {
                    console.error('❌ playStream:', e.message);
                }
                isStreaming = false; activeCommand = null;
                try { streamer.leaveVoice(); } catch {}
                deleteFile(currentFilePath);
            });

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (error) {
        console.error('❌ startStream:', error.message);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── إيقاف البث ────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming && !activeCommand && !preProcessCmd) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }
    try {
        // أوقف الـ pre-process أولاً
        if (preProcessCmd) {
            try { preProcessCmd.kill('SIGKILL'); } catch {}
            preProcessCmd = null;
        }
        // ثم الـ encoder
        if (activeCommand) {
            try { activeCommand.kill('SIGKILL'); } catch {}
            activeCommand = null;
        }
        streamer.stopStream();
        isStreaming = false;
        try { streamer.leaveVoice(); } catch {}
        deleteFile(currentFilePath);
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (e) {
        isStreaming = false;
        return { success: false, message: e.message };
    }
}

function deleteFile(fp) {
    currentFilePath = null;
    if (fp && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); console.log(`🗑️ ${fp}`); }
        catch {}
    }
}

export function getStatus() {
    return { isStreaming, isReady, user: client?.user?.tag ?? null };
}
