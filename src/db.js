import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is missing. Database endpoints will fail until configured.');
    return;
  }
  const schema = await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  await pool.query(schema);
}

export async function q(text, params = []) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return pool.query(text, params);
}
