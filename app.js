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
const PROCESSED_DIR = path.join(__dirname, 'processed');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR);

// إعداد Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// دالة تحويل الفيديو إلى HLS
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

// ========== واجهة HTML مضمنة بالكامل ==========
const htmlPage = `<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎬 Dark Cinema Pro</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            color: #eee;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .card {
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(10px);
            border-radius: 32px;
            padding: 2rem;
            max-width: 700px;
            width: 100%;
            box-shadow: 0 25px 45px rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.2);
        }
        h1 { text-align: center; color: #5865F2; margin-bottom: 0.5rem; }
        .sub { text-align: center; margin-bottom: 2rem; opacity: 0.8; }
        .upload-area {
            border: 2px dashed #5865F2;
            border-radius: 24px;
            padding: 2rem;
            text-align: center;
            cursor: pointer;
            transition: 0.2s;
            margin-bottom: 1.5rem;
        }
        .upload-area:hover { background: rgba(88,101,242,0.1); }
        input[type="file"] { display: none; }
        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255,255,255,0.2);
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            width: 0%;
            height: 100%;
            background: #5865F2;
            transition: width 0.3s;
        }
        .upload-item {
            background: rgba(0,0,0,0.4);
            border-radius: 12px;
            padding: 0.8rem;
            margin-bottom: 0.8rem;
        }
        .button-group { display: flex; gap: 1rem; margin: 1rem 0; }
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
            flex: 1;
        }
        button:hover { background: #4752c4; transform: scale(1.02); }
        .btn-stop { background: #da373c; }
        .btn-stop:hover { background: #ba2b2f; }
        .status {
            background: #1e1e2f;
            border-radius: 20px;
            padding: 1rem;
            text-align: center;
            margin: 1rem 0;
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
            white-space: pre-wrap;
        }
        .info { background: #1e1e2f; border-radius: 12px; padding: 0.8rem; margin-bottom: 1rem; word-break: break-all; font-size: 0.8rem; }
        hr { border-color: #3a3a55; margin: 1rem 0; }
    </style>
</head>
<body>
<div class="card">
    <h1>🎬 Dark Cinema Pro</h1>
    <div class="sub">رفع، تحويل، بث مباشر إلى ديسكورد</div>

    <div class="upload-area" id="uploadArea">
        <p>📁 اسحب الفيديو هنا أو اضغط للاختيار</p>
        <input type="file" id="fileInput" accept="video/*">
    </div>
    <div id="uploadStatus"></div>
    <div id="uploadList"></div>

    <div class="info" id="videoInfo">📌 لم يتم رفع فيديو بعد</div>

    <div class="button-group">
        <button id="startBtn" disabled>▶ بدء البث</button>
        <button id="stopBtn" class="btn-stop">⏹ إيقاف البث</button>
    </div>

    <div class="status" id="statusText">⚪ غير متصل</div>

    <div class="logs" id="logs">📋 جاهز...</div>
</div>

<script>
    let currentVideoUrl = null;

    function addLog(msg) {
        const logsDiv = document.getElementById('logs');
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = `[${time}] ${msg}`;
        logsDiv.appendChild(entry);
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
                statusSpan.className = 'status streaming';
            } else {
                statusSpan.innerHTML = '⚪ متوقف';
                statusSpan.className = 'status stopped';
            }
        } catch(e) { addLog('❌ خطأ في تحديث الحالة: ' + e.message); }
    }

    document.getElementById('uploadArea').onclick = () => document.getElementById('fileInput').click();
    document.getElementById('fileInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        addLog(`📤 رفع الفيديو: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`);
        const uploadDiv = document.getElementById('uploadStatus');
        uploadDiv.innerHTML = '<p style="color: #ffcc00;">⏳ جاري الرفع والتحويل... قد يستغرق دقائق</p>';
        const formData = new FormData();
        formData.append('video', file);
        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                currentVideoUrl = data.videoUrl;
                addLog(`✅ تم التحويل بنجاح: ${currentVideoUrl}`);
                uploadDiv.innerHTML = '<p style="color: #57F287;">✅ الفيديو جاهز للبث</p>';
                document.getElementById('videoInfo').innerHTML = `<strong>🎬 جاهز:</strong> ${currentVideoUrl}`;
                document.getElementById('startBtn').disabled = false;
            } else {
                addLog('❌ فشل: ' + data.error);
                uploadDiv.innerHTML = '<p style="color: #ED4245;">❌ فشل الرفع</p>';
            }
        } catch(err) {
            addLog('❌ خطأ في الطلب: ' + err.message);
            uploadDiv.innerHTML = '<p style="color: #ED4245;">❌ خطأ في الرفع</p>';
        }
    };

    document.getElementById('startBtn').onclick = async () => {
        if (!currentVideoUrl) { addLog('❌ لا يوجد فيديو'); return; }
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
</html>`;

// ========== Routes ==========
app.use(express.json());

app.get('/', (req, res) => res.send(htmlPage));

app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف' });
    const videoPath = req.file.path;
    const videoId = path.parse(req.file.filename).name;
    const outputDir = path.join(PROCESSED_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    try {
        const hlsPath = await convertToHls(videoPath, outputDir);
        const videoUrl = `/processed/${videoId}/output.m3u8`;
        fs.unlink(videoPath, (err) => { if (err) console.error('حذف مؤقت:', err); });
        res.json({ success: true, videoUrl, message: 'تم الرفع والتحويل' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, message: 'لا يوجد رابط' });
    const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${req.protocol}://${req.get('host')}${videoUrl}`;
    const result = await startStream(fullUrl);
    res.json(result);
});

app.post('/api/stop', async (req, res) => { res.json(await stopStream()); });
app.get('/api/status', (req, res) => { res.json(getStatus()); });
app.get('/health', (req, res) => res.send('OK'));
app.use('/processed', express.static(PROCESSED_DIR));

app.listen(port, () => {
    console.log(`🌐 Dark Cinema Pro running on port ${port}`);
    console.log(`📡 Health check: http://localhost:${port}/health`);
});