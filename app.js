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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const port = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// ─── تحويل HLS مع تتبع التقدم ───────────────────────────────────────────────
const convertToHls = (inputPath, outputDir, onProgress) => {
    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions([
                '-codec: copy',
                '-start_number 0',
                '-hls_time 10',
                '-hls_list_size 0',
                '-f hls'
            ])
            .output(outputPlaylist)
            .on('progress', (progress) => {
                if (onProgress && progress.percent) {
                    onProgress(Math.min(Math.round(progress.percent), 99));
                }
            })
            .on('end', () => resolve(outputPlaylist))
            .on('error', (err) => reject(err))
            .run();
    });
};

app.use(express.static(__dirname));
app.use(express.json());
app.use('/processed', express.static(PROCESSED_DIR));

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

// ─── رفع عادي ─────────────────────────────────────────────────────────────
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });

    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    try {
        await convertToHls(videoPath, outputDir);
        fs.unlink(videoPath, () => {});
        res.json({ success: true, videoUrl: `/processed/${videoId}/output.m3u8`, videoId });
    } catch (err) {
        console.error('[upload] ffmpeg error:', err.message);
        fs.unlink(videoPath, () => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── رفع + SSE للتقدم الحي ────────────────────────────────────────────────
app.post('/upload-stream', upload.single('video'), async (req, res) => {
    if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No file' }));
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'   // ← مهم على Render/nginx
    });

    const send = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    send({ stage: 'converting', percent: 0, message: 'جاري التحويل...' });

    try {
        await convertToHls(videoPath, outputDir, (percent) => {
            send({ stage: 'converting', percent, message: `تحويل: ${percent}%` });
        });

        fs.unlink(videoPath, () => {});
        send({
            stage: 'done',
            percent: 100,
            message: 'اكتمل!',
            videoUrl: `/processed/${videoId}/output.m3u8`,
            videoId
        });
    } catch (err) {
        console.error('[upload-stream] ffmpeg error:', err.message);
        fs.unlink(videoPath, () => {});
        send({ stage: 'error', message: err.message });
    }

    res.end();
});

// ─── بدء البث ──────────────────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
    try {
        const { videoUrl, videoId } = req.body;

        if (!videoUrl) {
            return res.status(400).json({ success: false, message: 'لا يوجد رابط فيديو' });
        }

        // استخدام 127.0.0.1 بدلاً من req.get('host') لتفادي مشاكل Render
        const internalBase = `http://127.0.0.1:${port}`;
        const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${internalBase}${videoUrl}`;

        const processedDir = videoId ? path.join(PROCESSED_DIR, videoId) : null;

        console.log(`[/api/start] videoUrl=${fullUrl}`);
        const result = await startStream(fullUrl, processedDir);

        return res.json(result);
    } catch (err) {
        console.error('[/api/start] unexpected error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── إيقاف البث ────────────────────────────────────────────────────────────
app.post('/api/stop', async (req, res) => {
    try {
        const result = await stopStream();
        return res.json(result);
    } catch (err) {
        console.error('[/api/stop] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── حالة البث ─────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    try {
        return res.json(getStatus());
    } catch (err) {
        return res.status(500).json({ isStreaming: false, isReady: false });
    }
});

// ─── معالج أخطاء Multer والـ Global ───────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'الملف أكبر من الحد المسموح (5GB)' });
    }
    console.error('[global error]', err.message);
    return res.status(500).json({ success: false, error: err.message });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Dark Cinema running on port ${port}`);
});
