import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { startStream, stopStream, getStatus } from './streamer.js';
import dotenv from 'dotenv';

dotenv.config();

// ── منع Node من الموت بسبب أخطاء غير متوقعة ──────────────────────────────
process.on('uncaughtException',  (err) => console.error('🔴 uncaughtException:',  err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('🔴 unhandledRejection:', err));

// ── إيقاف نظيف لما Render يسوي spin down ─────────────────────────────────
process.on('SIGTERM', async () => {
    console.log('🔴 SIGTERM — جاري الإيقاف النظيف...');
    try { await stopStream(); } catch {}
    process.exit(0);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const port = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

app.use(express.static(__dirname));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', time: new Date().toISOString() }));

// ─── Debug ────────────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
    try {
        const uploads = fs.readdirSync(UPLOAD_DIR).map(f => ({
            name: f,
            sizeMB: (fs.statSync(path.join(UPLOAD_DIR, f)).size / 1024 / 1024).toFixed(1)
        }));
        res.json({
            status:  getStatus(),
            uploads,
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

// ─── رفع بدون SSE (fallback) ──────────────────────────────────────────────
app.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'لا يوجد ملف' });
    const filePath = req.file.path;
    const sizeMB   = (req.file.size / 1024 / 1024).toFixed(1);
    console.log(`[upload] ${req.file.originalname} ${sizeMB}MB → ${filePath}`);
    res.json({ success: true, filePath, sizeMB });
});

// ─── رفع مع SSE (تقدم حي) ────────────────────────────────────────────────
app.post('/upload-stream', upload.single('video'), (req, res) => {
    if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'لا يوجد ملف' }));
    }

    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no'          // مهم لـ Render/nginx
    });

    const filePath = req.file.path;
    const sizeMB   = (req.file.size / 1024 / 1024).toFixed(1);
    console.log(`[upload-stream] ${req.file.originalname} ${sizeMB}MB → ${filePath}`);

    // الرفع نفسه فوري (multer حفظ الملف) — نرسل done مباشرة
    res.write(`data: ${JSON.stringify({
        stage:   'done',
        percent: 100,
        message: 'اكتمل الرفع!',
        filePath,
        sizeMB
    })}\n\n`);
    res.end();
});

// ─── بدء البث ─────────────────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
    try {
        const { filePath } = req.body;

        if (!filePath) {
            return res.status(400).json({ success: false, message: 'لا يوجد مسار فيديو' });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: `الملف غير موجود: ${filePath}` });
        }

        console.log(`[/api/start] ${filePath}`);
        // ملاحظة: startStream تقبل filePath فقط (لا fileId)
        const result = await startStream(filePath);
        return res.json(result);

    } catch (err) {
        console.error('[/api/start] error:', err.message, err.stack);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── إيقاف البث ───────────────────────────────────────────────────────────
app.post('/api/stop', async (req, res) => {
    try {
        return res.json(await stopStream());
    } catch (err) {
        console.error('[/api/stop]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── حالة البث ────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    try   { return res.json(getStatus()); }
    catch { return res.status(500).json({ isStreaming: false, isReady: false }); }
});

// ─── Global error handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ success: false, error: 'الملف أكبر من 5GB' });
    console.error('[express error]', err.message);
    res.status(500).json({ success: false, error: err.message });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Dark Cinema on port ${port}`);
    console.log(`🔍 Debug: /api/debug`);
});
