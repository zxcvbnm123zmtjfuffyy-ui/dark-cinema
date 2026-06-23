import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { startBroadcast, stopBroadcast, getStatus } from './bot.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const server = createServer(app);
const io = new SocketIO(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const VIDEO_DIR = path.join(process.cwd(), 'video');
const VIDEO_FILE = path.join(VIDEO_DIR, 'episode.mp4');

if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.use(express.static(process.cwd()));

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.get('/api/video', (req, res) => {
    if (!fs.existsSync(VIDEO_FILE)) {
        return res.status(404).json({ exists: false });
    }
    res.json({ exists: true, path: '/video/episode.mp4' });
});

app.get('/video/episode.mp4', (req, res) => {
    if (!fs.existsSync(VIDEO_FILE)) {
        return res.status(404).send('الملف غير موجود');
    }
    const stat = fs.statSync(VIDEO_FILE);
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(VIDEO_FILE, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(VIDEO_FILE).pipe(res);
    }
});

let currentTime = 0;
let isPlaying = false;

io.on('connection', (socket) => {
    console.log(`🔗 متصل: ${socket.id}`);

    socket.emit('sync', { currentTime, isPlaying });

    socket.on('play', () => {
        isPlaying = true;
        io.emit('play', currentTime);
    });

    socket.on('pause', () => {
        isPlaying = false;
        io.emit('pause', currentTime);
    });

    socket.on('seek', (time) => {
        currentTime = time;
        io.emit('seek', time);
    });

    socket.on('broadcast-start', async () => {
        const result = await startBroadcast();
        io.emit('broadcast-status', result);
    });

    socket.on('broadcast-stop', async () => {
        const result = await stopBroadcast();
        io.emit('broadcast-status', result);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 disconnected: ${socket.id}`);
    });
});

app.post('/api/broadcast/start', async (req, res) => {
    const result = await startBroadcast();
    res.json(result);
});

app.post('/api/broadcast/stop', async (req, res) => {
    const result = await stopBroadcast();
    res.json(result);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dark Cinema on http://localhost:${PORT}`);
    console.log(`📹 Video: ${VIDEO_FILE} ${fs.existsSync(VIDEO_FILE) ? '✅' : '❌'}`);
});
