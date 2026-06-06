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

// ─── جلب مدة الفيديو ─────────────────────────────────────────────────────────
const getVideoDuration = (filePath) => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err || !metadata?.format?.duration) {
                resolve(0);
            } else {
                resolve(parseFloat(metadata.format.duration));
            }
        });
    });
};

// ─── تحويل HLS مع تتبع التقدم ───────────────────────────────────────────────
const convertToHls = async (inputPath, outputDir, onProgress) => {
    const duration = await getVideoDuration(inputPath);
    console.log(`[ffmpeg] مدة الفيديو: ${duration.toFixed(1)}s`);

    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libx264',          // إعادة ترميز الفيديو — يدعم التقدم والـ HLS
                '-c:a aac',              // إعادة ترميز الصوت
                '-preset ultrafast',     // أسرع تحويل على Render
                '-crf 23',              // جودة متوازنة
                '-g 48',                // keyframe كل 48 فريم (مهم للـ HLS)
                '-sc_threshold 0',      // لا تقطع إلا على الـ keyframes
                '-hls_time 6',
                '-hls_list_size 0',
                '-hls_segment_type mpegts',
                '-start_number 0',
                '-f hls'
            ])
            .output(outputPlaylist)
            .on('stderr', (line) => {
                // سجّل أخطاء ffmpeg الفعلية لتسهيل التشخيص
                if (line.includes('Error') || line.includes('error') || line.includes('Invalid')) {
                    console.error('[ffmpeg stderr]', line);
                }
            })
            .on('progress', (progress) => {
                if (!onProgress) return;
                let pct = 0;
                if (progress.percent != null && progress.percent > 0) {
                    pct = Math.min(Math.round(progress.percent), 99);
                } else if (duration > 0 && progress.timemark) {
                    // حساب بديل عبر timemark لو percent فارغ
                    const parts = progress.timemark.split(':');
                    const secs = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
                    pct = Math.min(Math.round((secs / duration) * 100), 99);
                }
                onProgress(pct);
            })
            .on('end', () => resolve(outputPlaylist))
            .on('error', (err) => {
                console.error('[ffmpeg] error:', err.message);
                reject(err);
            })
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

        // نمرر مسار الملف مباشرة — Render لا يسمح بـ HTTP للسيرفر نفسه
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
