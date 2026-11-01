#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""心枕的取图代理：只放行 QQ / B 站的图片 CDN，别的一律 403。
   用途：网页版心枕收录表情包时绕开跨域。
   监听 127.0.0.1:9099，由 nginx 的 /qq/img/ 反代过来。"""

import http.server
import socketserver
import urllib.parse
import urllib.request
import time
import os

PORT = 9099
ALLOW_SUFFIX = ('.qpic.cn', '.gtimg.cn', '.hdslb.com', '.biliimg.com',
                '.qq.com', '.qq.com.cn', '.bilivideo.com', '.myqcloud.com')
MAX_BYTES = 4 * 1024 * 1024


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _deny(self, code=403, msg=b'forbidden'):
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(msg)))
        self.end_headers()
        try:
            self.wfile.write(msg)
        except Exception:
            pass

    def do_GET(self):
        q = urllib.parse.urlparse(self.path)
        u = (urllib.parse.parse_qs(q.query).get('u') or [''])[0]
        if not u.lower().startswith(('http://', 'https://')):
            return self._deny(400, b'bad url')
        host = (urllib.parse.urlparse(u).hostname or '').lower()
        if not host.endswith(ALLOW_SUFFIX):
            return self._deny(403, b'host not allowed')
        req = urllib.request.Request(u, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': '',
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read(MAX_BYTES)
                ctype = r.headers.get('Content-Type', 'application/octet-stream')
        except Exception as e:
            return self._deny(502, ('fetch failed: %s' % e).encode('utf-8', 'ignore'))
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'public, max-age=600')
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    # ---- 心枕页面上报的运行状态（排查用）----
    def do_POST(self):
        q = urllib.parse.urlparse(self.path)
        if q.path.rstrip('/') != '/diag':
            return self._deny(404, b'not found')
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(min(n, 8192)).decode('utf-8', 'replace')
        except Exception:
            body = ''
        try:
            with open('/opt/xinzhen/diag.log', 'a', encoding='utf-8') as f:
                f.write(time.strftime('%H:%M:%S ') + body.replace('\n', ' ')[:1200] + '\n')
            sz = os.path.getsize('/opt/xinzhen/diag.log')
            if sz > 1024 * 1024:
                os.replace('/opt/xinzhen/diag.log', '/opt/xinzhen/diag.log.1')
        except Exception as e:
            return self._deny(500, str(e).encode())
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', '0')
        self.end_headers()


    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    Server(('127.0.0.1', PORT), Handler).serve_forever()
