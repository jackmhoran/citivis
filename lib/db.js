import { Pool } from 'pg';

// Strip sslmode from the URL — we set ssl explicitly below so pg-connection-string
// doesn't override rejectUnauthorized with its own parsing of sslmode=require.
const rawUrl = process.env.DATABASE_URL || 'postgresql://localhost/citivis';
const connectionString = rawUrl.replace(/([?&])sslmode=[^&?#]*/g, '$1').replace(/[?&]$/, '');

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export default pool;
