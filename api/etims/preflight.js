/**
 * Vercel Serverless Function: POST /api/etims/preflight
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Etims, X-Oraforge-Shop');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Preflight is ready
  return res.status(200).json({
    ready: true,
    requirements: []
  });
};
