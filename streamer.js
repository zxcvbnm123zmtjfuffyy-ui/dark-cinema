import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Encoders } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let client = null;
let streamer = null;
let isStreaming = false;
let isReady = false;
let currentProcessedDir = null;
let initPromise = null;

// ─── تهيئة الكلاينت ────────────────────────────────────────────────────────
async function initClient() {
    // لو الكلاينت شغال بالفعل ارجع مباشرة
    if (client && isReady) return true;

    // لو في عملية تهيئة قائمة انتظرها بدل ما تشغل واحدة ثانية
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) {
            initPromise = null;
            return reject(new Error('DISCORD_TOKEN غير موجود في ملف .env'));
        }

        client = new Client({ checkUpdate: false });

        client.once('ready', () => {
            console.log(`✅ Discord: تم تسجيل الدخول باسم ${client.user.tag}`);
            streamer = new Streamer(client);
            isReady = true;
            initPromise = null;
            resolve(true);
        });

        client.on('error', (err) => {
            console.error('❌ Discord error:', err.message);
            isReady = false;
        });

        client.on('disconnect', () => {
            console.warn('⚠️ Discord: انقطع الاتصال');
            isReady = false;
            isStreaming = false;
        });

        client.login(token).catch((err) => {
            console.error('❌ فشل تسجيل الدخول:', err.message);
            isReady = false;
            initPromise = null;
            reject(new Error(`فشل تسجيل الدخول: ${err.message}`));
        });
    });

    return initPromise;
}

// تهيئة عند تشغيل السيرفر
initClient().catch((err) => {
    console.error('⚠️ التهيئة المبدئية فشلت:', err.message);
});

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(videoUrl, processedDir) {
    if (isStreaming) {
        return { success: false, message: 'البث قيد التشغيل بالفعل' };
    }
    if (!videoUrl) {
        return { success: false, message: 'لا يوجد رابط فيديو' };
    }

    // تحقق من متغيرات البيئة
    const guildId = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;

    if (!guildId || !channelId) {
        return { success: false, message: 'GUILD_ID أو CHANNEL_ID غير موجودين في .env' };
    }

    try {
        // إعادة الاتصال لو انقطع
        if (!isReady) {
            console.log('🔄 إعادة تهيئة الاتصال...');
            await initClient();
        }

        // تحقق من السيرفر
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return { success: false, message: `السيرفر غير موجود. تأكد من GUILD_ID: ${guildId}` };
        }

        // تحقق من الروم
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            return { success: false, message: `الروم غير موجود. تأكد من CHANNEL_ID: ${channelId}` };
        }
        if (!channel.isVoice()) {
            return { success: false, message: `الروم "${channel.name}" ليس روماً صوتياً` };
        }

        console.log(`🎧 الانضمام إلى: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);

        console.log(`🎬 تجهيز البث من: ${videoUrl}`);

        const encoder = Encoders.software({ x264: { preset: 'ultrafast' } });

        let streamOutput;
        try {
            const prepared = prepareStream(videoUrl, {
                encoder,
                height: 720,
                frameRate: 30,
                bitrateVideo: 2500,
                videoCodec: 'H264'
            });
            streamOutput = prepared?.output;
        } catch (prepErr) {
            console.error('❌ فشل prepareStream:', prepErr.message);
            return { success: false, message: `فشل تجهيز الستريم: ${prepErr.message}` };
        }

        if (!streamOutput) {
            return { success: false, message: 'فشل تجهيز الستريم — output فارغ. تحقق من الفيديو والـ ffmpeg' };
        }

        currentProcessedDir = processedDir;
        isStreaming = true;

        playStream(streamOutput, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو.');
                isStreaming = false;
                cleanup();
            })
            .catch((err) => {
                console.error('❌ خطأ أثناء البث:', err.message);
                isStreaming = false;
                cleanup();
            });

        console.log('🎥 بدأ البث المباشر!');
        return { success: true, message: 'تم بدء البث بنجاح 🎥' };

    } catch (error) {
        console.error('❌ فشل البث:', error.message);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── إيقاف البث ────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }
    try {
        streamer.stopStream();
        isStreaming = false;
        cleanup();
        console.log('🛑 تم إيقاف البث');
        return { success: true, message: 'تم إيقاف البث' };
    } catch (error) {
        console.error('❌ خطأ في الإيقاف:', error.message);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── حذف الملفات المؤقتة ───────────────────────────────────────────────────
function cleanup() {
    if (currentProcessedDir && fs.existsSync(currentProcessedDir)) {
        try {
            fs.rmSync(currentProcessedDir, { recursive: true, force: true });
            console.log(`🗑️ تم حذف: ${currentProcessedDir}`);
        } catch (err) {
            console.warn('⚠️ فشل حذف الملفات المؤقتة:', err.message);
        }
        currentProcessedDir = null;
    }
}

// ─── الحالة ────────────────────────────────────────────────────────────────
export function getStatus() {
    return {
        isStreaming,
        isReady,
        user: client?.user?.tag ?? null
    };
}
