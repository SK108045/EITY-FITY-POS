/**
 * Vercel Serverless Function: GET /api/etims/jobs/[id]
 */
const pool = require('../../db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Etims, X-Oraforge-Shop');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing job ID' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT status, result, error FROM pos.etims_queue 
       WHERE job_hash = $1 OR id::text = $1
       ORDER BY id DESC LIMIT 1`,
      [String(id)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invoice job not found' });
    }

    const job = rows[0];
    if (job.status === 'completed') {
      return res.status(200).json({
        state: 'complete',
        result: job.result
      });
    }

    if (job.status === 'failed') {
      return res.status(500).json({
        state: 'failed',
        error: job.error || 'Invoice signing failed'
      });
    }

    return res.status(200).json({
      state: 'queued',
      status: job.status
    });
  } catch (err) {
    console.error('Job query error:', err.message);
    return res.status(500).json({ error: 'Database query error: ' + err.message });
  }
};
