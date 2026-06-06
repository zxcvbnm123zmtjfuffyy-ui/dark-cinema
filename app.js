import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { startStream, stopStream, getStatus } from './streamer.js';
import dotenv from 'dotenv';

dotenv.config();

// ── منع Node من الموت بسبب أخطاء غير متوقعة ──────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('🔴 uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('🔴 unhandledRejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
ffmpeg.setFfmpegPath(ffmpegStatic);

const app  = express();
const port = process.env.PORT || 3000;

const UPLOAD_DIR    = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed');
[UPLOAD_DIR, PROCESSED_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// ─── جلب مدة الفيديو ─────────────────────────────────────────────────────
const getVideoDuration = (filePath) => new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => resolve(err ? 0 : parseFloat(meta?.format?.duration ?? 0)));
});

// ─── تحويل HLS ────────────────────────────────────────────────────────────
const convertToHls = async (inputPath, outputDir, onProgress) => {
    const duration = await getVideoDuration(inputPath);
    console.log(`[ffmpeg] مدة الفيديو: ${duration.toFixed(1)}s`);

    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libx264', '-c:a aac',
                '-preset ultrafast', '-crf 23',
                '-g 48', '-sc_threshold 0',
                '-hls_time 6', '-hls_list_size 0',
                '-hls_segment_type mpegts',
                '-start_number 0', '-f hls'
            ])
            .output(outputPlaylist)
            .on('stderr', (line) => {
                if (/error|invalid/i.test(line)) console.error('[ffmpeg stderr]', line);
            })
            .on('progress', (progress) => {
                if (!onProgress) return;
                let pct = 0;
                if (progress.percent != null && progress.percent > 0) {
                    pct = Math.min(Math.round(progress.percent), 99);
                } else if (duration > 0 && progress.timemark) {
                    const [h, m, s] = progress.timemark.split(':');
                    const secs = +h * 3600 + +m * 60 + parseFloat(s);
                    pct = Math.min(Math.round((secs / duration) * 100), 99);
                }
                onProgress(pct);
            })
            .on('end',   () => resolve(outputPlaylist))
            .on('error', (err) => { console.error('[ffmpeg error]', err.message); reject(err); })
            .run();
    });
};

app.use(express.static(__dirname));
app.use(express.json());
app.use('/processed', express.static(PROCESSED_DIR));

// ─── Health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', time: new Date().toISOString() }));

// ─── تشخيص البث ───────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
    try {
        const status = getStatus();
        const ffmpegPath = ffmpegStatic;
        const ffmpegExists = fs.existsSync(ffmpegPath);
        const processedFiles = fs.existsSync(PROCESSED_DIR)
            ? fs.readdirSync(PROCESSED_DIR).slice(0, 5)
            : [];
        res.json({
            status,
            ffmpegPath,
            ffmpegExists,
            processedFiles,
            env: {
                hasToken:   !!process.env.DISCORD_TOKEN,
                hasGuild:   !!process.env.GUILD_ID,
                hasChannel: !!process.env.CHANNEL_ID,
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── رفع عادي ─────────────────────────────────────────────────────────────
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });
    const videoPath = req.file.path;
    const videoId   = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    try {
        await convertToHls(videoPath, outputDir);
        fs.unlink(videoPath, () => {});
        res.json({ success: true, videoUrl: `/processed/${videoId}/output.m3u8`, videoId });
    } catch (err) {
        fs.unlink(videoPath, () => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── رفع + SSE ────────────────────────────────────────────────────────────
app.post('/upload-stream', upload.single('video'), async (req, res) => {
    if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No file' }));
    }
    res.writeHead(200, {
        'Content-Type':   'text/event-stream',
        'Cache-Control':  'no-cache',
        'Connection':     'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

    const videoPath = req.file.path;
    const videoId   = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    send({ stage: 'converting', percent: 0, message: 'جاري التحويل...' });
    try {
        await convertToHls(videoPath, outputDir, (pct) => {
            send({ stage: 'converting', percent: pct, message: `تحويل: ${pct}%` });
        });
        fs.unlink(videoPath, () => {});
        send({ stage: 'done', percent: 100, message: 'اكتمل!',
               videoUrl: `/processed/${videoId}/output.m3u8`, videoId });
    } catch (err) {
        fs.unlink(videoPath, () => {});
        send({ stage: 'error', message: err.message });
    }
    res.end();
});

// ─── بدء البث ─────────────────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
    try {
        const { videoUrl, videoId } = req.body;

        if (!videoUrl) {
            return res.status(400).json({ success: false, message: 'لا يوجد رابط فيديو' });
        }

        // مسار الملف الحقيقي على الديسك بدل HTTP داخلي
        let streamTarget;
        if (videoUrl.startsWith('http://') || videoUrl.startsWith('https://')) {
            streamTarget = videoUrl;
        } else {
            streamTarget = path.join(__dirname, videoUrl);
        }

        const processedDir = videoId ? path.join(PROCESSED_DIR, videoId) : null;

        console.log(`[/api/start] streamTarget=${streamTarget}`);

        if (!videoUrl.startsWith('http') && !fs.existsSync(streamTarget)) {
            return res.status(404).json({ success: false, message: `الملف غير موجود: ${streamTarget}` });
        }

        const result = await startStream(streamTarget, processedDir);
        return res.json(result);

    } catch (err) {
        console.error('[/api/start] error:', err.message, err.stack);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── إيقاف البث ───────────────────────────────────────────────────────────
app.post('/api/stop', async (req, res) => {
    try {
        const result = await stopStream();
        return res.json(result);
    } catch (err) {
        console.error('[/api/stop] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── حالة البث ────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    try {
        return res.json(getStatus());
    } catch (err) {
        return res.status(500).json({ isStreaming: false, isReady: false });
    }
});

// ─── Global Error Handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[express error]', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'الملف أكبر من 5GB' });
    }
    return res.status(500).json({ success: false, error: err.message });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Dark Cinema on port ${port}`);
    console.log(`🔍 Debug: http://localhost:${port}/api/debug`);
});
