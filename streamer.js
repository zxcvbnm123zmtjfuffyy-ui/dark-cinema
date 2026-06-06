import { Client } from "djs-selfbot-v13";
import { Streamer, prepareStream, playStream, Encoders, Utils } from '@dank074/discord-video-stream';
import dotenv from 'dotenv';

dotenv.config();

let currentStreamer = null;
let isStreaming = false;
let currentVideoUrl = null;

export async function startStream(videoUrl, retryCount = 0) {
    const MAX_RETRIES = 2;
    if (isStreaming) return { success: false, message: "البث قيد التشغيل" };
    if (!videoUrl) return { success: false, message: "لا يوجد رابط فيديو" };
    console.log(`[START] ${videoUrl}`);
    try {
        const streamer = new Streamer(new Client());
        currentStreamer = streamer;
        await streamer.client.login(process.env.DISCORD_TOKEN);
        await new Promise(resolve => streamer.client.once('ready', resolve));
        console.log(`Logged in as ${streamer.client.user.tag}`);
        await streamer.joinVoice(process.env.GUILD_ID, process.env.CHANNEL_ID);
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
        console.log("Stream started");
        return { success: true, message: "تم بدء البث" };
    } catch (error) {
        console.error(error);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retry ${retryCount+1}/${MAX_RETRIES}...`);
            await new Promise(r => setTimeout(r, 3000));
            return startStream(videoUrl, retryCount + 1);
        }
        try {
            if (currentStreamer) {
                await currentStreamer.leaveVoice().catch(() => {});
                await currentStreamer.client.destroy().catch(() => {});
            }
        } catch(e) {}
        currentStreamer = null;
        isStreaming = false;
        return { success: false, message: error.message };
    }
}

export async function stopStream() {
    if (!currentStreamer) return { success: false, message: "لا يوجد بث نشط" };
    try {
        await currentStreamer.stopStream().catch(() => {});
        await currentStreamer.leaveVoice().catch(() => {});
        await currentStreamer.client.destroy().catch(() => {});
        currentStreamer = null;
        isStreaming = false;
        currentVideoUrl = null;
        return { success: true, message: "تم إيقاف البث" };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

export function getStatus() {
    return { isStreaming, videoUrl: currentVideoUrl };
}