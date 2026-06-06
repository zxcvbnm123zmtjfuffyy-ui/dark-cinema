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
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

const convertToHls = (inputPath, outputDir) => {
    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions(['-codec: copy', '-start_number 0', '-hls_time 10', '-hls_list_size 0', '-f hls'])
            .output(outputPlaylist)
            .on('end', () => resolve(outputPlaylist))
            .on('error', (err) => reject(err))
            .run();
    });
};

// Serve static files (index.html)
app.use(express.static(__dirname));
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));

app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });
    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    try {
        await convertToHls(videoPath, outputDir);
        const videoUrl = `/processed/${videoId}/output.m3u8`;
        fs.unlink(videoPath, () => {});
        res.json({ success: true, videoUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, message: 'No video URL' });
    const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${req.protocol}://${req.get('host')}${videoUrl}`;
    const result = await startStream(fullUrl);
    res.json(result);
});

app.post('/api/stop', async (req, res) => {
    res.json(await stopStream());
});

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.use('/processed', express.static(PROCESSED_DIR));

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});