/**
 * Vercel Serverless Function: POST /api/etims/jobs
 */
const crypto = require('crypto');
const pool = require('../db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Etims, X-Oraforge-Shop');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }

    const sale = body?.sale || {};
    const shopId = req.headers['x-oraforge-shop'] || sale.shop_id || 'retail';
    const ticketNo = sale.receipt_no || sale.ticket_no || '';
    const orderId = sale.sale_id || sale.id || 0;

    // Match the deterministic SHA256 helper job identity used by POS frontend
    const jobHash = crypto.createHash('sha256')
      .update(JSON.stringify([shopId, Number(orderId), String(ticketNo)]))
      .digest('hex');

    // 1. Check if this invoice is already completed
    const existing = await pool.query(
      `SELECT id, status, result, error FROM pos.etims_queue WHERE job_hash = $1 ORDER BY id DESC LIMIT 1`,
      [jobHash]
    );

    let queueId;
    if (existing.rows.length > 0 && existing.rows[0].status === 'completed') {
      return res.status(200).json({
        id: jobHash,
        state: 'complete',
        result: existing.rows[0].result
      });
    }

    if (existing.rows.length > 0 && (existing.rows[0].status === 'pending' || existing.rows[0].status === 'processing')) {
      queueId = existing.rows[0].id;
    } else {
      // Insert new pending job
      const insertRes = await pool.query(
        `INSERT INTO pos.etims_queue 
         (job_hash, shop_id, order_id, ticket_no, status, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
         RETURNING id`,
        [jobHash, shopId, orderId ? Number(orderId) : null, ticketNo, JSON.stringify(body)]
      );
      queueId = insertRes.rows[0].id;
    }

    // 2. Poll for completion by the cashier companion (up to 9.5 seconds)
    const maxPolls = 38;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));

      const { rows } = await pool.query(
        `SELECT status, result, error FROM pos.etims_queue WHERE id = $1`,
        [queueId]
      );

      if (rows.length > 0) {
        const item = rows[0];
        if (item.status === 'completed') {
          return res.status(200).json({
            id: jobHash,
            state: 'complete',
            result: item.result
          });
        }
        if (item.status === 'failed') {
          return res.status(500).json({
            id: jobHash,
            state: 'failed',
            error: item.error || 'eTIMS invoice issuance failed'
          });
        }
      }
    }

    // 3. If taking longer than 9.5s, return 202 Accepted so frontend sync() continues polling
    return res.status(202).json({
      id: jobHash,
      state: 'queued',
      message: 'Invoice queued for local signing'
    });
  } catch (err) {
    console.error('eTIMS jobs error:', err.message);
    return res.status(500).json({ error: 'Failed to queue eTIMS invoice: ' + err.message });
  }
};
