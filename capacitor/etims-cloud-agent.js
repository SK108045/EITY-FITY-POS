#!/usr/bin/env node
/**
 * Oraforge eTIMS Cloud Tunnel Agent
 * Bridges the Cloud-hosted POS web application to the Cashier's local Windows eTIMS helper.
 * Zero external dependencies. Works on Node.js 18, 20, 22, 24+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');

// Banner
console.log('\n' + '='.repeat(64));
console.log('   🚀 ORAFORGE eTIMS CLOUD TUNNEL AGENT');
console.log('   Bridges Cloud POS <-> Local Windows eTIMS Helper');
console.log('='.repeat(64) + '\n');

// 1. Locate configuration
const CONFIG_FILE_NAME = 'etims-agent-config.json';
const candidateConfigPaths = [
  path.resolve(process.cwd(), CONFIG_FILE_NAME),
  path.resolve(__dirname, CONFIG_FILE_NAME),
  path.resolve(__dirname, '..', CONFIG_FILE_NAME),
  path.join(process.env.LOCALAPPDATA || '.', 'OraforgePOS', 'etims', CONFIG_FILE_NAME)
];

let configPath = candidateConfigPaths.find(p => fs.existsSync(p)) || candidateConfigPaths[0];
let fileConfig = {};

if (fs.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.warn(`[Config] Warning: Could not parse ${configPath}: ${e.message}`);
  }
}

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const insecureTls = args.includes('--insecure') || fileConfig.insecure === true;
if (insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.log('[Security] Notice: TLS certificate validation disabled (--insecure).');
}

let cloudUrl = getArg('--url', process.env.POS_CLOUD_URL || fileConfig.cloud_url || '');
let shopId = getArg('--shop', process.env.POS_SHOP_ID || fileConfig.shop_id || 'retail');
let tunnelSecret = getArg('--secret', process.env.ETIMS_TUNNEL_SECRET || fileConfig.secret || '');
let helperPort = parseInt(getArg('--port', process.env.ORAFORGE_ETIMS_PORT || fileConfig.helper_port || '17383'), 10);

function getEtimsHome() {
  return process.env.ORAFORGE_ETIMS_HOME ||
    path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'OraforgePOS', 'etims');
}

function getHelperToken() {
  const candidateTokenPaths = [
    path.join(getEtimsHome(), 'helper.token'),
    path.resolve(process.cwd(), 'helper.token'),
    path.resolve(__dirname, 'helper.token')
  ];
  for (const p of candidateTokenPaths) {
    try {
      if (fs.existsSync(p)) {
        const t = fs.readFileSync(p, 'utf8').trim();
        if (t.length >= 10) return t;
      }
    } catch (_) {}
  }
  return '';
}

// Check local helper health
function checkLocalHelper() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: helperPort,
      path: '/health',
      method: 'GET',
      headers: { 'Connection': 'close' },
      agent: false,
      timeout: 1500
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, info: json });
        } catch {
          resolve({ ok: false, error: 'Invalid response from helper' });
        }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.end();
  });
}

// Forward request to local eTIMS helper
function forwardToLocalHelper(route, method, body) {
  return new Promise((resolve) => {
    const token = getHelperToken();
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;

    const headers = {
      'Accept': 'application/json',
      'Connection': 'close'
    };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: helperPort,
      path: route,
      method: method || 'GET',
      headers,
      agent: false,
      timeout: 45000
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(raw);
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data: { raw } });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ status: 503, error: `Local eTIMS helper connection failed: ${err.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 504, error: 'Local eTIMS helper timed out after 45s' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// Minimal native RFC-6455 client adapter for Node versions where global WebSocket might be absent
function createNativeWsClient(wsUrl) {
  const url = new URL(wsUrl);
  const isSecure = url.protocol === 'wss:';
  const transport = isSecure ? https : http;
  const port = url.port || (isSecure ? 443 : 80);
  const key = crypto.randomBytes(16).toString('base64');

  const listeners = {
    open: [],
    message: [],
    close: [],
    error: []
  };

  const client = {
    readyState: 0, // CONNECTING
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
      return client;
    },
    send(text) {
      if (!client.socket || client.readyState !== 1) return false;
      const payload = Buffer.from(text, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      const len = payload.length;

      if (len < 126) {
        header = Buffer.from([0x81, 0x80 | len]);
      } else if (len <= 0xffff) {
        header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }

      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
      }

      try {
        client.socket.write(Buffer.concat([header, mask, masked]));
        return true;
      } catch (_) {
        return false;
      }
    },
    close() {
      if (client.socket) {
        try { client.socket.destroy(); } catch (_) {}
      }
      client.readyState = 3;
    }
  };

  const req = transport.request({
    hostname: url.hostname,
    port,
    path: url.pathname + url.search,
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      'Host': url.host
    }
  });

  req.on('upgrade', (res, socket, head) => {
    client.socket = socket;
    client.readyState = 1; // OPEN
    listeners.open.forEach(fn => fn());

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const first = buf[0];
        const second = buf[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let len = second & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        const total = offset + maskLen + len;
        if (buf.length < total) break;

        let payload = buf.slice(offset + maskLen, total);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
          payload = unmasked;
        }

        buf = buf.slice(total);

        if (opcode === 0x09) {
          // Ping -> send pong with mask
          const pongMask = crypto.randomBytes(4);
          socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), pongMask]));
        } else if (opcode === 0x08) {
          // Close
          client.readyState = 3;
          listeners.close.forEach(fn => fn(1000, 'Server closed'));
          socket.destroy();
          return;
        } else if (opcode === 0x01) {
          // Text
          listeners.message.forEach(fn => fn(payload.toString('utf8')));
        }
      }
    });

    socket.on('error', (err) => {
      listeners.error.forEach(fn => fn(err));
    });

    socket.on('close', () => {
      client.readyState = 3;
      listeners.close.forEach(fn => fn());
    });
  });

  req.on('error', (err) => {
    listeners.error.forEach(fn => fn(err));
  });

  req.end();
  return client;
}

// Unified WebSocket wrapper
function connectWebSocket(wsUrl) {
  if (typeof globalThis.WebSocket !== 'undefined') {
    const ws = new globalThis.WebSocket(wsUrl);
    const emitter = {
      send: (txt) => ws.send(txt),
      close: () => ws.close(),
      on: (event, fn) => {
        if (event === 'open') ws.onopen = () => fn();
        else if (event === 'message') ws.onmessage = (e) => fn(e.data);
        else if (event === 'close') ws.onclose = () => fn();
        else if (event === 'error') ws.onerror = (e) => fn(e);
        return emitter;
      }
    };
    return emitter;
  }
  return createNativeWsClient(wsUrl);
}

// Interactive prompt for cloud URL if missing
async function ensureConfig() {
  if (cloudUrl && cloudUrl !== 'https://pos.yourdomain.com') return;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (q) => new Promise(res => rl.question(q, res));

  console.log('--- Initial Configuration Setup ---');
  console.log('Enter the web address of your hosted Oraforge POS.');
  console.log('Example: https://pos.example.com or http://192.168.1.100:3000\n');

  const inputUrl = (await question('Cloud POS Server URL: ')).trim();
  const inputShop = (await question(`Shop identifier [${shopId}]: `)).trim();
  rl.close();

  if (inputUrl) cloudUrl = inputUrl;
  if (inputShop) shopId = inputShop;

  // Persist config
  const saved = {
    cloud_url: cloudUrl,
    shop_id: shopId,
    secret: tunnelSecret,
    helper_port: helperPort
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(saved, null, 2), 'utf8');
    console.log(`[Config] Configuration saved to ${configPath}\n`);
  } catch (err) {
    console.warn(`[Config] Could not save config file: ${err.message}`);
  }
}

let invoiceCounter = 0;

async function startAgent() {
  await ensureConfig();

  if (!cloudUrl) {
    console.error('[Error] Cloud POS URL is missing. Set POS_CLOUD_URL or pass --url <URL>.');
    process.exit(1);
  }

  // Normalize URL to ws:// or wss://
  let baseWsUrl = cloudUrl.trim().replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!baseWsUrl.startsWith('ws://') && !baseWsUrl.startsWith('wss://')) {
    baseWsUrl = 'wss://' + baseWsUrl;
  }
  baseWsUrl = baseWsUrl.replace(/\/+$/, '');

  const queryParams = new URLSearchParams({
    shop_id: shopId,
    ...(tunnelSecret ? { token: tunnelSecret } : {})
  });
  const tunnelWsUrl = `${baseWsUrl}/api/etims/tunnel?${queryParams.toString()}`;

  console.log(`[Configuration]`);
  console.log(`  Cloud Server:  ${cloudUrl}`);
  console.log(`  Shop ID:       ${shopId}`);
  console.log(`  Local Helper:  http://127.0.0.1:${helperPort}`);
  console.log(`  Config File:   ${configPath}\n`);

  // Check helper initial state
  const helperStatus = await checkLocalHelper();
  if (helperStatus.ok) {
    console.log(`[Local Helper] ✓ ONLINE on port ${helperPort} (build: ${helperStatus.info?.build || 'active'})`);
  } else {
    console.log(`[Local Helper] ⚠️  NOT DETECTED on port ${helperPort} (${helperStatus.error})`);
    console.log(`[Local Helper] Please start OraforgeEtims.exe or the Windows eTIMS app.\n`);
  }

  let activeWs = null;
  let retryDelay = 3000;

  function connect() {
    console.log(`[Tunnel] Connecting to ${tunnelWsUrl}...`);
    try {
      activeWs = connectWebSocket(tunnelWsUrl);
    } catch (e) {
      console.error(`[Tunnel] Connection creation error: ${e.message}`);
      scheduleReconnect();
      return;
    }

    activeWs.on('open', () => {
      retryDelay = 3000;
      console.log(`\n============================================================`);
      console.log(`  🟢 TUNNEL CONNECTED TO CLOUD POS`);
      console.log(`  Cashiers can now complete sales and generate KRA invoices!`);
      console.log(`============================================================\n`);
    });

    activeWs.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg.id || !msg.route) return;

        const timeStr = new Date().toLocaleTimeString();
        console.log(`[${timeStr}] 📩 Request received: ${msg.method || 'GET'} ${msg.route} (ID: ${msg.id})`);

        const result = await forwardToLocalHelper(msg.route, msg.method, msg.body);

        if (result.status >= 200 && result.status < 300) {
          if (msg.route.includes('/jobs') && msg.method === 'POST') {
            invoiceCounter++;
            const cu = result.data?.fiscal?.cu_invoice_number || 'Issued';
            console.log(`[${timeStr}] ✅ Invoice processed! CU Number: ${cu} (Total: ${invoiceCounter})`);
          } else {
            console.log(`[${timeStr}] ✅ Request ${msg.id} completed (HTTP ${result.status})`);
          }
        } else {
          console.warn(`[${timeStr}] ⚠️  Local helper returned status ${result.status}:`, result.data?.error || result.error || 'Unknown error');
        }

        activeWs.send(JSON.stringify({
          id: msg.id,
          status: result.status,
          data: result.data,
          error: result.error
        }));
      } catch (err) {
        console.error(`[Tunnel] Error processing cloud request: ${err.message}`);
      }
    });

    activeWs.on('close', () => {
      console.warn(`[Tunnel] Disconnected from cloud server.`);
      scheduleReconnect();
    });

    activeWs.on('error', (err) => {
      console.warn(`[Tunnel] Connection error: ${err.message || 'Connection refused or dropped'}`);
    });
  }

  function scheduleReconnect() {
    console.log(`[Tunnel] Reconnecting in ${(retryDelay / 1000).toFixed(0)} seconds...`);
    setTimeout(() => {
      retryDelay = Math.min(retryDelay * 1.5, 15000);
      connect();
    }, retryDelay);
  }

  connect();
}

startAgent().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
