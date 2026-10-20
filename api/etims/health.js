/**
 * Vercel Serverless Function: GET /api/etims/health
 */
const pool = require('../db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Etims, X-Oraforge-Shop');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const shopId = req.headers['x-oraforge-shop'] || req.query?.shop_id || 'retail';

  try {
    const { rows } = await pool.query(
      `SELECT last_seen, helper_status, (NOW() - last_seen) < INTERVAL '60 seconds' AS is_online 
       FROM pos.etims_workers 
       WHERE shop_id = $1`,
      [shopId]
    );

    if (rows.length > 0 && rows[0].is_online) {
      return res.status(200).json({
        app: 'oraforge-etims-helper',
        version: 2,
        build: '20261017.1',
        status: 'ready',
        mode: 'supabase_queue',
        shop_id: shopId,
        last_seen: rows[0].last_seen
      });
    }

    return res.status(503).json({
      error: `Cashier eTIMS companion is not active on the store Windows PC for shop "${shopId}". Please open Start-Cloud-Agent.cmd on the cashier computer.`,
      status: 'offline',
      shop_id: shopId
    });
  } catch (err) {
    console.error('Health check database error:', err.message);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
