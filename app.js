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
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// تحويل HLS مع تتبع التقدم
const convertToHls = (inputPath, outputDir, onProgress) => {
    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions(['-codec: copy', '-start_number 0', '-hls_time 10', '-hls_list_size 0', '-f hls'])
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

app.get('/health', (req, res) => res.send('OK'));

// رفع مع SSE للتقدم الحي
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });

    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    try {
        await convertToHls(videoPath, outputDir);
        fs.unlink(videoPath, () => {});
        res.json({ success: true, videoUrl: `/processed/${videoId}/output.m3u8`, videoId });
    } catch (err) {
        console.error(err);
        fs.unlink(videoPath, () => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// SSE للتقدم الحي (رفع + تحويل)
app.post('/upload-stream', upload.single('video'), async (req, res) => {
    if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No file' }));
    }

    // إعداد SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

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
        console.error(err);
        fs.unlink(videoPath, () => {});
        send({ stage: 'error', message: err.message });
    }

    res.end();
});

app.post('/api/start', async (req, res) => {
    const { videoUrl, videoId } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, message: 'No video URL' });
    const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${req.protocol}://${req.get('host')}${videoUrl}`;
    const processedDir = videoId ? path.join(PROCESSED_DIR, videoId) : null;
    const result = await startStream(fullUrl, processedDir);
    res.json(result);
});

app.post('/api/stop', async (req, res) => {
    const result = await stopStream();
    res.json(result);
});

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
