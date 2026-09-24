require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../src/db');

async function applyFile(filePath, name, track = true) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  if (track) {
    const existing = await pool.query(`SELECT checksum FROM schema_migrations WHERE migration_name=$1`, [name]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Migration ${name} changed after it was applied.`);
      console.log(`Already applied: ${name}`);
      return;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    if (track) await client.query(`INSERT INTO schema_migrations(migration_name,checksum) VALUES($1,$2)`, [name, checksum]);
    await client.query('COMMIT');
    console.log(`Applied: ${name}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

(async () => {
  try {
    // Baseline remains idempotent for existing ConsultHub installations.
    await applyFile(path.join(__dirname, '../db/schema.sql'), 'baseline-schema.sql', false);
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name VARCHAR(255) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const dir = path.join(__dirname, '../db/migrations');
    const migrations = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort() : [];
    for (const file of migrations) await applyFile(path.join(dir,file), file, true);
    console.log('Database migration completed.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
