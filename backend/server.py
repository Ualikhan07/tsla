#!/usr/bin/env python3
"""
Tesla Cinema D/R Stream Proxy (Python 3 native)
Runs locally on macOS or Linux, uses yt-dlp to extract clean WebM video + audio streams.
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse
import subprocess
import json
import os

PORT = int(os.environ.get("PORT", 3000))

class CinemaProxyHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == '/api/health':
            self._set_headers(200)
            self.wfile.write(json.dumps({
                "status": "ok",
                "service": "Tesla Cinema D/R Python Proxy",
                "engine": "yt-dlp"
            }).encode('utf-8'))
            return

        if parsed.path == '/api/stream':
            video_id = params.get('id', [None])[0]
            url = params.get('url', [None])[0]

            if not url and video_id:
                url = f"https://www.youtube.com/watch?v={video_id}"

            if not url:
                self._set_headers(400)
                self.wfile.write(json.dumps({"error": "Missing video id or url"}).encode('utf-8'))
                return

            try:
                cmd = [
                    "yt-dlp",
                    "-g",
                    "-f", "bestvideo[ext=webm]+bestaudio/best[ext=mp4]/best",
                    "--no-playlist",
                    "--no-warnings",
                    url
                ]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
                lines = [line.strip() for line in res.stdout.strip().split('\n') if line.strip()]

                if len(lines) >= 2:
                    self._set_headers(200)
                    self.wfile.write(json.dumps({
                        "status": "ok",
                        "videoUrl": lines[0],
                        "audioUrl": lines[1],
                        "engine": "yt-dlp-local"
                    }).encode('utf-8'))
                elif len(lines) == 1:
                    self._set_headers(200)
                    self.wfile.write(json.dumps({
                        "status": "ok",
                        "videoUrl": lines[0],
                        "audioUrl": None,
                        "engine": "yt-dlp-local"
                    }).encode('utf-8'))
                else:
                    self._set_headers(502)
                    self.wfile.write(json.dumps({
                        "error": "Failed to resolve stream with yt-dlp",
                        "details": res.stderr[:200]
                    }).encode('utf-8'))
            except Exception as e:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
            return

        self._set_headers(404)
        self.wfile.write(json.dumps({"error": "Not found"}).encode('utf-8'))

def run():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, CinemaProxyHandler)
    print(f"🚀 [Tesla Cinema Proxy] Server running on http://localhost:{PORT}")
    print(f"👉 Health check: http://localhost:{PORT}/api/health")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == '__main__':
    run()
