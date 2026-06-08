import { WebSocket } from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'djs-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils, Encoders } from '@dank074/discord-video-stream';
import { Transform } from 'stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// ─── ByteRateThrottle ──────────────────────────────────────────────────────
// المشكلة: playStream ترسل كل البيانات دفعة واحدة لـ Discord
// الحل:    نقسم كل chunk إلى قطع صغيرة (8KB) ونرسلها بتوقيت منتظم
// مثال:    450KB/s مع قطع 8KB = قطعة كل ~17ms ≈ إيقاع 30fps
class ByteRateThrottle extends Transform {
    constructor(bytesPerSecond) {
        super();
        this.bps       = bytesPerSecond;
        this.startTime = null;
        this.total     = 0;
        this.PIECE     = 8 * 1024; // 8KB قطعة
    }

    _transform(chunk, enc, cb) {
        if (!this.startTime) this.startTime = Date.now();

        // قسّم الـ chunk الكبير إلى قطع 8KB
        const pieces = [];
        for (let i = 0; i < chunk.length; i += this.PIECE) {
            pieces.push(chunk.slice(i, Math.min(i + this.PIECE, chunk.length)));
        }

        let idx = 0;
        const sendNext = () => {
            if (idx >= pieces.length) { cb(); return; }
            const piece = pieces[idx++];
            this.total += piece.length;

            const targetMs = (this.total / this.bps) * 1000;
            const elapsed  = Date.now() - this.startTime;
            const delay    = Math.max(0, targetMs - elapsed);

            setTimeout(() => { this.push(piece); sendNext(); }, delay);
        };
        sendNext();
    }

    _flush(cb) { cb(); }
}

let client         = null;
let streamer       = null;
let isStreaming    = false;
let isReady        = false;
let currentFile    = null;
let activeCommand  = null;
let activeThrottle = null;
let initPromise    = null;

// ─── تهيئة الكلاينت (مرة واحدة طول عمر السيرفر) ──────────────────────────
async function initClient() {
    if (client && isReady) return true;
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) {
            initPromise = null;
            return reject(new Error('DISCORD_TOKEN مفقود في .env'));
        }

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
        client.on('error', (e) => {
            console.error('❌ Discord error:', e.message);
            isReady = false;
        });
        client.on('disconnect', () => {
            console.warn('⚠️ Discord disconnect');
            isReady = false;
            isStreaming = false;
        });
        client.login(token).catch((e) => {
            initPromise = null;
            isReady = false;
            reject(new Error(`فشل تسجيل الدخول: ${e.message}`));
        });
    });

    return initPromise;
}

initClient().catch((e) => console.error('⚠️ init error:', e.message));

// ─── تنظيف الحالة بعد كل بث ───────────────────────────────────────────────
function resetState(filePath) {
    isStreaming    = false;
    activeCommand  = null;
    activeThrottle = null;

    // اخرج من الروم بعد الانتهاء
    try { streamer.leaveVoice(); } catch {}

    // احذف الملف المؤقت
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); console.log(`🗑️ حُذف: ${filePath}`); }
        catch {}
    }

    // اعدّل currentFile فقط لو ما تغير (race condition prevention)
    if (currentFile === filePath) currentFile = null;
}

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(filePath) {
    console.log(`[startStream] ${filePath}`);

    if (isStreaming)               return { success: false, message: 'بث قيد التشغيل بالفعل' };
    if (!filePath)                 return { success: false, message: 'لا يوجد مسار فيديو' };
    if (!fs.existsSync(filePath))  return { success: false, message: `الملف غير موجود: ${filePath}` };

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;
    if (!guildId || !channelId)
        return { success: false, message: 'GUILD_ID أو CHANNEL_ID مفقودان في .env' };

    try {
        // إعادة اتصال إن انقطع
        if (!isReady) {
            console.log('🔄 إعادة الاتصال...');
            await initClient();
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `السيرفر غير موجود: ${guildId}` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel)           return { success: false, message: `الروم غير موجود: ${channelId}` };
        if (!channel.isVoice()) return { success: false, message: `"${channel.name}" ليس روماً صوتياً` };

        // نظّف أي بث قديم قبل البدء
        try { streamer.leaveVoice(); } catch {}
        await new Promise(r => setTimeout(r, 800));

        console.log(`🎧 الانضمام: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ في الروم');

        // ── prepareStream بالـ API الصحيح ──────────────────────────────────
        const encoder = Encoders.software({
            x264: { preset: 'ultrafast' },
            x265: { preset: 'ultrafast' }
        });

        let command, output;
        try {
            ({ command, output } = prepareStream(filePath, {
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
            return { success: false, message: `prepareStream فشل: ${e.message}` };
        }

        if (!output) return { success: false, message: 'output فارغ من prepareStream' };

        // سجّل أخطاء ffmpeg
        command.on('error', (err, _stdout, stderr) => {
            if (!err.message.includes('SIGKILL') && !err.message.includes('SIGTERM')) {
                console.error('❌ ffmpeg error:', err.message);
                if (stderr) console.error('ffmpeg stderr:', stderr.slice(-300));
            }
            resetState(currentFile);
        });
        command.on('start', (cmd) => console.log('[ffmpeg] بدأ:', cmd.slice(0, 100)));

        // ── ByteRateThrottle ────────────────────────────────────────────────
        // 2500 kbps video + 128 kbps audio = 2628 kbps
        // + 20% overhead = ~3160 kbps = ~395 KB/s
        // نستخدم 450 KB/s هامش مريح
        const throttle = new ByteRateThrottle(450 * 1024);
        const throttledOutput = output.pipe(throttle);

        // سجّل الحالة
        currentFile    = filePath;
        activeCommand  = command;
        activeThrottle = throttle;
        isStreaming    = true;
        console.log('🎥 بدأ البث عبر ByteRateThrottle @ 450KB/s');

        // playStream تستقبل الـ stream المقيّد وترسله لـ Discord
        playStream(throttledOutput, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو بشكل طبيعي');
                resetState(currentFile);
            })
            .catch((e) => {
                if (!e?.message?.includes('SIGKILL') && !e?.message?.includes('SIGTERM')) {
                    console.error('❌ playStream error:', e.message);
                }
                resetState(currentFile);
            });

        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (error) {
        console.error('❌ startStream unexpected:', error.message, error.stack);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── إيقاف البث ────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming && !activeCommand) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }

    const fileToDelete = currentFile; // احفظ القيمة قبل reset

    try {
        // أوقف ffmpeg
        if (activeCommand) {
            try { activeCommand.kill('SIGKILL'); } catch {}
            activeCommand = null;
        }

        // أوقف الـ throttle
        if (activeThrottle) {
            try { activeThrottle.destroy(); } catch {}
            activeThrottle = null;
        }

        // أوقف البث في Discord
        try { streamer.stopStream(); } catch {}

        resetState(fileToDelete);
        return { success: true, message: '🛑 تم إيقاف البث' };

    } catch (e) {
        console.error('❌ stopStream error:', e.message);
        isStreaming = false;
        return { success: false, message: e.message };
    }
}

// ─── حالة البث ─────────────────────────────────────────────────────────────
export function getStatus() {
    return {
        isStreaming,
        isReady,
        user: client?.user?.tag ?? null
    };
}
