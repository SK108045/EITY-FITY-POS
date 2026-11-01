/**
 * Supabase PostgreSQL Connection Pool for Vercel Serverless Functions
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

let pool;

if (!global.__dbPool) {
  global.__dbPool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

pool = global.__dbPool;

module.exports = pool;
