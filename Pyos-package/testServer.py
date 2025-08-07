#Not needed unless using CDN for modules, packages, or most other assets besides pyodide
import http.server
import socketserver

PORT = 8000

class MyHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    """
    Custom request handler to add necessary CORS headers.
    These headers are required by modern browsers to enable SharedArrayBuffer,
    which Pyodide uses for its threading and other advanced features.
    Without these, you will see errors in the browser console.
    """
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

# --- To run this server ---
# 1. Save this file as server.py
# 2. Make sure index.html is in the same directory.
# 3. Run 'python server.py' or 'python3 server.py' in your terminal.
# 4. Open http://localhost:8000 in your browser.

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), MyHttpRequestHandler) as httpd:
        print(f"Serving at http://localhost:{PORT}")
        print("Required CORS headers are being served.")
        print("Press Ctrl+C to stop the server.")
        httpd.serve_forever()
