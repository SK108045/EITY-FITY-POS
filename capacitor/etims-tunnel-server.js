/* RFC-6455 Zero-Dependency WebSocket Tunnel for Remote Cloud POS <-> Local Windows eTIMS Helper */
'use strict';
const crypto = require('crypto');
const http = require('http');
const path = require('path');

// Active agent connections keyed by shop_id (and default fallback)
const agents = new Map();
let defaultAgent = null;

// Pending HTTP requests awaiting responses from agents: reqId -> { resolve, reject, timer }
const pendingRequests = new Map();

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];

    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      payloadLength = Number(big);
      headerLength = 10;
    }

    const maskOffset = offset + headerLength;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    const totalFrame = dataOffset + payloadLength;

    if (totalFrame > buffer.length) break;

    let payload = buffer.slice(dataOffset, totalFrame);
    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ fin, opcode, payload });
    offset = totalFrame;
  }

  return { frames, remaining: buffer.slice(offset) };
}

function createTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 0xffff) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function createPingFrame() {
  return Buffer.from([0x89, 0x00]);
}

function createCloseFrame(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 0x02]), payload]);
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname !== '/api/etims/tunnel') return false;

  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return true;
  }

  const shopId = url.searchParams.get('shop_id') || 'default';
  const token = url.searchParams.get('token') || '';
  const expectedSecret = process.env.ETIMS_TUNNEL_SECRET || '';

  if (expectedSecret && token !== expectedSecret) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }

  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const agent = {
    shopId,
    socket,
    remoteAddress: socket.remoteAddress,
    connectedAt: new Date().toISOString(),
    lastPing: Date.now(),
    send(obj) {
      try {
        socket.write(createTextFrame(JSON.stringify(obj)));
        return true;
      } catch (_) {
        return false;
      }
    }
  };

  agents.set(shopId, agent);
  defaultAgent = agent;
  console.log(`[eTIMS Tunnel] Cashier agent connected for shop: "${shopId}" from ${socket.remoteAddress}`);

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  const pingTimer = setInterval(() => {
    try {
      socket.write(createPingFrame());
    } catch (_) {
      cleanup();
    }
  }, 15000);

  function cleanup() {
    clearInterval(pingTimer);
    if (agents.get(shopId) === agent) {
      agents.delete(shopId);
      if (defaultAgent === agent) {
        defaultAgent = agents.values().next().value || null;
      }
    }
    console.log(`[eTIMS Tunnel] Cashier agent disconnected for shop: "${shopId}"`);
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, remaining } = parseFrames(buffer);
    buffer = remaining;

    for (const frame of frames) {
      if (frame.opcode === 0x08) {
        // Close frame
        try { socket.write(createCloseFrame()); } catch (_) {}
        socket.end();
        cleanup();
        return;
      }
      if (frame.opcode === 0x09) {
        // Ping -> respond Pong
        try { socket.write(Buffer.from([0x8a, 0x00])); } catch (_) {}
        continue;
      }
      if (frame.opcode === 0x0a) {
        // Pong
        agent.lastPing = Date.now();
        continue;
      }
      if (frame.opcode === 0x01) {
        // Text payload (JSON response from agent)
        try {
          const message = JSON.parse(frame.payload.toString('utf8'));
          if (message.id && pendingRequests.has(message.id)) {
            const pending = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
        } catch (e) {
          console.warn('[eTIMS Tunnel] Failed to parse agent message:', e.message);
        }
      }
    }
  });

  socket.on('error', cleanup);
  socket.on('close', cleanup);

  return true;
}

function forwardToAgent(shopId, route, method, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const agent = agents.get(shopId) || defaultAgent;
    if (!agent) {
      const err = new Error('Local eTIMS helper is not connected. Start the Oraforge eTIMS companion on the cashier Windows PC.');
      err.status = 503;
      return reject(err);
    }

    const id = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      const err = new Error('Local eTIMS companion timed out. Check that eTIMS is open on the cashier PC.');
      err.status = 504;
      reject(err);
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    const sent = agent.send({ id, route, method, body });
    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      const err = new Error('Failed to send request to local eTIMS companion.');
      err.status = 502;
      reject(err);
    }
  });
}

function isAgentConnected(shopId) {
  return !!(agents.get(shopId) || defaultAgent);
}

function connectedAgentsList() {
  const list = [];
  for (const [id, a] of agents.entries()) {
    list.push({ shopId: id, remoteAddress: a.remoteAddress, connectedAt: a.connectedAt });
  }
  return list;
}

module.exports = {
  handleUpgrade,
  forwardToAgent,
  isAgentConnected,
  connectedAgentsList
};
