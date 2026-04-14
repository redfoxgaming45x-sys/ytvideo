const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);

// ⭐ CORS কনফিগারেশন আপডেট করা হয়েছে
const io = socketIo(server, {
  cors: {
    origin: [
      'https://তোমার-netlify-সাইট.netlify.app', // তোমার Netlify ডোমেইন বসাও
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ⭐ Express CORS middleware (REST API-র জন্য)
app.use(cors({
  origin: [
    'https://তোমার-netlify-সাইট.netlify.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, ''))); // যদি ফ্রন্টএন্ড ফাইল একসাথে থাকে

const downloads = new Map();
const YT_DLP_CMD = process.env.YT_DLP_CMD || 'yt-dlp';

// সর্বোচ্চ রেজোলিউশন সীমা (2K = 1440p)
const MAX_HEIGHT = 1440;

// রেজোলিউশন লেবেল ম্যাপ
const RESOLUTION_LABELS = {
  2160: '4K (2160p)',
  1440: '2K (1440p)',
  1080: 'Full HD (1080p)',
  720:  'HD (720p)',
  480:  'SD (480p)',
  360:  'LD (360p)',
  240:  'Very Low (240p)',
  144:  'Lowest (144p)'
};

function getResolutionLabel(height) {
  return RESOLUTION_LABELS[height] || `${height}p`;
}

function formatFileSize(bytes) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(2) + ' MB';
}

function estimateSize(bitrate, duration) {
  if (!bitrate || !duration) return 'অজানা';
  const bytes = (bitrate * 1000 * duration) / 8;
  return formatFileSize(bytes) || 'অজানা';
}

// ========================
// API: ভিডিও তথ্য আনা
// ========================
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('youtu')) {
    return res.status(400).json({ error: 'অবৈধ ইউটিউব লিংক' });
  }

  const args = ['--dump-json', '--no-playlist', url];
  const ytDlpProcess = spawn(YT_DLP_CMD, args);

  let stdout = '';
  let stderr = '';

  ytDlpProcess.stdout.on('data', (data) => { stdout += data.toString(); });
  ytDlpProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  ytDlpProcess.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp stderr:', stderr);
      return res.status(500).json({ error: 'ভিডিও তথ্য আনতে ব্যর্থ। লিংকটি সঠিক কিনা যাচাই করুন।' });
    }

    try {
      const info = JSON.parse(stdout);
      const duration = info.duration || 0;

      // ========================
      // ভিডিও ফরম্যাট (সব রেজোলিউশন, সর্বোচ্চ 1440p পর্যন্ত)
      // ========================
      const videoFormatsMap = new Map();

      info.formats.forEach(f => {
        if (!f.height || f.vcodec === 'none' || f.vcodec === null) return;
        if (f.height > MAX_HEIGHT) return;

        const height = f.height;
        const existing = videoFormatsMap.get(height);

        const currentTbr = f.tbr || f.vbr || 0;
        const existingTbr = existing ? (existing.tbr || existing.vbr || 0) : -1;

        if (!existing || currentTbr > existingTbr) {
          videoFormatsMap.set(height, f);
        }
      });

      const videoFormats = Array.from(videoFormatsMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([height, f]) => {
          const sizeFromFile = formatFileSize(f.filesize || f.filesize_approx);
          const sizeEstimated = estimateSize(f.tbr || f.vbr, duration);
          const fileSize = sizeFromFile || sizeEstimated;

          return {
            format_id: f.format_id,
            quality: getResolutionLabel(height),
            resolution: height,
            fileSize,
            ext: f.ext || 'mp4',
            type: 'video',
            hasAudio: f.acodec && f.acodec !== 'none'
          };
        });

      if (videoFormats.length === 0) {
        videoFormats.push({
          format_id: 'bestvideo[height<=1440]+bestaudio/best',
          quality: 'সর্বোচ্চ মান',
          resolution: 0,
          fileSize: 'অজানা',
          ext: 'mp4',
          type: 'video',
          hasAudio: true
        });
      }

      // ========================
      // অডিও ফরম্যাট
      // ========================
      const audioFormats = info.formats
        .filter(f => f.acodec && f.acodec !== 'none' && (f.vcodec === 'none' || !f.vcodec))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))
        .map(f => {
          const sizeFromFile = formatFileSize(f.filesize || f.filesize_approx);
          const sizeEstimated = estimateSize(f.abr, duration);
          const fileSize = sizeFromFile || sizeEstimated;

          const abr = f.abr ? Math.round(f.abr) : null;
          const quality = abr
            ? abr >= 192 ? `উচ্চ মান (${abr} kbps)`
              : abr >= 128 ? `মধ্যম মান (${abr} kbps)`
              : `সাধারণ মান (${abr} kbps)`
            : (f.format_note || 'অডিও');

          return {
            format_id: f.format_id,
            quality,
            abr: abr || 0,
            fileSize,
            ext: f.ext || 'webm',
            type: 'audio'
          };
        });

      const topAudioFormats = audioFormats.slice(0, 5);

      if (topAudioFormats.length === 0) {
        topAudioFormats.push({
          format_id: 'bestaudio',
          quality: 'সর্বোচ্চ মান',
          abr: 0,
          fileSize: 'অজানা',
          ext: 'mp3',
          type: 'audio'
        });
      }

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        author: info.uploader || info.channel || 'অজানা',
        formats: {
          video: videoFormats,
          audio: topAudioFormats
        }
      });

    } catch (e) {
      console.error('Parse error:', e);
      res.status(500).json({ error: 'মেটাডেটা প্রক্রিয়া করতে ব্যর্থ।' });
    }
  });
});

// ========================
// Socket.IO — ডাউনলোড
// ========================
io.on('connection', (socket) => {
  console.log('ক্লায়েন্ট সংযুক্ত:', socket.id);

  socket.on('download', async (data) => {
    const { url, formatId, type, height } = data;
    const socketId = socket.id;

    const infoArgs = ['--dump-json', '--no-playlist', url];
    const infoProc = spawn(YT_DLP_CMD, infoArgs);
    let infoStdout = '';

    infoProc.stdout.on('data', d => { infoStdout += d.toString(); });
    infoProc.stderr.on('data', d => console.error('[info stderr]', d.toString()));

    infoProc.on('close', (code) => {
      if (code !== 0) {
        socket.emit('download-error', 'ভিডিও তথ্য পুনরায় আনতে ব্যর্থ হয়েছে।');
        return;
      }

      let info;
      try {
        info = JSON.parse(infoStdout);
      } catch (e) {
        socket.emit('download-error', 'মেটাডেটা পার্স করতে ব্যর্থ।');
        return;
      }

      const rawTitle = info.title || 'video';
      const safeTitle = rawTitle.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
      const ext = type === 'audio' ? 'mp3' : 'mp4';
      const filename = `${safeTitle}.${ext}`;

      let formatString;

      if (type === 'audio') {
        formatString = formatId !== 'bestaudio' ? formatId : 'bestaudio/best';
      } else if (type === 'video' && height) {
        formatString = [
          `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
          `bestvideo[height<=${height}]+bestaudio`,
          `best[height<=${height}]`,
          'best'
        ].join('/');
      } else {
        formatString = formatId || 'bestvideo+bestaudio/best';
      }

      const args = [
        url,
        '-f', formatString,
        '--no-playlist',
        '--merge-output-format', 'mp4',
        '-o', '-'
      ];

      if (type === 'audio') {
        args.push(
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', '0'
        );
      } else {
        args.push('--prefer-ffmpeg');
      }

      console.log(`[download] শুরু: ${filename}`);
      console.log(`[download] ফরম্যাট: ${formatString}`);

      const ytProc = spawn(YT_DLP_CMD, args);
      let downloadedBytes = 0;
      let hasError = false;
      let stderrBuffer = '';

      socket.emit('download-start', { filename, total: null });

      ytProc.stdout.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        socket.emit('download-chunk', chunk);
        socket.emit('download-progress', {
          downloaded: downloadedBytes,
          total: null,
          percent: 0
        });
      });

      ytProc.stderr.on('data', (d) => {
        const line = d.toString();
        stderrBuffer += line;

        const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)(MiB|GiB|KiB)/i);
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          let totalSize = parseFloat(progressMatch[2]);
          const unit = progressMatch[3].toLowerCase();

          if (unit === 'gib') totalSize *= 1024 * 1024 * 1024;
          else if (unit === 'mib') totalSize *= 1024 * 1024;
          else if (unit === 'kib') totalSize *= 1024;

          const downloaded = (percent / 100) * totalSize;

          socket.emit('download-progress', {
            downloaded: Math.round(downloaded),
            total: Math.round(totalSize),
            percent: percent.toFixed(1)
          });
        }
      });

      ytProc.on('close', (code) => {
        if (code === 0 && !hasError) {
          console.log(`[download] সম্পন্ন: ${filename}`);
          socket.emit('download-complete');
        } else if (!hasError) {
          console.error(`[download] ত্রুটি কোড: ${code}`);
          socket.emit('download-error', `ডাউনলোড ব্যর্থ হয়েছে (কোড: ${code})। অন্য মান চেষ্টা করুন।`);
        }
        downloads.delete(socketId);
      });

      ytProc.on('error', (err) => {
        hasError = true;
        console.error('[download] প্রক্রিয়া ত্রুটি:', err.message);
        socket.emit('download-error', 'yt-dlp চালাতে ব্যর্থ: ' + err.message);
        downloads.delete(socketId);
      });

      downloads.set(socketId, ytProc);
    });
  });

  socket.on('cancel-download', () => {
    const proc = downloads.get(socket.id);
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, 2000);
      downloads.delete(socket.id);
      socket.emit('download-cancelled');
      console.log(`[cancel] সংযোগ বাতিল: ${socket.id}`);
    }
  });

  socket.on('disconnect', () => {
    const proc = downloads.get(socket.id);
    if (proc) {
      proc.kill('SIGTERM');
      downloads.delete(socket.id);
    }
    console.log('ক্লায়েন্ট বিচ্ছিন্ন:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ সার্ভার চলছে: http://localhost:${PORT}`);
  console.log(`📺 সর্বোচ্চ রেজোলিউশন: ${MAX_HEIGHT}p (2K)`);
});
