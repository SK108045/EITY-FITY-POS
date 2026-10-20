/**
 * Vercel Serverless Function: POST /api/etims/jobs
 */
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
    const ticketNo = sale.ticket_no || '';
    const orderId = sale.sale_id || sale.id || null;
    const jobHash = 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

    // 1. Insert into Supabase etims_queue
    const insertRes = await pool.query(
      `INSERT INTO pos.etims_queue 
       (job_hash, shop_id, order_id, ticket_no, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
       RETURNING id, job_hash`,
      [jobHash, shopId, orderId ? Number(orderId) : null, ticketNo, JSON.stringify(body)]
    );

    const queueId = insertRes.rows[0].id;

    // 2. Poll for completion by the local Windows companion (up to 9 seconds)
    const maxPolls = 36;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));

      const { rows } = await pool.query(
        `SELECT status, result, error FROM pos.etims_queue WHERE id = $1`,
        [queueId]
      );

      if (rows.length > 0) {
        const item = rows[0];
        if (item.status === 'completed') {
          return res.status(200).json(item.result || { state: 'completed' });
        }
        if (item.status === 'failed') {
          return res.status(500).json({ error: item.error || 'eTIMS invoice issuance failed' });
        }
      }
    }

    // 3. If taking longer than 9s, return 202 Accepted so frontend polls
    return res.status(202).json({
      state: 'queued',
      job_id: jobHash,
      id: queueId,
      message: 'Invoice queued for signing'
    });
  } catch (err) {
    console.error('eTIMS jobs error:', err.message);
    return res.status(500).json({ error: 'Failed to queue eTIMS invoice: ' + err.message });
  }
};
