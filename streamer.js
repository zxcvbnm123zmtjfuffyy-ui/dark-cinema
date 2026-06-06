import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Encoders, Utils } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';

dotenv.config();

let currentStreamer = null;
let isStreaming = false;
let currentVideoUrl = null;

function logError(context, error) {
    console.error(`[ERROR] ${context}: ${error.message}`);
    if (error.stack) console.error(error.stack);
}

export async function startStream(videoUrl, retryCount = 0) {
    const MAX_RETRIES = 2;
    if (isStreaming) {
        console.log("⚠️ البث قيد التشغيل بالفعل");
        return { success: false, message: "البث قيد التشغيل" };
    }
    if (!videoUrl) {
        console.error("❌ لا يوجد رابط فيديو");
        return { success: false, message: "لا يوجد رابط فيديو" };
    }
    console.log(`🎬 بدء البث من: ${videoUrl}`);
    try {
        const streamer = new Streamer(new Client());
        currentStreamer = streamer;
        await streamer.client.login(process.env.DISCORD_TOKEN);
        await new Promise((resolve) => streamer.client.once('ready', resolve));
        console.log(`✅ تم تسجيل الدخول باسم: ${streamer.client.user.tag}`);
        await streamer.joinVoice(process.env.GUILD_ID, process.env.CHANNEL_ID);
        console.log(`🎧 تم الانضمام إلى الروم الصوتي (ID: ${process.env.CHANNEL_ID})`);
        const encoder = Encoders.software({ x264: { preset: "veryfast" } });
        const { output } = prepareStream(videoUrl, {
            encoder: encoder,
            height: 720,
            frameRate: 30,
            bitrateVideo: 2500,
            videoCodec: Utils.normalizeVideoCodec("H264"),
            h26xPreset: "veryfast"
        });
        await playStream(output, streamer, { type: "go-live" });
        isStreaming = true;
        currentVideoUrl = videoUrl;
        console.log("🎥 بدأ البث المباشر بنجاح!");
        return { success: true, message: "تم بدء البث" };
    } catch (error) {
        logError("startStream", error);
        if (retryCount < MAX_RETRIES) {
            console.log(`🔄 إعادة محاولة البث (${retryCount + 1}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return startStream(videoUrl, retryCount + 1);
        } else {
            try {
                if (currentStreamer) {
                    await currentStreamer.leaveVoice().catch(() => {});
                    await currentStreamer.client.destroy().catch(() => {});
                }
            } catch (cleanupError) {
                logError("cleanup after failure", cleanupError);
            }
            currentStreamer = null;
            isStreaming = false;
            return { success: false, message: error.message };
        }
    }
}

export async function stopStream() {
    if (!currentStreamer) {
        console.log("⚠️ لا يوجد بث نشط");
        return { success: false, message: "لا يوجد بث نشط" };
    }
    console.log("🛑 إيقاف البث...");
    try {
        await currentStreamer.stopStream().catch(() => {});
        await currentStreamer.leaveVoice().catch(() => {});
        await currentStreamer.client.destroy().catch(() => {});
        currentStreamer = null;
        isStreaming = false;
        currentVideoUrl = null;
        console.log("✅ تم إيقاف البث");
        return { success: true, message: "تم إيقاف البث" };
    } catch (error) {
        logError("stopStream", error);
        return { success: false, message: error.message };
    }
}

export function getStatus() {
    return { isStreaming, videoUrl: currentVideoUrl };
}