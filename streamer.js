import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let client    = null;
let streamer  = null;
let isStreaming      = false;
let isReady          = false;
let currentProcessedDir = null;
let activeCommand    = null;
let initPromise      = null;

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

        try {
            client   = new Client({ checkUpdate: false });
            streamer = new Streamer(client);
        } catch (e) {
            initPromise = null;
            return reject(new Error(`فشل إنشاء Client/Streamer: ${e.message}`));
        }

        client.once('ready', () => {
            console.log(`✅ Discord: ${client.user.tag}`);
            isReady     = true;
            initPromise = null;
            resolve(true);
        });

        client.on('error',      (e) => { console.error('❌ Discord error:', e.message); isReady = false; });
        client.on('disconnect', ()  => { console.warn('⚠️ Discord disconnect'); isReady = false; isStreaming = false; });

        client.login(token).catch((e) => {
            initPromise = null;
            isReady     = false;
            reject(new Error(`فشل تسجيل الدخول: ${e.message}`));
        });
    });

    return initPromise;
}

initClient().catch((e) => console.error('⚠️ init error:', e.message));

// ─── بدء البث ──────────────────────────────────────────────────────────────
export async function startStream(videoPath, processedDir) {
    console.log(`[startStream] videoPath=${videoPath}`);

    if (isStreaming) return { success: false, message: 'البث قيد التشغيل بالفعل' };
    if (!videoPath)  return { success: false, message: 'لا يوجد مسار فيديو' };

    const guildId   = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;

    if (!guildId || !channelId) {
        return { success: false, message: 'GUILD_ID أو CHANNEL_ID مفقودان' };
    }

    try {
        if (!isReady) {
            console.log('🔄 إعادة الاتصال...');
            await initClient();
        }

        // تحقق من السيرفر والروم
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, message: `السيرفر غير موجود (GUILD_ID: ${guildId})` };

        const channel = guild.channels.cache.get(channelId);
        if (!channel)       return { success: false, message: `الروم غير موجود (CHANNEL_ID: ${channelId})` };
        if (!channel.isVoice()) return { success: false, message: `"${channel.name}" ليس روماً صوتياً` };

        console.log(`🎧 الانضمام إلى: ${channel.name}`);
        await streamer.joinVoice(guildId, channelId);
        console.log('✅ انضم للروم');

        // اختبر Utils
        console.log('[debug] Utils keys:', Object.keys(Utils || {}));

        // ── normalizeVideoCodec ── اختر الطريقة الصحيحة حسب الإصدار
        let videoCodec;
        if (Utils && typeof Utils.normalizeVideoCodec === 'function') {
            videoCodec = Utils.normalizeVideoCodec('H264');
        } else if (Utils && typeof Utils.VideoCodec !== 'undefined') {
            videoCodec = Utils.VideoCodec.H264;
        } else {
            videoCodec = 'H264'; // fallback مباشر
        }
        console.log(`[debug] videoCodec=${videoCodec}`);

        // ── prepareStream ──
        let command, output;
        try {
            const streamOptions = {
                width:         1280,
                height:        720,
                frameRate:     30,
                bitrateVideo:  2500,
                bitrateVideoMax: 3000,
                videoCodec,
                h26xPreset:    'ultrafast',
                includeAudio:  true,
            };
            console.log('[debug] prepareStream options:', JSON.stringify(streamOptions));
            const prepared = prepareStream(videoPath, streamOptions);
            console.log('[debug] prepared keys:', Object.keys(prepared || {}));
            command = prepared.command;
            output  = prepared.output;
        } catch (e) {
            console.error('❌ prepareStream crash:', e.message, e.stack);
            return { success: false, message: `prepareStream فشل: ${e.message}` };
        }

        if (!output) {
            return { success: false, message: 'prepareStream أرجع output فارغ' };
        }

        // ── معالج أخطاء ffmpeg ──
        if (command) {
            command.on('error', (err, stdout, stderr) => {
                console.error('❌ ffmpeg error:', err.message);
                if (stderr) console.error('ffmpeg stderr:', stderr.slice(-500));
                isStreaming   = false;
                activeCommand = null;
                cleanup(currentProcessedDir);
            });
        }

        activeCommand       = command;
        currentProcessedDir = processedDir;
        isStreaming         = true;

        console.log('[debug] بدأ playStream');
        playStream(output, streamer, { type: 'go-live' })
            .then(() => {
                console.log('✅ انتهى الفيديو.');
                isStreaming = false; activeCommand = null;
                cleanup(currentProcessedDir);
            })
            .catch((e) => {
                console.error('❌ playStream error:', e.message);
                isStreaming = false; activeCommand = null;
                cleanup(currentProcessedDir);
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
    if (!isStreaming && !activeCommand) return { success: false, message: 'لا يوجد بث نشط' };
    try {
        if (activeCommand) { try { activeCommand.kill('SIGKILL'); } catch {} activeCommand = null; }
        streamer.stopStream();
        isStreaming = false;
        cleanup(currentProcessedDir);
        return { success: true, message: '🛑 تم إيقاف البث' };
    } catch (e) {
        isStreaming = false;
        return { success: false, message: e.message };
    }
}

// ─── تنظيف ─────────────────────────────────────────────────────────────────
function cleanup(dir) {
    currentProcessedDir = null;
    if (dir && fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`🗑️ ${dir}`); }
        catch (e) { console.warn('⚠️ cleanup fail:', e.message); }
    }
}

// ─── الحالة ────────────────────────────────────────────────────────────────
export function getStatus() {
    return { isStreaming, isReady, user: client?.user?.tag ?? null };
}
