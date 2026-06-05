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

// إعداد المجلدات
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed_videos');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR);

// إعداد Multer لرفع الملفات
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB max

// دالة تحويل الفيديو إلى HLS
const convertToHls = (inputPath, outputDir) => {
    return new Promise((resolve, reject) => {
        const outputPlaylist = path.join(outputDir, 'output.m3u8');
        ffmpeg(inputPath)
            .outputOptions([
                '-codec: copy',               // نسخ الفيديو دون إعادة ترميز (سريع)
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

// واجهة HTML الرئيسية (رفع + تحكم)
const htmlPage = `
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎬 Dark Cinema</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            color: #eee;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0;
            padding: 20px;
        }
        .card {
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(10px);
            border-radius: 32px;
            padding: 2rem;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 25px 45px rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.2);
        }
        h1 {
            text-align: center;
            color: #5865F2;
            margin-top: 0;
        }
        .upload-area {
            border: 2px dashed #5865F2;
            border-radius: 24px;
            padding: 2rem;
            text-align: center;
            margin-bottom: 1.5rem;
            cursor: pointer;
            transition: 0.2s;
        }
        .upload-area:hover {
            background: rgba(88,101,242,0.1);
        }
        input[type="file"] {
            display: none;
        }
        button {
            background: #5865F2;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 40px;
            font-size: 1rem;
            font-weight: bold;
            cursor: pointer;
            transition: 0.2s;
            margin: 0.3rem;
        }
        button:hover {
            background: #4752c4;
            transform: scale(1.02);
        }
        .btn-stop {
            background: #da373c;
        }
        .btn-stop:hover {
            background: #ba2b2f;
        }
        .status {
            background: #1e1e2f;
            border-radius: 20px;
            padding: 1rem;
            text-align: center;
            margin-top: 1rem;
        }
        .streaming { color: #57F287; font-weight: bold; }
        .stopped { color: #ED4245; }
        .logs {
            background: #0a0a14;
            border-radius: 16px;
            padding: 1rem;
            font-family: monospace;
            font-size: 0.75rem;
            max-height: 200px;
            overflow-y: auto;
            margin-top: 1rem;
            white-space: pre-wrap;
        }
        hr { border-color: #3a3a55; margin: 1rem 0; }
    </style>
</head>
<body>
<div class="card">
    <h1>🎬 Dark Cinema</h1>
    <div class="upload-area" id="uploadArea">
        <p>📁 اسحب الفيديو هنا أو اضغط للاختيار</p>
        <input type="file" id="fileInput" accept="video/*">
    </div>
    <div id="uploadStatus"></div>
    <div style="text-align: center;">
        <button id="startBtn" disabled>▶ بدء البث</button>
        <button id="stopBtn" class="btn-stop">⏹ إيقاف البث</button>
    </div>
    <div class="status">
        <strong>📡 الحالة:</strong> <span id="statusText">⚪ غير متصل</span>
    </div>
    <div class="logs" id="logs">
        📋 جاهز...
    </div>
</div>
<script>
    let currentVideoUrl = null;

    function addLog(msg) {
        const logsDiv = document.getElementById('logs');
        const time = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${time}] ${msg}`;
        logsDiv.appendChild(logEntry);
        logsDiv.scrollTop = logsDiv.scrollHeight;
        while (logsDiv.children.length > 50) logsDiv.removeChild(logsDiv.firstChild);
    }

    async function updateStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const statusSpan = document.getElementById('statusText');
            if (data.isStreaming) {
                statusSpan.innerHTML = '🎥 يبث الآن';
                statusSpan.className = 'streaming';
            } else {
                statusSpan.innerHTML = '⚪ متوقف';
                statusSpan.className = 'stopped';
            }
        } catch(e) { addLog('❌ فشل تحديث الحالة: ' + e.message); }
    }

    document.getElementById('uploadArea').onclick = () => document.getElementById('fileInput').click();
    document.getElementById('fileInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        addLog(`📤 رفع الفيديو: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        const formData = new FormData();
        formData.append('video', file);
        const uploadDiv = document.getElementById('uploadStatus');
        uploadDiv.innerHTML = '<p style="color: #ffcc00;">⏳ جاري الرفع والتحويل... قد يستغرق دقائق حسب الحجم</p>';
        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                currentVideoUrl = data.videoUrl;
                addLog(`✅ تم التحويل: ${currentVideoUrl}`);
                uploadDiv.innerHTML = '<p style="color: #57F287;">✅ جاهز للبث!</p>';
                document.getElementById('startBtn').disabled = false;
            } else {
                addLog('❌ فشل الرفع: ' + data.error);
                uploadDiv.innerHTML = '<p style="color: #ED4245;">❌ فشل الرفع</p>';
            }
        } catch(err) {
            addLog('❌ خطأ في الطلب: ' + err.message);
            uploadDiv.innerHTML = '<p style="color: #ED4245;">❌ خطأ في الرفع</p>';
        }
    };

    document.getElementById('startBtn').onclick = async () => {
        if (!currentVideoUrl) { addLog('❌ لا يوجد فيديو للبث'); return; }
        addLog('🎬 بدء البث...');
        document.getElementById('startBtn').disabled = true;
        try {
            const res = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoUrl: currentVideoUrl })
            });
            const data = await res.json();
            if (data.success) addLog('✅ ' + data.message);
            else addLog('❌ فشل البث: ' + data.message);
        } catch(e) { addLog('❌ خطأ: ' + e.message); }
        document.getElementById('startBtn').disabled = false;
        updateStatus();
    };

    document.getElementById('stopBtn').onclick = async () => {
        addLog('⏹ إيقاف البث...');
        try {
            const res = await fetch('/api/stop', { method: 'POST' });
            const data = await res.json();
            addLog('✅ ' + data.message);
        } catch(e) { addLog('❌ خطأ: ' + e.message); }
        updateStatus();
    };

    updateStatus();
    setInterval(updateStatus, 5000);
    addLog('✅ لوحة التحكم جاهزة');
</script>
</body>
</html>
`;

// مسار الواجهة الرئيسية
app.get('/', (req, res) => res.send(htmlPage));

// مسار رفع الفيديو ومعالجته (JSON)
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف' });
    }
    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    try {
        const hlsPath = await convertToHls(videoPath, outputDir);
        const videoUrl = `/processed_videos/${videoId}/output.m3u8`;
        // حذف الملف الأصلي لتوفير المساحة (اختياري)
        fs.unlink(videoPath, (err) => { if (err) console.error('Error deleting uploaded file:', err); });
        res.json({ success: true, videoUrl, message: 'تم الرفع والتحويل بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API للتحكم بالبث
app.use(express.json());
app.post('/api/start', async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, message: 'لا يوجد رابط فيديو' });
    // تحويل المسار المحلي إلى رابط كامل (إذا كان نسبيًا)
    const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${req.protocol}://${req.get('host')}${videoUrl}`;
    const result = await startStream(fullUrl);
    res.json(result);
});
app.post('/api/stop', async (req, res) => { res.json(await stopStream()); });
app.get('/api/status', (req, res) => { res.json(getStatus()); });
app.get('/health', (req, res) => res.send('OK'));

// خدمة الملفات المحولة
app.use('/processed_videos', express.static(PROCESSED_DIR));

app.listen(port, () => {
    console.log(`🌐 Dark Cinema running on port ${port}`);
    console.log(`📡 Health check: http://localhost:${port}/health`);
});