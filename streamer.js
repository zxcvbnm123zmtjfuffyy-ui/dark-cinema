import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let client = null;
let streamer = null;
let isStreaming = false;
let isReady = false;
let currentProcessedDir = null;
let activeCommand = null;
let initPromise = null;

// ─── تهيئة الكلاينت ────────────────────────────────────────────────────────
async function initClient() {
    if (client && isReady) return true;
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const token = process.env.DISCORD_TOKEN;
        if (!token) {
            initPromise = null;
            return reject(new Error('DISCORD_TOKEN غير موجود في .env'));
        }

        client = new Client({ checkUpdate: false });
        streamer = new Streamer(client);

        client.once('ready', () => {
            console.log(`✅ Discord: تم الدخول باسم ${client.user.tag}`);
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
            initPromise = null;
            isReady = false;
            reject(new Error(`فشل تسجيل الدخول: ${err.message}`));
        });
    });

    return initPromise;
}

// تهيئة عند بدء السيرفر
initClient().catch((err) => console.error('⚠️ التهيئة الأولية:', err.message));

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(videoUrl, processedDir) {
    if (isStreaming) {
        return { success: false, message: 'البث قيد التشغيل بالفعل' };
    }
    if (!videoUrl) {
        return { success: false, message: 'لا يوجد رابط فيديو' };
    }

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;

    if (!guildId || !channelId) {
        return { success: false, message: 'GUILD_ID أو CHANNEL_ID غير موجودان في .env' };
    }

    try {
        // إعادة اتصال لو انقطع
        if (!isReady) {
            console.log('🔄 إعادة تهيئة الاتصال...');
            await initClient();
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return { success: false, message: `السيرفر غير موجود (GUILD_ID: ${guildId})` };
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            return { success: false, message: `الروم غير موجود (CHANNEL_ID: ${channelId})` };
        }
        if (!channel.isVoice()) {
            return { success: false, message: `"${channel.name}" ليس روماً صوتياً` };
        }

        console.log(`🎧 الانضمام إلى: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);

        console.log(`🎬 تجهيز البث: ${videoUrl}`);

        // ── الـ API الصحيح لـ @dank074/discord-video-stream ──
        let command, output;
        try {
            const prepared = prepareStream(videoUrl, {
                videoCodec:    Utils.normalizeVideoCodec('H264'),
                h26xPreset:    'ultrafast',
                height:        720,
                frameRate:     30,
                bitrateVideo:  2500,
                bitrateVideoMax: 3000,
                includeAudio:  true,
            });
            command = prepared.command;
            output  = prepared.output;
        } catch (prepErr) {
            console.error('❌ prepareStream فشل:', prepErr.message);
            return { success: false, message: `فشل تجهيز الستريم: ${prepErr.message}` };
        }

        if (!output) {
            return { success: false, message: 'فشل تجهيز الستريم — output فارغ' };
        }

        // ── مهم: أضف معالج أخطاء ffmpeg وإلا يصمت ──
        command.on('error', (err, stdout, stderr) => {
            console.error('❌ ffmpeg error:', err.message);
            console.error('ffmpeg stderr:', stderr);
            isStreaming = false;
            activeCommand = null;
            cleanup(currentProcessedDir);
        });

        activeCommand  = command;
        currentProcessedDir = processedDir;
        isStreaming = true;

        // playStream لا ينتظر — يعمل في الخلفية
        playStream(output, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو.');
                isStreaming = false;
                activeCommand = null;
                cleanup(currentProcessedDir);
            })
            .catch((err) => {
                console.error('❌ خطأ أثناء البث:', err.message);
                isStreaming = false;
                activeCommand = null;
                cleanup(currentProcessedDir);
            });

        console.log('🎥 بدأ البث!');
        return { success: true, message: '🎥 بدأ البث بنجاح!' };

    } catch (error) {
        console.error('❌ startStream error:', error.message);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── إيقاف البث ────────────────────────────────────────────────────────────
export async function stopStream() {
    if (!isStreaming && !activeCommand) {
        return { success: false, message: 'لا يوجد بث نشط' };
    }
    try {
        // أوقف ffmpeg أولاً
        if (activeCommand) {
            try { activeCommand.kill('SIGKILL'); } catch {}
            activeCommand = null;
        }
        // ثم أوقف الستريم
        streamer.stopStream();
        isStreaming = false;
        cleanup(currentProcessedDir);
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (error) {
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

// ─── حذف الملفات المؤقتة ───────────────────────────────────────────────────
function cleanup(dir) {
    currentProcessedDir = null;
    if (dir && fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`🗑️ حُذف: ${dir}`);
        } catch (e) {
            console.warn('⚠️ فشل الحذف:', e.message);
        }
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
