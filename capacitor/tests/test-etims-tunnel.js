/**
 * End-to-End Test for eTIMS WebSocket Tunnel (Option 1)
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const TEST_POS_PORT = 3987;
const TEST_HELPER_PORT = 17399; // Test helper port
const SHOP_ID = 'test-hardware-shop';

console.log('[Test] Starting Mock Local eTIMS Helper...');

// 1. Mock Local Windows eTIMS Helper
const mockHelper = http.createServer((req, res) => {
  console.log(`[Mock Helper] Received ${req.method} ${req.url}`);
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      app: 'oraforge-etims-helper',
      version: 2,
      build: '20261017.1',
      runtime_mode: 'test',
      status: 'mock_active'
    }));
  }

  if (req.url === '/jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('[Mock Helper] Processing sale job...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: 'completed',
        fiscal: {
          cu_invoice_number: 'KRATESTCU2026102001',
          qr_code: 'https://itax.kra.go.ke/KRA-Portal/invoiceConfirmation.htm?cu=KRATESTCU2026102001',
          signature: 'MOCK_SIGNATURE_OK'
        }
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

mockHelper.listen(TEST_HELPER_PORT, '127.0.0.1', async () => {
  console.log(`[Test] Mock Helper listening on 127.0.0.1:${TEST_HELPER_PORT}`);

  // 2. Start Cloud POS Server (dev-server.js)
  console.log(`[Test] Launching Cloud POS Server on port ${TEST_POS_PORT}...`);
  const serverProc = spawn('node', [path.join(__dirname, '../dev-server.js')], {
    env: { ...process.env, PORT: String(TEST_POS_PORT), POS_DESKTOP: '0', POS_CLOUD_MODE: '1' },
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', d => process.stdout.write('[Cloud Server] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[Cloud Server ERR] ' + d));

  // Wait for server to start
  await new Promise(r => setTimeout(r, 2000));

  // 3. Test before agent connects: /api/etims/health should return 503
  console.log('\n[Test 1] Requesting /health before agent connects (expected: 503)...');
  const resBefore = await makeRequest('/api/etims/health', 'GET', null, SHOP_ID);
  console.log(`[Test 1] Result: HTTP ${resBefore.statusCode}, body:`, resBefore.body);
  if (resBefore.statusCode !== 503) {
    throw new Error(`Expected 503 before agent connect, got ${resBefore.statusCode}`);
  }
  console.log('[Test 1] Passed!\n');

  // 4. Start Cloud Tunnel Agent
  console.log('[Test] Starting Cloud Tunnel Agent...');
  const agentProc = spawn('node', [
    path.join(__dirname, '../etims-cloud-agent.js'),
    '--url', `http://127.0.0.1:${TEST_POS_PORT}`,
    '--shop', SHOP_ID,
    '--port', String(TEST_HELPER_PORT)
  ], { stdio: 'pipe' });

  agentProc.stdout.on('data', d => process.stdout.write('[Agent] ' + d));
  agentProc.stderr.on('data', d => process.stderr.write('[Agent ERR] ' + d));

  // Wait for agent to connect
  await new Promise(r => setTimeout(r, 2500));

  // 5. Test status endpoint
  console.log('\n[Test 2] Querying /api/etims/tunnel/status...');
  const statusRes = await makeRequest('/api/etims/tunnel/status', 'GET', null);
  console.log(`[Test 2] Status Result: HTTP ${statusRes.statusCode}, body:`, statusRes.body);
  const statusJson = JSON.parse(statusRes.body);
  if (!statusJson.tunnel_agents || statusJson.tunnel_agents.length === 0) {
    throw new Error('Expected connected tunnel agent in status list');
  }
  console.log('[Test 2] Passed!\n');

  // 6. Test /health after agent connected -> should forward to local helper and return 200
  console.log('[Test 3] Requesting /api/etims/health with agent connected (expected: 200)...');
  const healthRes = await makeRequest('/api/etims/health', 'GET', null, SHOP_ID);
  console.log(`[Test 3] Health Result: HTTP ${healthRes.statusCode}, body:`, healthRes.body);
  const healthJson = JSON.parse(healthRes.body);
  if (healthJson.app !== 'oraforge-etims-helper') {
    throw new Error('Health check did not return mock helper payload');
  }
  console.log('[Test 3] Passed!\n');

  // 7. Test /jobs invoice creation through tunnel
  console.log('[Test 4] Submitting sale to /api/etims/jobs through tunnel (expected: 202/200 with CU number)...');
  const salePayload = {
    sale: {
      id: 101,
      ticket_no: 'TK-101',
      items: [{ name: 'Iron Sheet 30G', qty: 5, price: 950, tax_rate: 'A' }]
    },
    confirmed_new_sale: true
  };
  const jobRes = await makeRequest('/api/etims/jobs', 'POST', salePayload, SHOP_ID);
  console.log(`[Test 4] Job Result: HTTP ${jobRes.statusCode}, body:`, jobRes.body);
  const jobJson = JSON.parse(jobRes.body);
  if (!jobJson.fiscal || jobJson.fiscal.cu_invoice_number !== 'KRATESTCU2026102001') {
    throw new Error('Job did not return valid fiscal invoice data');
  }
  console.log('[Test 4] Passed!\n');

  console.log('='.repeat(64));
  console.log('  🎉 ALL ETIMS WEBSOCKET TUNNEL TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('='.repeat(64) + '\n');

  // Clean up
  agentProc.kill();
  serverProc.kill();
  mockHelper.close(() => process.exit(0));
});

function makeRequest(path, method, body, shopId) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : null;
    const headers = {};
    if (shopId) headers['X-Oraforge-Shop'] = shopId;
    if (raw) {
      headers['Content-Type'] = 'application/json';
      headers['X-Oraforge-Etims'] = '2';
      headers['Content-Length'] = Buffer.byteLength(raw);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_POS_PORT,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}
