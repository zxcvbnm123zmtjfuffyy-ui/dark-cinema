import express from 'express';
import session from 'express-session';
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

// إعدادات الجلسات لتذكر حالة المستخدم
app.use(session({
    secret: 'dark-cinema-super-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 24 ساعة
}));

// إعداد المجلدات
const UPLOAD_DIR = path.join(__dirname, 'uploads_tmp');
const PROCESSED_DIR = path.join(__dirname, 'processed_videos');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR);

// إعداد Multer لرفع الملفات (للطريقة العادية، مع دعم الجلسات)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userUploadDir = path.join(UPLOAD_DIR, req.session.id);
        if (!fs.existsSync(userUploadDir)) fs.mkdirSync(userUploadDir);
        cb(null, userUploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB max

// دالة تحويل الفيديو إلى HLS مع عرض التقدم
const convertToHls = (inputPath, outputDir, onProgress) => {
    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        const command = ffmpeg(inputPath);
        
        if (onProgress) {
            command.on('progress', onProgress);
        }
        
        command.outputOptions([
            '-codec: copy',
            '-start_number 0',
            '-hls_time 10',
            '-hls_list_size 0',
            '-f hls'
        ])
        .output(outputPlaylist)
        .on('end', () => resolve(outputPlaylist))
        .on('error', (err) => reject(err))
        .run();
    });
};

// خدمة الملفات الثابتة (واجهة HTML، CSS، JS)
app.use(express.static('public'));
app.use(express.json());

// مسار رفع الفيديو وتتبعه بالجلسة (لطريقة التحميل التقليدية)
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف' });
    }
    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    req.session.videoId = videoId;
    req.session.videoPath = videoPath;

    try {
        const hlsPath = await convertToHls(videoPath, outputDir, (progress) => {
            console.log(`تحويل الفيديو: ${progress.percent}%`);
        });
        const videoUrl = `/processed_videos/${videoId}/output.m3u8`;
        req.session.videoUrl = videoUrl;
        req.session.converted = true;
        // حذف الملف الأصلي بعد التحويل بنجاح
        fs.unlink(videoPath, (err) => { if (err) console.error('خطأ في حذف الملف:', err); });
        
        res.json({ success: true, videoUrl, message: 'تم الرفع والتحويل بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// مسار للتحقق من حالة الجلسة
app.get('/api/session', (req, res) => {
    res.json({
        videoId: req.session.videoId || null,
        videoUrl: req.session.videoUrl || null,
        converted: req.session.converted || false
    });
});

// نقاط نهاية البث
app.post('/api/start', async (req, res) => {
    const videoUrl = req.session.videoUrl || req.body.videoUrl;
    if (!videoUrl) return res.status(400).json({ success: false, message: 'لا يوجد رابط فيديو' });
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

// نقطة نهاية للصحة
app.get('/health', (req, res) => res.send('OK'));

// خدمة الملفات المحولة
app.use('/processed_videos', express.static(PROCESSED_DIR));

app.listen(port, () => {
    console.log(`🌐 Dark Cinema Pro running on port ${port}`);
    console.log(`📡 Health check: http://localhost:${port}/health`);
});