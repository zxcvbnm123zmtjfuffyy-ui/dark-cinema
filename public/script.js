let currentVideoUrl = null;
let resumable = null;

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
            statusSpan.className = 'status streaming';
        } else {
            statusSpan.innerHTML = '⚪ متوقف';
            statusSpan.className = 'status stopped';
        }
    } catch(e) { addLog('❌ فشل تحديث الحالة: ' + e.message); }
}

async function checkSession() {
    try {
        const res = await fetch('/api/session');
        const data = await res.json();
        if (data.videoUrl && data.converted) {
            currentVideoUrl = data.videoUrl;
            addLog(`🔄 استعادة جلسة سابقة: ${currentVideoUrl}`);
            document.getElementById('videoInfo').innerHTML = `<strong>فيديو محضر مسبقاً:</strong><br>${currentVideoUrl}`;
            document.getElementById('startBtn').disabled = false;
        }
    } catch(e) { addLog('❌ فشل التحقق من الجلسة: ' + e.message); }
}

function initResumable() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    
    resumable = new Resumable({
        target: '/upload',
        chunkSize: 1 * 1024 * 1024,
        simultaneousUploads: 3,
        testChunks: true,
        throttleProgressCallbacks: 1,
        query: {}
    });
    
    resumable.assignBrowse(fileInput);
    resumable.assignDrop(uploadArea);
    
    resumable.on('fileAdded', function(file) {
        addLog(`📤 بدء رفع الفيديو: ${file.fileName} (${Math.round(file.size / 1024 / 1024)} MB)`);
        const uploadList = document.getElementById('uploadList');
        const itemDiv = document.createElement('div');
        itemDiv.className = 'upload-item';
        itemDiv.id = `upload-${file.uniqueIdentifier}`;
        itemDiv.innerHTML = `
            <p><strong>${file.fileName}</strong> - <span id="progress-${file.uniqueIdentifier}">0%</span></p>
            <div class="progress-bar"><div class="progress-fill" id="progress-fill-${file.uniqueIdentifier}"></div></div>
        `;
        uploadList.appendChild(itemDiv);
        resumable.upload();
    });
    
    resumable.on('fileProgress', function(file) {
        const progress = Math.floor(file.progress() * 100);
        const progressSpan = document.getElementById(`progress-${file.uniqueIdentifier}`);
        const progressFill = document.getElementById(`progress-fill-${file.uniqueIdentifier}`);
        if (progressSpan) progressSpan.textContent = `${progress}%`;
        if (progressFill) progressFill.style.width = `${progress}%`;
    });
    
    resumable.on('fileSuccess', function(file, message) {
        addLog(`✅ تم رفع الفيديو بنجاح: ${file.fileName}`);
        const uploadDiv = document.getElementById('uploadStatus');
        uploadDiv.innerHTML = '<p style="color: #57F287;">⏳ جاري معالجة الفيديو وتحويله... قد يستغرق دقائق</p>';
        try {
            const data = JSON.parse(message);
            if (data.success) {
                currentVideoUrl = data.videoUrl;
                addLog(`🎬 جاهز للبث: ${currentVideoUrl}`);
                uploadDiv.innerHTML = '<p style="color: #57F287;">✅ الفيديو جاهز للبث!</p>';
                document.getElementById('videoInfo').innerHTML = `<strong>فيديو مرفوع:</strong><br>${currentVideoUrl}`;
                document.getElementById('startBtn').disabled = false;
                const uploadList = document.getElementById('uploadList');
                const item = document.getElementById(`upload-${file.uniqueIdentifier}`);
                if (item) item.style.opacity = '0.5';
            } else {
                addLog('❌ فشل معالجة الفيديو: ' + data.error);
                uploadDiv.innerHTML = '<p style="color: #ED4245;">❌ فشل المعالجة</p>';
                document.getElementById('startBtn').disabled = true;
            }
        } catch(e) {
            addLog('❌ خطأ في معالجة الرد: ' + e.message);
        }
    });
    
    resumable.on('fileError', function(file, message) {
        addLog(`❌ فشل رفع الفيديو ${file.fileName}: ${message}`);
        document.getElementById('uploadStatus').innerHTML = '<p style="color: #ED4245;">❌ فشل الرفع</p>';
    });
}

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
checkSession();
initResumable();
