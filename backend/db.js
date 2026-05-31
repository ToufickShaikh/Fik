// =============================================================================
// Fik — SQLite persistence layer (better-sqlite3, synchronous API)
// =============================================================================
// Replaces the flat-JSON files in backend/database/ with a proper relational
// store. Benefits: ~10× faster ingest, no full-file rewrites, indexed queries,
// WAL-mode concurrent access, and near-zero idle RAM (mmap, no in-process JSON
// heap).
//
// Schema
// ──────
//   scans    : one row per scan run (domain, timestamps, subdomains, live_services)
//   findings : normalised high/critical nuclei hits (FK → scans)
//
// Only HIGH and CRITICAL findings are stored — these are the "diamonds" that
// earn bounties. Info/low/medium are intentionally discarded at ingest time.
// =============================================================================

import { createRequire } from 'module';
import path              from 'path';
import fsSync            from 'fs';
import { fileURLToPath } from 'url';

const require    = createRequire(import.meta.url);
const Database   = require('better-sqlite3');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DB_PATH  = path.join(__dirname, 'database', 'fik.db');
const DB_DIR   = path.dirname(DB_PATH);

// Singleton connection — one per process lifetime.
let _db = null;

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
export function getDb() {
  if (_db) return _db;

  fsSync.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);

  // WAL: concurrent readers + 1 writer, fast fsync, safe on crash.
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous  = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size   = -32000'); // 32 MB page cache

  _db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      domain        TEXT    NOT NULL,
      generated_at  TEXT,
      subdomains    TEXT    DEFAULT '[]',
      live_services TEXT    DEFAULT '[]',
      created_at    TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scans_domain     ON scans(domain);
    CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);

    CREATE TABLE IF NOT EXISTS findings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      template_id TEXT,
      name        TEXT,
      severity    TEXT,
      matched_at  TEXT,
      host        TEXT,
      data        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_findings_scan_id  ON findings(scan_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
  `);

  _migrateJsonFiles(_db);

  return _db;
}

// ---------------------------------------------------------------------------
// One-time migration: import legacy scan_*.json files on first startup
// ---------------------------------------------------------------------------
function _migrateJsonFiles(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM scans').get();
  if (n > 0) return; // already populated, skip

  let files;
  try {
    files = fsSync.readdirSync(DB_DIR)
      .filter(f => f.startsWith('scan_') && f.endsWith('.json'))
      .sort();
  } catch { return; }

  for (const fileName of files) {
    try {
      const raw     = fsSync.readFileSync(path.join(DB_DIR, fileName), 'utf8');
      const payload = JSON.parse(raw);
      const domain  = Object.keys(payload)[0];
      if (!domain) continue;
      const node = payload[domain] ?? {};
      _insertScanTx(db,
        domain,
        node.generated_at   ?? null,
        node.subdomains      ?? [],
        node.live_services   ?? [],
        node.vulnerability_objects ?? [],
      );
    } catch { /* skip corrupt files */ }
  }
}

// ---------------------------------------------------------------------------
// Severity helper
// ---------------------------------------------------------------------------
function _severity(finding) {
  return ((finding?.info?.severity ?? finding?.severity ?? 'info')
    .toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Core transaction: insert one scan + its high/critical findings
// ---------------------------------------------------------------------------
function _insertScanTx(db, domain, generatedAt, subdomains, liveServices, vulnObjects) {
  const stmtScan = db.prepare(`
    INSERT INTO scans (domain, generated_at, subdomains, live_services)
    VALUES (?, ?, ?, ?)
  `);
  const stmtFinding = db.prepare(`
    INSERT INTO findings (scan_id, template_id, name, severity, matched_at, host, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return db.transaction(() => {
    const { lastInsertRowid: scanId } = stmtScan.run(
      domain,
      generatedAt ?? new Date().toISOString(),
      JSON.stringify(Array.isArray(subdomains)    ? subdomains    : []),
      JSON.stringify(Array.isArray(liveServices)  ? liveServices  : []),
    );

    for (const f of (vulnObjects ?? [])) {
      const sev = _severity(f);
      if (sev !== 'high' && sev !== 'critical') continue; // diamonds only

      stmtFinding.run(
        scanId,
        f?.template_id        ?? f?.['template-id'] ?? f?.template ?? null,
        f?.info?.name         ?? f?.template_name   ?? null,
        sev,
        f?.matched_at         ?? f?.['matched-at']  ?? null,
        f?.host               ?? null,
        JSON.stringify(f),
      );
    }

    return scanId;
  })();
}

// ---------------------------------------------------------------------------
// Public: write a new scan
// ---------------------------------------------------------------------------
export function insertScan(domain, generatedAt, subdomains, liveServices, vulnObjects) {
  return _insertScanTx(getDb(), domain, generatedAt, subdomains, liveServices, vulnObjects);
}

// ---------------------------------------------------------------------------
// Public: list scans (newest first, optional domain filter)
// ---------------------------------------------------------------------------
export function listScans(domain) {
  const db  = getDb();
  const sql = `
    SELECT s.id, s.domain, s.generated_at, s.created_at,
           COUNT(f.id) AS finding_count
    FROM   scans s
    LEFT JOIN findings f ON f.scan_id = s.id
    ${domain ? 'WHERE s.domain = ?' : ''}
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `;
  return domain ? db.prepare(sql).all(domain) : db.prepare(sql).all();
}

// ---------------------------------------------------------------------------
// Public: most recent scan payload (reconstructed)
// ---------------------------------------------------------------------------
export function getLatestScan(domain) {
  const db  = getDb();
  const sql = `SELECT * FROM scans ${domain ? 'WHERE domain = ?' : ''} ORDER BY created_at DESC LIMIT 1`;
  const row = domain ? db.prepare(sql).get(domain) : db.prepare(sql).get();
  return row ? _buildPayload(db, row) : null;
}

// ---------------------------------------------------------------------------
// Public: single scan by numeric id
// ---------------------------------------------------------------------------
export function getScanById(id) {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
  return row ? _buildPayload(db, row) : null;
}

// ---------------------------------------------------------------------------
// Internal: reconstruct the legacy JSON shape from a scans row
// ---------------------------------------------------------------------------
function _buildPayload(db, row) {
  const findings = db.prepare(`
    SELECT data FROM findings
    WHERE  scan_id = ?
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, id
  `).all(row.id);

  return {
    _scanId: row.id,
    [row.domain]: {
      generated_at:          row.generated_at,
      subdomains:            JSON.parse(row.subdomains    ?? '[]'),
      live_services:         JSON.parse(row.live_services ?? '[]'),
      vulnerability_objects: findings.map(f => JSON.parse(f.data)),
    },
  };
}
