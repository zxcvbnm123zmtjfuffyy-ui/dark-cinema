import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Encoders } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ✅ Client واحد ثابت طول عمر السيرفر
let client = null;
let streamer = null;
let isStreaming = false;
let isReady = false;
let currentProcessedDir = null;

async function initClient() {
    if (client && isReady) return true;

    return new Promise((resolve, reject) => {
        client = new Client();

        client.once('ready', () => {
            console.log(`✅ Discord: تم تسجيل الدخول باسم ${client.user.tag}`);
            streamer = new Streamer(client);
            isReady = true;
            resolve(true);
        });

        client.on('error', (err) => {
            console.error('❌ Discord error:', err.message);
            isReady = false;
        });

        client.login(process.env.DISCORD_TOKEN).catch((err) => {
            console.error('❌ فشل تسجيل الدخول:', err.message);
            reject(err);
        });
    });
}

// تهيئة الكلاينت فور تشغيل السيرفر
initClient().catch(console.error);

export async function startStream(videoUrl, processedDir) {
    if (isStreaming) return { success: false, message: "البث قيد التشغيل بالفعل" };
    if (!videoUrl) return { success: false, message: "لا يوجد رابط فيديو" };

    try {
        // إعادة تهيئة لو انقطع الاتصال
        if (!isReady) {
            console.log('🔄 إعادة تهيئة الاتصال...');
            await initClient();
        }

        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (!guild) throw new Error(`السيرفر غير موجود: ${process.env.GUILD_ID}`);

        const channel = guild.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel || !channel.isVoice()) throw new Error(`الروم الصوتي غير صالح: ${process.env.CHANNEL_ID}`);

        console.log(`🎧 الانضمام إلى: ${channel.name}`);
        await streamer.joinVoice(process.env.GUILD_ID, process.env.CHANNEL_ID);

        console.log(`🎬 تجهيز البث من: ${videoUrl}`);
        const encoder = Encoders.software({ x264: { preset: "ultrafast" } });
        const { output } = prepareStream(videoUrl, {
            encoder,
            height: 720,
            frameRate: 30,
            bitrateVideo: 2500,
            videoCodec: "H264"
        });

        currentProcessedDir = processedDir;

        playStream(output, streamer, { type: "go-live" }).then(() => {
            console.log("✅ انتهى الفيديو.");
            isStreaming = false;
            cleanup();
        }).catch((err) => {
            console.error("❌ خطأ أثناء البث:", err.message);
            isStreaming = false;
            cleanup();
        });

        isStreaming = true;
        console.log("🎥 بدأ البث المباشر!");
        return { success: true, message: "تم بدء البث" };

    } catch (error) {
        console.error("❌ فشل البث:", error.message);
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

export async function stopStream() {
    if (!isStreaming) return { success: false, message: "لا يوجد بث نشط" };
    try {
        streamer.stopStream();
        isStreaming = false;
        cleanup();
        console.log("🛑 تم إيقاف البث");
        return { success: true, message: "تم إيقاف البث" };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

function cleanup() {
    if (currentProcessedDir && fs.existsSync(currentProcessedDir)) {
        fs.rmSync(currentProcessedDir, { recursive: true, force: true });
        console.log(`🗑️ تم حذف: ${currentProcessedDir}`);
        currentProcessedDir = null;
    }
}

export function getStatus() {
    return { isStreaming, isReady };
}
