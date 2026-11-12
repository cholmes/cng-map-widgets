#!/usr/bin/env python3
"""Tiny static file server WITH HTTP Range support, for the E1 benchmark harness.

Why not `python3 -m http.server`? Its SimpleHTTPRequestHandler ignores the
Range header and always returns the full file (200, not 206). The
range-request benchmark (approach b) depends on real partial-content
support, or it silently degrades into "fetch the whole file every time" --
which would make the localhost numbers meaningless. This server implements
minimal Range handling (single range only, which is all hyparquet needs)
plus permissive CORS so the pages can also be opened from a different
origin/port if needed.

Alternative: `npx serve -p 8000` also supports Range requests out of the box
and works fine too -- use whichever is already on your machine. This script
exists so no npm/npx is required.

Usage:
    python3 serve.py [port]       # default port 8000
    # then open http://localhost:8000/public/index.html
"""
import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class RangeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        file_size = os.path.getsize(path)
        range_header = self.headers.get('Range')
        if not range_header:
            return super().send_head()

        match = re.match(r'bytes=(\d*)-(\d*)', range_header)
        if not match:
            self.send_error(416, 'Invalid Range header')
            return None

        start_str, end_str = match.groups()
        if start_str == '' and end_str == '':
            self.send_error(416, 'Invalid Range header')
            return None

        if start_str == '':
            # suffix range: last N bytes
            length = int(end_str)
            start = max(0, file_size - length)
            end = file_size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str != '' else file_size - 1
        end = min(end, file_size - 1)

        if start > end or start >= file_size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{file_size}')
            self.end_headers()
            return None

        f = open(path, 'rb')
        f.seek(start)
        length = end - start + 1

        self.send_response(206)
        ctype = self.guess_type(path)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()

        self._range_length = length
        return f

    def copyfile(self, source, outputfile):
        if hasattr(self, '_range_length'):
            remaining = self._range_length
            bufsize = 64 * 1024
            while remaining > 0:
                chunk = source.read(min(bufsize, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        else:
            super().copyfile(source, outputfile)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(('localhost', port), RangeRequestHandler)
    print(f'Serving {ROOT} at http://localhost:{port}/  (Range requests supported)')
    print(f'  interactive demo: http://localhost:{port}/public/index.html')
    print(f'  automated bench:  http://localhost:{port}/bench/bench.html')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
