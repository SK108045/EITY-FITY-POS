const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DESKTOP = process.env.POS_DESKTOP === '1';
const PORT = parseInt(process.env.PORT || process.env.POS_PORT || '3000', 10);
const WWW_DIR = path.join(__dirname, 'www');
const SRC_DIR = path.join(__dirname, 'src');
const BRIDGE_OUT = path.join(WWW_DIR, 'sqlite-bridge.js');
const BRIDGE_SRC = path.join(SRC_DIR, 'sqlite-bridge.js');

// Ensure SQLite bridge bundle is built
function buildBridge() {
  try {
    if (!fs.existsSync(BRIDGE_SRC)) return;
    console.log('[DevServer] Building SQLite bridge bundle (www/sqlite-bridge.js)...');
    execSync('npm run build:bridge', {
      cwd: __dirname,
      stdio: 'inherit'
    });
    console.log('[DevServer] SQLite bridge ready.');
  } catch (err) {
    console.error('[DevServer] Failed to build bridge bundle:', err.message);
  }
}

if (!fs.existsSync(BRIDGE_OUT)) {
  if (DESKTOP) throw new Error('Missing packaged SQLite bridge. Extract the complete POS package.');
  buildBridge();
}

// Watch src/ directory for bridge source edits
if (!DESKTOP && fs.existsSync(SRC_DIR)) {
  let bridgeDebounce = null;
  try {
    fs.watch(SRC_DIR, { recursive: true }, () => {
      clearTimeout(bridgeDebounce);
      bridgeDebounce = setTimeout(() => {
        buildBridge();
        notifyReload();
      }, 250);
    });
  } catch (_) {}
}

// Live-reload SSE clients
const sseClients = new Set();

function notifyReload() {
  for (const client of sseClients) {
    try {
      client.write('data: reload\n\n');
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// Watch www/ directory for code & styling edits
let watchDebounce = null;
try {
  if (!DESKTOP) fs.watch(WWW_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes('.git') || filename.endsWith('~') || filename.endsWith('.tmp')) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      console.log(`[DevServer] Change detected in www/${filename} -> reloading browser...`);
      notifyReload();
    }, 120);
  });
} catch (err) {
  console.warn('[DevServer] File watch warning:', err.message);
}

// MIME types mapping
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const LIVE_RELOAD_SCRIPT = `
<!-- Dev Live Reload -->
<script id="__dev_live_reload">
  (() => {
    let es;
    function connect() {
      es = new EventSource('/dev-live-reload');
      es.onmessage = (e) => {
        if (e.data === 'reload') {
          console.log('[Dev] Change detected, reloading...');
          location.reload();
        }
      };
      es.onerror = () => {
        es.close();
        setTimeout(connect, 1200);
      };
    }
    connect();
  })();
</script>
`;

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error: ' + err.message);
      return;
    }

    if (contentType.startsWith('text/html')) {
      let html = content.toString('utf-8');
      const backupScripts = (html.includes('src="shop-operations.js"') ? '' : '<script src="/shop-operations.js" defer></script>') + '<script src="/auto-backup.js" defer></script>';
      html = html.replace('</body>', backupScripts + '</body>');
      if (!DESKTOP) {
        if (html.includes('</body>')) html = html.replace('</body>', LIVE_RELOAD_SCRIPT + '\n</body>');
        else html += LIVE_RELOAD_SCRIPT;
      }
      content = Buffer.from(html, 'utf-8');
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  });
}

function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname = decodeURIComponent(parsedUrl.pathname);

  if (pathname.startsWith('/api/etims/')) {
    require('./etims-windows').handle(req, res);
    return;
  }

  if (DESKTOP && pathname === '/api/local/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ app: 'oraforge-pos', instance: process.env.POS_INSTANCE, build: process.env.POS_BUILD, pid: process.pid }));
    return;
  }

  if (DESKTOP && pathname === '/api/local/stop' && req.method === 'POST') {
    if (req.headers['x-pos-instance'] !== process.env.POS_INSTANCE) { res.writeHead(403); res.end(); return; }
    res.writeHead(200); res.end('Stopping POS');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (pathname === '/api/local/daily-backup') {
    require('./auto-backup').handle(req, res);
    return;
  }

  // CORS preflight support
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Oraforge-Etims, X-Oraforge-Shop'
    });
    return res.end();
  }

  // Paystack Charge proxy endpoint
  if (pathname.startsWith('/api/admin/sms/')) {
    require('./sms').handle(req, res, pathname);
    return;
  }

  if (pathname === '/api/local/swifta-key' && ['GET','POST'].includes(req.method)) {
    require('./swifta-config').handle(req,res);
    return;
  }

  if (pathname === '/api/swifta/stkpush' && req.method === 'POST') {
    require('./swifta').handle(req, res);
    return;
  }
  if (pathname === '/api/swifta/status' && req.method === 'GET') {
    require('./swifta').status(req, res, parsedUrl);
    return;
  }
  if (pathname === '/api/swifta/webhook' && req.method === 'POST') {
    require('./swifta').callback(req, res, parsedUrl, true);
    return;
  }
  if (pathname === '/api/swifta/callback' && req.method === 'POST') {
    require('./swifta').callback(req, res, parsedUrl, false);
    return;
  }

  if (pathname === '/dev-live-reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Canonical admin routes
  if (pathname === '/admin' || pathname === '/admin/') {
    return serveFile(res, path.join(WWW_DIR, 'admin.html'), 'text/html; charset=utf-8');
  }

  // Resolve target file path
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(WWW_DIR, safePath);

  // Check if requested path points directly to an existing file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    return serveFile(res, filePath, contentType);
  }

  // If path is a directory and has index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const dirIndex = path.join(filePath, 'index.html');
    if (fs.existsSync(dirIndex)) {
      return serveFile(res, dirIndex, 'text/html; charset=utf-8');
    }
  }

  // If request has no extension, assume SPA route -> fallback to index.html
  if (!path.extname(pathname)) {
    const indexPath = path.join(WWW_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      return serveFile(res, indexPath, 'text/html; charset=utf-8');
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found: ' + pathname);
}

function startServer(port, attempts = 0) {
  const server = http.createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    try {
      const tunnel = require('./etims-tunnel-server');
      const handled = tunnel.handleUpgrade(req, socket, head);
      if (!handled) socket.destroy();
    } catch (e) {
      console.error('[Tunnel Upgrade Error]', e.message);
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !DESKTOP && attempts < 10) {
      const nextPort = port + 1;
      console.log(`[DevServer] Port ${port} is in use, trying ${nextPort}...`);
      startServer(nextPort, attempts + 1);
    } else {
      console.error('[DevServer] Server error:', err.message);
      process.exit(1);
    }
  });

  server.listen(port, DESKTOP ? '127.0.0.1' : '0.0.0.0', () => {
    const url = `http://localhost:${port}`;
    if (DESKTOP) { console.log('Oraforge POS ready: ' + url + '/pos'); return; }
    console.log('\n' + '='.repeat(64));
    console.log('  🚀 Oraforge POS — Local APK Browser Preview Server');
    console.log('='.repeat(64));
    console.log(`  📱 POS Terminal:  ${url}/pos`);
    console.log(`  👑 Admin Portal:  ${url}/admin.html`);
    console.log(`  ⚡ Live Reload:   ACTIVE (edits in capacitor/www/ auto-refresh)`);
    console.log(`  🔑 Default PIN:   1234`);
    console.log('='.repeat(64));
    console.log('  💡 PRO-TIP FOR SEEING IT "JUST LIKE THE APK":');
    console.log('     1. Open ' + url + ' in Chrome or Firefox.');
    console.log('     2. Press F12 (Inspect), then press Ctrl+Shift+M');
    console.log('        (or click the phone/tablet icon in DevTools).');
    console.log('     3. Select a device like "Pixel 7" or "Samsung Galaxy"');
    console.log('        to test the exact APK touch and mobile layout!');
    console.log('='.repeat(64) + '\n');
  });
}

startServer(PORT);
