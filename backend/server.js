const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Tesla Cinema D/R Stream Proxy',
        timestamp: new Date().toISOString()
    });
});

// Stream resolver endpoint: /api/stream?id=VIDEO_ID or /api/stream?url=...
app.get('/api/stream', (req, res) => {
    const videoId = req.query.id;
    let url = req.query.url;

    if (!url && videoId) {
        url = `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (!url) {
        return res.status(400).json({ error: 'Missing "id" or "url" query parameter' });
    }

    // Try yt-dlp first
    const ytdlp = spawn('yt-dlp', [
        '-g',
        '-f', 'bestvideo[ext=webm]+bestaudio/best[ext=mp4]/best',
        '--no-playlist',
        '--no-warnings',
        url
    ]);

    let stdoutData = '';
    let stderrData = '';

    ytdlp.stdout.on('data', (data) => {
        stdoutData += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
        stderrData += data.toString();
    });

    ytdlp.on('close', (code) => {
        if (code === 0 && stdoutData.trim()) {
            const urls = stdoutData.trim().split('\n').filter(Boolean);
            if (urls.length >= 2) {
                // Separate video & audio streams
                return res.json({
                    status: 'ok',
                    videoUrl: urls[0].trim(),
                    audioUrl: urls[1].trim(),
                    engine: 'yt-dlp'
                });
            } else if (urls.length === 1) {
                // Combined stream
                return res.json({
                    status: 'ok',
                    videoUrl: urls[0].trim(),
                    audioUrl: null,
                    engine: 'yt-dlp'
                });
            }
        }

        // Fallback: Cobalt API if yt-dlp is not installed or failed
        fetch('https://api.cobalt.tools/', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: url,
                videoQuality: '720'
            })
        })
        .then(r => r.json())
        .then(cobaltData => {
            if (cobaltData && cobaltData.url) {
                return res.json({
                    status: 'ok',
                    videoUrl: cobaltData.url,
                    audioUrl: null,
                    engine: 'cobalt-fallback'
                });
            }
            res.status(502).json({
                error: 'Stream extraction failed',
                details: stderrData || 'No streams resolved'
            });
        })
        .catch(err => {
            res.status(500).json({
                error: 'Internal server error resolving stream',
                message: err.message
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`[Tesla Cinema Backend] Running on port ${PORT}`);
});
