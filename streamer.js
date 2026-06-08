import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils, Encoders } from '@dank074/discord-video-stream';
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegStatic);

let client          = null;
let streamer        = null;
let isStreaming     = false;
let isReady         = false;
let currentFile     = null;
let activeCommand   = null;
let preProcess      = null;   // ffmpeg التحويل المسبق
let initPromise     = null;

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
            return reject(new Error(`Client error: ${e.message}`));
        }

        client.once('ready', () => {
            console.log(`✅ Discord: ${client.user.tag}`);
            isReady = true; initPromise = null; resolve(true);
        });
        client.on('error',      e  => { console.error('❌ Discord:', e.message); isReady = false; });
        client.on('disconnect', () => { isReady = false; isStreaming = false; });
        client.login(token).catch(e => {
            initPromise = null; isReady = false;
            reject(new Error(`فشل تسجيل الدخول: ${e.message}`));
        });
    });

    return initPromise;
}

initClient().catch(e => console.error('init error:', e.message));

// ─── المشكلة الحقيقية ──────────────────────────────────────────────────────
// الـ native demuxer في المكتبة يفشل مع ملفات mp4 معينة:
// "Received an error during frame extraction. Stopping"
//
// الحل: نحوّل الملف إلى MPEG-TS عبر ffmpeg أولاً ونمرره كـ stream
// عندما prepareStream يستقبل stream تستخدم ffmpeg بدل native demuxer
// ─────────────────────────────────────────────────────────────────────────────
function createInputStream(filePath) {
    const pass = new PassThrough({ highWaterMark: 512 * 1024 });

    const cmd = ffmpeg(filePath)
        .inputOption('-re')              // قراءة بسرعة الفيديو الطبيعية
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
            '-profile:v baseline',      // H264 Baseline — أكثر توافقية
            '-preset ultrafast',
            '-pix_fmt yuv420p',
            '-bf 0',                    // بدون B-frames
            '-g 30',                    // keyframe كل ثانية
            '-ar 48000',
            '-f mpegts',                // MPEG-TS مناسب للـ stream
        ])
        .on('start',  c   => console.log('[pre-ffmpeg] بدأ:', c.slice(0, 100)))
        .on('error',  err => {
            if (!err.message.includes('SIGKILL')) console.error('[pre-ffmpeg] error:', err.message);
            pass.destroy();
        })
        .on('end', () => { console.log('[pre-ffmpeg] انتهى'); pass.end(); });

    cmd.pipe(pass, { end: false });
    preProcess = cmd;
    return pass;
}

// ─── تنظيف ─────────────────────────────────────────────────────────────────
function cleanup(filePath) {
    isStreaming   = false;
    activeCommand = null;
    preProcess    = null;

    try { streamer.leaveVoice(); } catch {}

    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); console.log(`🗑️ ${filePath}`); } catch {}
    }
    if (currentFile === filePath) currentFile = null;
}

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(filePath) {
    console.log(`[startStream] ${filePath}`);

    if (isStreaming)               return { success: false, message: 'بث قيد التشغيل' };
    if (!filePath)                 return { success: false, message: 'لا يوجد فيديو' };
    if (!fs.existsSync(filePath))  return { success: false, message: `ملف غير موجود: ${filePath}` };

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;
    if (!guildId || !channelId) return { success: false, message: 'GUILD_ID أو CHANNEL_ID مفقودان' };

    try {
        if (!isReady) await initClient();

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `سيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel)           return { success: false, message: `روم غير موجود: ${channelId}` };
        if (!channel.isVoice()) return { success: false, message: `"${channel.name}" ليس صوتياً` };

        try { streamer.leaveVoice(); } catch {}
        await new Promise(r => setTimeout(r, 800));

        console.log(`🎧 ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ في الروم');

        // ── إنشاء stream متوافق بدل تمرير الملف مباشرة ──────────────────
        // هذا يتجاوز الـ native demuxer الذي يفشل مع بعض ملفات mp4
        const inputStream = createInputStream(filePath);

        const encoder = Encoders.software({
            x264: { preset: 'ultrafast' },
            x265: { preset: 'ultrafast' }
        });

        let command, output;
        try {
            ({ command, output } = prepareStream(inputStream, {
                encoder,
                height:          720,
                frameRate:       30,
                bitrateVideo:    2500,
                bitrateVideoMax: 3000,
                videoCodec:      Utils.normalizeVideoCodec('H264'),
            }));
            console.log('✅ prepareStream جاهز');
        } catch (e) {
            console.error('❌ prepareStream:', e.message);
            if (preProcess) { try { preProcess.kill(); } catch {} preProcess = null; }
            return { success: false, message: `prepareStream: ${e.message}` };
        }

        command.on('error', (err, _o, stderr) => {
            if (!err.message.includes('SIGKILL')) {
                console.error('❌ ffmpeg encode:', err.message);
                if (stderr) console.error('stderr:', stderr.slice(-200));
            }
            cleanup(currentFile);
        });

        currentFile   = filePath;
        activeCommand = command;
        isStreaming   = true;
        console.log('🎥 البث بدأ (pre-process MPEG-TS → prepareStream)');

        playStream(output, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو');
                cleanup(currentFile);
            })
            .catch(e => {
                if (!e?.message?.includes('SIGKILL')) console.error('❌ playStream:', e.message);
                cleanup(currentFile);
            });

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (err) {
        console.error('❌ startStream:', err.message);
        isStreaming = false;
        return { success: false, message: err.message };
    }
}

// ─── إيقاف ─────────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming && !activeCommand && !preProcess)
        return { success: false, message: 'لا بث نشط' };

    const f = currentFile;
    try {
        if (preProcess)    { try { preProcess.kill('SIGKILL');    } catch {} preProcess    = null; }
        if (activeCommand) { try { activeCommand.kill('SIGKILL'); } catch {} activeCommand = null; }
        try { streamer.stopStream(); } catch {}
        cleanup(f);
        return { success: true, message: '🛑 توقف البث' };
    } catch (e) {
        isStreaming = false;
        return { success: false, message: e.message };
    }
}

export function getStatus() {
    return { isStreaming, isReady, user: client?.user?.tag ?? null };
}
