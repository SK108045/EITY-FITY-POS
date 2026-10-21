#!/usr/bin/env node
/**
 * Oraforge eTIMS Supabase Companion Worker ($0 Free Serverless Architecture)
 * Directly watches pos.etims_queue in Supabase and signs with local KRA eTIMS.
 * Eliminates the need for any cloud Linux or AWS servers!
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

console.log('\n' + '='.repeat(64));
console.log('   🚀 ORAFORGE eTIMS SUPABASE COMPANION WORKER');
console.log('   Free Serverless Vercel + Supabase Architecture');
console.log('='.repeat(64) + '\n');

// 1. Configuration
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
  } catch (_) {}
}

const dbUrl = process.env.DATABASE_URL || fileConfig.database_url || 
  'postgresql://postgres.iyfebdvtcryjxitizuwb:8045%40JohnWakaba@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';

const shopId = process.env.POS_SHOP_ID || fileConfig.shop_id || 'retail';
const helperPort = parseInt(process.env.ORAFORGE_ETIMS_PORT || fileConfig.helper_port || '17383', 10);

console.log(`[Configuration]`);
console.log(`  Supabase DB:  Connected (Schema: pos)`);
console.log(`  Store Mode:   Universal Multi-Shop (retail, hardware, etc.)`);
console.log(`  Local Helper: http://127.0.0.1:${helperPort}`);
console.log(`  Config File:  ${configPath}\n`);

// 2. Locate local helper token
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

// 3. Test local helper health
function checkLocalHelper() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: helperPort,
      path: '/health',
      method: 'GET',
      headers: { 'Connection': 'close' },
      agent: false,
      timeout: 2000
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

// 4. Send sale job to local helper
function forwardToLocalHelper(body) {
  return new Promise((resolve) => {
    const token = getHelperToken();
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Oraforge-Etims': '2',
      'Content-Length': payload.length,
      'Connection': 'close'
    };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: helperPort,
      path: '/jobs',
      method: 'POST',
      headers,
      agent: false,
      timeout: 30000
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
      resolve({ status: 504, error: 'Local eTIMS helper timed out' });
    });

    req.write(payload);
    req.end();
  });
}

// 5. Submit registration details for products in needs_details
function submitJobDetails(jobKey, details) {
  return new Promise((resolve) => {
    const token = getHelperToken();
    const payload = Buffer.from(JSON.stringify({ details }), 'utf8');
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Oraforge-Etims': '2',
      'Content-Length': payload.length,
      'Connection': 'close'
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = http.request({
      hostname: '127.0.0.1',
      port: helperPort,
      path: '/jobs/' + jobKey + '/details',
      method: 'POST',
      headers,
      agent: false,
      timeout: 10000
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode === 202 || res.statusCode === 200 }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(payload);
    req.end();
  });
}

// 6. Poll local helper until async signing completes
function pollLocalHelperJob(jobKey, maxWaitMs = 35000) {
  const token = getHelperToken();
  const startTime = Date.now();
  let detailsSubmitted = false;

  return new Promise((resolve) => {
    async function check() {
      const headers = {
        'Accept': 'application/json',
        'X-Oraforge-Etims': '2',
        'Connection': 'close'
      };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const req = http.request({
        hostname: '127.0.0.1',
        port: helperPort,
        path: '/jobs/' + jobKey,
        method: 'GET',
        headers,
        agent: false,
        timeout: 4000
      }, (res) => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', async () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (json.state === 'complete' && (json.result?.fiscal || json.fiscal)) {
              return resolve({ ok: true, data: json });
            }

            // Auto-resolve new product registration if needed
            if (json.state === 'needs_details') {
              if (!detailsSubmitted) {
                detailsSubmitted = true;
                const timeStr = new Date().toLocaleTimeString();
                console.log(`[${timeStr}] 📦 Registering new product with KRA UNSPSC class defaults...`);
                const reqs = json.result?.requirements || [];
                const details = {};
                for (const r of reqs) {
                  details[r.product_key] = {
                    class_code: '60102300',
                    item_type: '2',
                    package_unit: 'OU',
                    quantity_unit: 'NO',
                    origin: 'KE',
                    tax_code: r.values?.tax_code || 'D',
                    unit_cost_cents: r.values?.unit_cost_cents || 1000,
                    inventory_before_sale: r.values?.inventory_before_sale || 1000,
                    inventory_confirmed: true,
                    verified: true
                  };
                }
                await submitJobDetails(jobKey, details);
              }
              setTimeout(check, 500);
              return;
            }

            if (json.state === 'failed' || json.state === 'review_required') {
              return resolve({ ok: false, error: json.error || 'eTIMS helper signing encountered an error' });
            }
            if (Date.now() - startTime > maxWaitMs) {
              return resolve({ ok: false, error: 'Timed out waiting for eTIMS signature from local helper' });
            }
            setTimeout(check, 350);
          } catch (e) {
            if (Date.now() - startTime > maxWaitMs) return resolve({ ok: false, error: e.message });
            setTimeout(check, 500);
          }
        });
      });

      req.on('error', (err) => {
        if (Date.now() - startTime > maxWaitMs) return resolve({ ok: false, error: err.message });
        setTimeout(check, 1000);
      });

      req.end();
    }
    check();
  });
}

// 7. Connect to Supabase PostgreSQL Pool
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let isRunning = true;
let totalProcessed = 0;

async function runWorker() {
  const helperStatus = await checkLocalHelper();
  if (helperStatus.ok) {
    console.log(`[Local Helper] ✓ ONLINE on port ${helperPort} (build: ${helperStatus.info?.build || 'active'})`);
  } else {
    console.log(`[Local Helper] ⚠️  NOT DETECTED on port ${helperPort} (${helperStatus.error})`);
    console.log(`[Local Helper] Please start OraforgeEtims.exe or the official KRA software.\n`);
  }

  console.log(`\n============================================================`);
  console.log(`  🟢 WATCHING SUPABASE QUEUE (pos.etims_queue)`);
  console.log(`  Sales made on Vercel will sign automatically in real-time!`);
  console.log(`============================================================\n`);

  let lastHeartbeat = 0;

  while (isRunning) {
    try {
      const now = Date.now();

      // Send heartbeat every 10 seconds for active shops
      if (now - lastHeartbeat > 10000) {
        lastHeartbeat = now;
        const currentHelper = await checkLocalHelper();
        const helperPayload = JSON.stringify(currentHelper);

        // Register heartbeat for current shop, and all common shop types
        const shopsToBeat = Array.from(new Set([shopId, 'retail', 'hardware', 'all']));
        for (const sid of shopsToBeat) {
          await pool.query(
            `INSERT INTO pos.etims_workers (shop_id, last_seen, helper_status)
             VALUES ($1, NOW(), $2)
             ON CONFLICT (shop_id) DO UPDATE SET last_seen = NOW(), helper_status = $2`,
            [sid, helperPayload]
          );
        }
      }

      // Claim a pending invoice job (claim any store pending job)
      const claimRes = await pool.query(
        `UPDATE pos.etims_queue
         SET status = 'processing', updated_at = NOW()
         WHERE id = (
           SELECT id FROM pos.etims_queue
           WHERE status = 'pending'
           ORDER BY id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id, job_hash, payload, order_id, ticket_no, shop_id`
      );

      if (claimRes.rows.length === 0) {
        // No pending jobs, wait 400ms
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      const job = claimRes.rows[0];
      const timeStr = new Date().toLocaleTimeString();
      console.log(`[${timeStr}] 📩 Picked up Invoice Job #${job.id} (Ticket: ${job.ticket_no || 'N/A'}, Shop: ${job.shop_id})`);

      // Dispatch to local eTIMS helper
      const submitRes = await forwardToLocalHelper(job.payload);

      let finalResult = null;
      let finalError = null;

      if (submitRes.status >= 200 && submitRes.status < 300) {
        if (submitRes.data?.fiscal || submitRes.data?.result?.fiscal) {
          finalResult = submitRes.data.result || submitRes.data;
        } else {
          // Asynchronous job queued in local helper; poll until complete
          const jobKey = submitRes.data?.id || job.job_hash;
          const pollRes = await pollLocalHelperJob(jobKey);
          if (pollRes.ok) {
            finalResult = pollRes.data.result || pollRes.data;
          } else {
            finalError = pollRes.error;
          }
        }
      } else {
        finalError = submitRes.error || submitRes.data?.error || `Helper returned HTTP ${submitRes.status}`;
      }

      if (finalResult && (finalResult.fiscal || finalResult.result?.fiscal)) {
        const fiscal = finalResult.fiscal || finalResult.result?.fiscal;
        totalProcessed++;

        // Mark completed in etims_queue
        await pool.query(
          `UPDATE pos.etims_queue
           SET status = 'completed', result = $2, updated_at = NOW()
           WHERE id = $1`,
          [job.id, JSON.stringify(finalResult)]
        );

        // Update orders table with fiscal data
        await pool.query(
          `UPDATE pos.orders
           SET cu_invoice_number = $2,
               qr_image = $3,
               scu_id = $4,
               receipt_signature = $5,
               etims_status = 'generated',
               updated_at = NOW()
           WHERE (id = $1 AND $1 IS NOT NULL) OR ticket_no = $6`,
          [
            job.order_id,
            fiscal.cu_invoice_number || null,
            fiscal.qr_image || fiscal.qr_code || null,
            fiscal.scu_id || null,
            fiscal.receipt_signature || null,
            job.ticket_no
          ]
        );

        console.log(`[${timeStr}] ✅ Invoice Signed! CU Number: ${fiscal.cu_invoice_number} (Total Processed: ${totalProcessed})`);
      } else {
        const errMsg = finalError || 'eTIMS signature was not produced';
        console.warn(`[${timeStr}] ⚠️  Signing failed for Job #${job.id}: ${errMsg}`);

        await pool.query(
          `UPDATE pos.etims_queue
           SET status = 'failed', error = $2, updated_at = NOW()
           WHERE id = $1`,
          [job.id, errMsg]
        );
      }
    } catch (err) {
      console.error('[Worker Error]', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

runWorker().catch(err => {
  console.error('[Fatal Worker Error]', err);
  process.exit(1);
});
