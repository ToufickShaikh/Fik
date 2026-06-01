// =============================================================================
// FIK Bug Bounty Framework — Backend API Server
// ES Module · Express · ws · node-cron
// =============================================================================

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { insertScan, listScans, getLatestScan, getScanById } from './db.js';

// ---------------------------------------------------------------------------
// ES-module equivalent of __dirname
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------
const BACKEND_DIR           = __dirname;
// FRAMEWORK_DIR can be overridden via env so Docker containers can find main.sh
// even though the backend image only contains /app (backend files).
// docker-compose mounts the repo root at /framework and sets FRAMEWORK_DIR=/framework.
const FRAMEWORK_DIR         = process.env.FRAMEWORK_DIR || path.join(BACKEND_DIR, '..');
const DATABASE_DIR          = path.join(BACKEND_DIR, 'database');

// Resolve bash at startup — works on Linux (/bin/bash or /usr/bin/bash),
// macOS, and Windows Git-bash/WSL. Falls back to 'bash' (relies on PATH).
const BASH_PATH = (() => {
  const candidates = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  for (const c of candidates) {
    try {
      const st = fsSync.statSync(c);
      if (st.isFile()) return c;
    } catch { /**/ }
  }
  return 'bash'; // last resort: rely on PATH
})();
const TARGETS_FILE          = path.join(BACKEND_DIR, 'targets.json');
const SETTINGS_FILE         = path.join(BACKEND_DIR, 'settings.json');
const REPORTS_DIR           = path.join(BACKEND_DIR, 'reports');
const REPORT_GENERATOR_PATH = path.join(BACKEND_DIR, 'report_generator.js');

const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// Default settings — merged over stored values so new keys always exist.
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  geminiApiKey:       '',
  proxyUrl:           '',
  defaultConcurrency: 50,
  nucleiConcurrency:  25,
  swapFileSizeGB:     2,
  enableSwapOnLowMem: true,
};

// =============================================================================
// Express app
// =============================================================================
const app = express();

// Allow the Vite dev-server and any localhost origin during development.
app.use(cors({
  origin: (origin, cb) => {
    // Permit requests with no origin (curl, Postman) and any localhost port.
    if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '20mb' }));

// =============================================================================
// HTTP + WebSocket server (share the same port via the 'upgrade' event)
// =============================================================================
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

// Route WS upgrade requests — only /ws/logs is handled.
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/logs') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

/** Broadcast a JSON message to every open WS client. */
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data);
  }
}

// =============================================================================
// Active scan state — one scan at a time.
// =============================================================================
/**
 * @type {{ child: import('child_process').ChildProcess,
 *          domain: string, profile: string,
 *          pid: number, paused: boolean, startedAt: string } | null}
 */
let activeScan  = null;
const cronJobs  = new Map(); // targetId -> cron.ScheduledTask
let prevCpuStats = null;     // for delta-based CPU% from /proc/stat

// =============================================================================
// Logging helpers
// =============================================================================
function logInfo(msg)  { console.log(`[${new Date().toISOString()}] [INFO]  ${msg}`); }
function logError(msg) { console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`); }

// =============================================================================
// File helpers
// =============================================================================

/** Read targets.json, returning [] on first run or parse failure. */
async function loadTargets() {
  try {
    const raw = await fs.readFile(TARGETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Persist the targets array atomically. */
async function saveTargets(targets) {
  await fs.writeFile(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf8');
}

/** Read settings.json, merging defaults so new keys are always present. */
async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

/** Persist settings. */
async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

/** List Markdown reports sorted newest-first. */
async function listReports() {
  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const entries = await fs.readdir(REPORTS_DIR, { withFileTypes: true });
    const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
    const withStats = await Promise.all(
      mdFiles.map(async (name) => {
        const stat = await fs.stat(path.join(REPORTS_DIR, name));
        return { name, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      }),
    );
    return withStats.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

// Legacy JSON helper retained only for the report generator fallback path.
// New code reads from SQLite via db.js.
async function getMostRecentJsonFile(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const jsons   = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => e.name);
    if (!jsons.length) return null;
    const withMtime = await Promise.all(
      jsons.map(async (name) => {
        const stat = await fs.stat(path.join(dir, name));
        return { fullPath: path.join(dir, name), mtime: stat.mtimeMs };
      }),
    );
    return withMtime.sort((a, b) => b.mtime - a.mtime)[0].fullPath;
  } catch { return null; }
}

/** Timestamp + random suffix ID. */
function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ensure the database directory exists. */
async function ensureDatabaseDir() {
  await fs.mkdir(DATABASE_DIR, { recursive: true });
}

// =============================================================================
// Resource stats  (Linux /proc — gracefully returns zeros on other OS)
// =============================================================================
async function getResourceStats() {
  // ── CPU via /proc/stat delta ─────────────────────────────────────────────
  let cpuPercent = 0;
  try {
    const raw     = await fs.readFile('/proc/stat', 'utf8');
    const cpuLine = raw.split('\n').find((l) => l.startsWith('cpu '));
    if (cpuLine) {
      const nums  = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      const idle  = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
      const total = nums.reduce((a, b) => a + b, 0);
      if (prevCpuStats) {
        const dIdle  = idle  - prevCpuStats.idle;
        const dTotal = total - prevCpuStats.total;
        cpuPercent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
      }
      prevCpuStats = { idle, total };
    }
  } catch { /* not Linux */ }

  // ── Memory via /proc/meminfo ──────────────────────────────────────────────
  let ramUsedMB = 0, ramTotalMB = 0, ramPercent = 0;
  let swapUsedMB = 0, swapTotalMB = 0, swapPercent = 0;
  try {
    const raw  = await fs.readFile('/proc/meminfo', 'utf8');
    const kbOf = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    ramTotalMB  = Math.round(kbOf('MemTotal')     / 1024);
    ramUsedMB   = ramTotalMB - Math.round(kbOf('MemAvailable') / 1024);
    ramPercent  = ramTotalMB  > 0 ? Math.round((ramUsedMB  / ramTotalMB)  * 100) : 0;
    swapTotalMB = Math.round( kbOf('SwapTotal')   / 1024);
    swapUsedMB  = Math.round((kbOf('SwapTotal') - kbOf('SwapFree')) / 1024);
    swapPercent = swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0;
  } catch { /* not Linux */ }

  return { cpuPercent, ramUsedMB, ramTotalMB, ramPercent, swapUsedMB, swapTotalMB, swapPercent };
}

// =============================================================================
// Shared scan launcher
// =============================================================================

/** Build the process environment for a scan. */
function buildScanEnv(settings, profile) {
  return {
    ...process.env,
    SCAN_PROFILE: profile,
    ...(settings.proxyUrl           && { PROXY:              settings.proxyUrl }),
    ...(settings.defaultConcurrency && { CONCURRENCY:        String(settings.defaultConcurrency) }),
    ...(settings.nucleiConcurrency  && { NUCLEI_CONCURRENCY: String(settings.nucleiConcurrency) }),
    ...(settings.geminiApiKey       && { GEMINI_API_KEY:     settings.geminiApiKey }),
  };
}

/**
 * Spawn main.sh for domain/profile.
 * Wires stdout/stderr to broadcast(), manages activeScan.
 * Throws if a scan is already running.
 */
async function triggerScan(domain, profile = 'standard') {
  if (activeScan) throw new Error('A scan is already running.');

  const settings   = await loadSettings();
  const scriptPath = path.join(FRAMEWORK_DIR, 'main.sh');

  const child = spawn(BASH_PATH, [scriptPath, '-d', domain, '-p', profile], {
    cwd:      FRAMEWORK_DIR,
    env:      buildScanEnv(settings, profile),
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: true, // negative PID signals work on the whole bash tree
  });

  activeScan = { child, domain, profile, startedAt: new Date().toISOString(), pid: child.pid, paused: false };
  broadcast({ type: 'status', status: 'started', domain, profile, pid: child.pid });
  logInfo(`Scan started — domain=${domain} profile=${profile} pid=${child.pid}`);

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) broadcast({ type: 'log', stream: 'stdout', line });
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) broadcast({ type: 'log', stream: 'stderr', line });
    }
  });
  child.on('error', (err) => {
    logError(`Scan process error: ${err.message}`);
    broadcast({ type: 'status', status: 'error', message: err.message });
    activeScan = null;
  });
  child.on('close', (code) => {
    logInfo(`Scan closed with code ${code}`);
    broadcast({ type: 'status', status: 'stopped', code });
    activeScan = null;
  });

  return { pid: child.pid };
}

// =============================================================================
// Cron job management
// =============================================================================

function registerCronJob(target) {
  if (!target.schedule || !cron.validate(target.schedule)) {
    if (target.schedule) logError(`[cron] Invalid expression for ${target.id}: "${target.schedule}"`);
    return;
  }
  const task = cron.schedule(target.schedule, () => {
    if (activeScan) {
      logInfo(`[cron] Skipping ${target.domain} — scan already running`);
      return;
    }
    logInfo(`[cron] Triggering scheduled scan for ${target.domain}`);
    triggerScan(target.domain, 'standard').catch((e) =>
      logError(`[cron] Scan failed for ${target.domain}: ${e.message}`),
    );
  });
  cronJobs.set(target.id, task);
  logInfo(`[cron] Registered "${target.schedule}" for ${target.domain}`);
}

function unregisterCronJob(targetId) {
  const task = cronJobs.get(targetId);
  if (task) { task.stop(); cronJobs.delete(targetId); }
}

async function initCronJobs() {
  const targets = await loadTargets().catch(() => []);
  for (const t of targets) { if (t.schedule) registerCronJob(t); }
  if (cronJobs.size > 0) logInfo(`[cron] Initialized ${cronJobs.size} scheduled scan(s).`);
}

// =============================================================================
// WebSocket connection handler
// =============================================================================
wss.on('connection', async (ws) => {
  // 1. Sync scan status immediately so the UI is consistent on reconnect.
  const statusMsg = activeScan
    ? { type: 'status', status: activeScan.paused ? 'paused' : 'running',
        domain: activeScan.domain, profile: activeScan.profile, pid: activeScan.pid }
    : { type: 'status', status: 'idle' };
  ws.send(JSON.stringify(statusMsg));

  // 2. Send an immediate resource snapshot so gauges render right away.
  try {
    const snap = await getResourceStats();
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resources', ...snap }));
  } catch { /* ignore */ }

  // 3. Handle inbound control messages from the client.
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'pause_scan') {
      if (!activeScan || activeScan.paused) return;
      try {
        process.kill(-activeScan.pid, 'SIGSTOP'); // negative PID = whole process group
        activeScan.paused = true;
        broadcast({ type: 'status', status: 'paused', domain: activeScan.domain, pid: activeScan.pid });
        broadcast({ type: 'log', stream: 'stdout', line: '[SYSTEM] Scan paused.' });
        logInfo(`Scan paused (SIGSTOP) — group -${activeScan.pid}`);
      } catch (err) {
        logError(`SIGSTOP failed: ${err.message}`);
        ws.send(JSON.stringify({ type: 'log', stream: 'stderr',
          line: `[SYSTEM] Pause not supported on this OS: ${err.message}` }));
      }

    } else if (msg.type === 'resume_scan') {
      if (!activeScan || !activeScan.paused) return;
      try {
        process.kill(-activeScan.pid, 'SIGCONT');
        activeScan.paused = false;
        broadcast({ type: 'status', status: 'running', domain: activeScan.domain, pid: activeScan.pid });
        broadcast({ type: 'log', stream: 'stdout', line: '[SYSTEM] Scan resumed.' });
        logInfo(`Scan resumed (SIGCONT) — group -${activeScan.pid}`);
      } catch (err) {
        logError(`SIGCONT failed: ${err.message}`);
        ws.send(JSON.stringify({ type: 'log', stream: 'stderr',
          line: `[SYSTEM] Resume not supported on this OS: ${err.message}` }));
      }
    }
  });
});

// Broadcast resource stats every 2 s (no-op when no clients connected).
setInterval(async () => {
  if (wss.clients.size === 0) return;
  try { broadcast({ type: 'resources', ...(await getResourceStats()) }); } catch { /* ignore */ }
}, 2000);

// =============================================================================
// Routes
// =============================================================================

// ---------------------------------------------------------------------------
// 1. GET /api/targets — list all targets
// ---------------------------------------------------------------------------
app.get('/api/targets', async (req, res, next) => {
  try {
    return res.status(200).json(await loadTargets());
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 2. POST /api/targets — create a target
// ---------------------------------------------------------------------------
app.post('/api/targets', async (req, res, next) => {
  try {
    const { domain, includeScope = '', excludeScope = '', notes = '' } = req.body ?? {};

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required and must be a string.' });
    }
    // Reject shell-unsafe characters before they ever reach bash.
    if (!/^[a-zA-Z0-9._-]+$/.test(domain.trim())) {
      return res.status(400).json({ error: 'domain may only contain letters, numbers, dots, hyphens, and underscores.' });
    }

    const targets = await loadTargets();
    const now     = new Date().toISOString();
    const target  = {
      id:           makeId(),
      domain:       domain.trim(),
      includeScope: String(includeScope),
      excludeScope: String(excludeScope),
      notes:        String(notes),
      createdAt:    now,
      updatedAt:    now,
    };

    targets.push(target);
    await saveTargets(targets);
    logInfo(`Target added: ${target.domain} (${target.id})`);
    return res.status(201).json(target);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 3. PUT /api/targets/:id — update a target
// ---------------------------------------------------------------------------
app.put('/api/targets/:id', async (req, res, next) => {
  try {
    const targets = await loadTargets();
    const idx     = targets.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found.' });

    const { domain, includeScope, excludeScope, notes } = req.body ?? {};
    if (domain !== undefined && !/^[a-zA-Z0-9._-]+$/.test(String(domain).trim())) {
      return res.status(400).json({ error: 'Invalid domain format.' });
    }

    targets[idx] = {
      ...targets[idx],
      ...(domain       !== undefined && { domain:       String(domain).trim() }),
      ...(includeScope !== undefined && { includeScope: String(includeScope) }),
      ...(excludeScope !== undefined && { excludeScope: String(excludeScope) }),
      ...(notes        !== undefined && { notes:        String(notes) }),
      updatedAt: new Date().toISOString(),
    };

    await saveTargets(targets);
    logInfo(`Target updated: ${targets[idx].domain} (${req.params.id})`);
    return res.status(200).json(targets[idx]);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 4. DELETE /api/targets/:id
// ---------------------------------------------------------------------------
app.delete('/api/targets/:id', async (req, res, next) => {
  try {
    const targets  = await loadTargets();
    const filtered = targets.filter((t) => t.id !== req.params.id);
    if (filtered.length === targets.length) return res.status(404).json({ error: 'Target not found.' });

    unregisterCronJob(req.params.id);
    await saveTargets(filtered);
    logInfo(`Target deleted: ${req.params.id}`);
    return res.status(204).send();
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 5. POST /api/scan/start — launch main.sh
// ---------------------------------------------------------------------------
app.post('/api/scan/start', async (req, res, next) => {
  try {
    if (activeScan) {
      return res.status(409).json({ error: 'A scan is already running.', pid: activeScan.pid });
    }

    let { domain, profile = 'standard', targetId } = req.body ?? {};

    // Resolve domain from a saved target when targetId is provided.
    if (targetId) {
      const targets = await loadTargets();
      const target  = targets.find((t) => t.id === targetId);
      if (!target) return res.status(404).json({ error: 'Target not found.' });
      domain = target.domain;
    }

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required.' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(domain.trim())) {
      return res.status(400).json({ error: 'Invalid domain. Only alphanumerics, dots, hyphens, and underscores are allowed.' });
    }

    const validProfiles = ['quick', 'standard', 'deep'];
    if (!validProfiles.includes(profile)) {
      return res.status(400).json({ error: `profile must be one of: ${validProfiles.join(', ')}` });
    }

    const { pid } = await triggerScan(domain.trim(), profile);
    return res.status(202).json({ message: 'Scan started.', pid, domain, profile });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 6. POST /api/scan/stop — SIGTERM the scan process group
// ---------------------------------------------------------------------------
app.post('/api/scan/stop', (req, res) => {
  if (!activeScan) return res.status(404).json({ error: 'No active scan.' });

  try {
    // Resume first if paused — SIGTERM is masked while a process is stopped.
    if (activeScan.paused) process.kill(-activeScan.pid, 'SIGCONT');
    process.kill(-activeScan.pid, 'SIGTERM');
  } catch {
    activeScan.child.kill('SIGTERM'); // fallback on non-Linux
  }

  logInfo(`SIGTERM sent to process group -${activeScan.pid}`);
  return res.status(200).json({ stopped: true, pid: activeScan.pid });
});

// ---------------------------------------------------------------------------
// 7. GET /api/scan/status
// ---------------------------------------------------------------------------
app.get('/api/scan/status', (req, res) => {
  if (!activeScan) return res.status(200).json({ running: false, pid: null });
  return res.status(200).json({
    running:   true,
    paused:    activeScan.paused,
    pid:       activeScan.pid,
    domain:    activeScan.domain,
    profile:   activeScan.profile,
    startedAt: activeScan.startedAt,
  });
});

// ---------------------------------------------------------------------------
// 8. GET /api/tech/:domain — tech-detection on demand
// ---------------------------------------------------------------------------
app.get('/api/tech/:domain', async (req, res, next) => {
  try {
    const { domain } = req.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain.' });
    }

    const techScript = path.join(FRAMEWORK_DIR, 'modules', 'tech_detector.sh');
    const tagsConfig = path.join(FRAMEWORK_DIR, 'config', 'tech_to_tags.json');

    // Run tech_detector.sh with a 30 s safety timeout.
    const rawOutput = await new Promise((resolve) => {
      let out = '';
      const child = spawn(BASH_PATH, [techScript, domain], {
        cwd:   FRAMEWORK_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => resolve(out.trim() || 'unknown'));
      child.on('error', () => resolve('unknown'));
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve('unknown'); }, 30_000);
      child.on('close', () => clearTimeout(timer));
    });

    const techs = rawOutput === 'unknown' ? [] : rawOutput.split(',').map((t) => t.trim()).filter(Boolean);

    // Map technologies → Nuclei tags.
    const tagSet = new Set();
    try {
      const raw    = await fs.readFile(tagsConfig, 'utf8');
      const tagMap = JSON.parse(raw);
      for (const tech of techs) {
        const mapped = tagMap[tech.toLowerCase()];
        if (Array.isArray(mapped)) mapped.forEach((t) => tagSet.add(t));
      }
      if (tagSet.size === 0) {
        (tagMap.unknown ?? []).forEach((t) => tagSet.add(t));
      }
    } catch { /* config absent — return empty tags */ }

    return res.status(200).json({
      domain,
      techs,
      tags:          [...tagSet],
      nucleiTagsArg: tagSet.size > 0 ? [...tagSet].join(',') : 'cve,exposure',
    });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 9. GET /api/settings
// ---------------------------------------------------------------------------
app.get('/api/settings', async (req, res, next) => {
  try {
    return res.status(200).json(await loadSettings());
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 10. PUT /api/settings
// ---------------------------------------------------------------------------
app.put('/api/settings', async (req, res, next) => {
  try {
    const current = await loadSettings();
    const { geminiApiKey, proxyUrl, defaultConcurrency, nucleiConcurrency,
            swapFileSizeGB, enableSwapOnLowMem } = req.body ?? {};

    const updated = {
      ...current,
      ...(geminiApiKey       !== undefined && { geminiApiKey:       String(geminiApiKey).trim() }),
      ...(proxyUrl           !== undefined && { proxyUrl:           String(proxyUrl).trim() }),
      ...(defaultConcurrency !== undefined && { defaultConcurrency: Math.max(1, Number(defaultConcurrency) || current.defaultConcurrency) }),
      ...(nucleiConcurrency  !== undefined && { nucleiConcurrency:  Math.max(1, Number(nucleiConcurrency)  || current.nucleiConcurrency) }),
      ...(swapFileSizeGB     !== undefined && { swapFileSizeGB:     Math.max(1, Number(swapFileSizeGB)     || current.swapFileSizeGB) }),
      ...(enableSwapOnLowMem !== undefined && { enableSwapOnLowMem: Boolean(enableSwapOnLowMem) }),
    };

    await saveSettings(updated);
    logInfo('Settings updated.');
    return res.status(200).json(updated);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// 11. POST /api/report/generate — run report_generator.js, wait, return list
// ---------------------------------------------------------------------------
app.post('/api/report/generate', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const { domain } = (req.body ?? {});
    // NOTE: API key is now OPTIONAL. Without a key, the generator writes a rich
    // static "learning report" from the recon artifacts (no AI narrative). With
    // a key it adds the full Gemini-generated walkthrough + per-finding deep dives.
    const extraEnv = {
      ...(settings.geminiApiKey && { GEMINI_API_KEY: settings.geminiApiKey }),
      ...(domain && /^[a-zA-Z0-9._-]+$/.test(String(domain)) && { REPORT_DOMAIN: String(domain).trim() }),
    };

    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
        cwd:   BACKEND_DIR,
        env:   { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stdout.on('data', (d) => logInfo(`[report_generator] ${d.toString().trim()}`));
      child.stderr.on('data', (d) => { stderrBuf += d.toString(); logError(`[report_generator] ${d.toString().trim()}`); });
      child.on('error',  reject);
      child.on('close',  (code) => {
        // 0 = ok, 2 = soft-fail (static-only report or no AI key); anything else is an error.
        if (code === 0 || code === 2) resolve(code);
        else reject(new Error(`report_generator exited ${code}: ${stderrBuf.slice(-400)}`));
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Report generation timed out after 180 s'));
      }, 180_000);
      child.on('close', () => clearTimeout(timer));
    });

    const allReports = await listReports();
    // Always surface the educational learning report first when present (the
    // frontend opens reports[0] after generation). Fall back to mtime order.
    const reports = [...allReports].sort((a, b) => {
      const aLearn = a.name.startsWith('learning_report_') ? 0 : 1;
      const bLearn = b.name.startsWith('learning_report_') ? 0 : 1;
      if (aLearn !== bLearn) return aLearn - bLearn;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    return res.status(200).json({
      message: exitCode === 2
        ? (settings.geminiApiKey
            ? 'Report generator finished (some steps soft-failed — see logs).'
            : 'Static learning report generated. Add a Gemini API key in Settings for the full AI walkthrough.')
        : 'Reports generated.',
      reports,
    });
  } catch (err) {
    logError(`Report generation failed: ${err.message}`);
    return res.status(503).json({ error: 'Report generation failed.', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reports — list + download
// ---------------------------------------------------------------------------

app.get('/api/reports', async (req, res, next) => {
  try {
    return res.status(200).json(await listReports());
  } catch (err) { return next(err); }
});

// GET /api/reports/:filename  — path-traversal-safe download (or inline preview)
// Pass ?preview=1 to render in the browser tab instead of forcing a download.
app.get('/api/reports/:filename', async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    try {
      const content = await fs.readFile(path.join(REPORTS_DIR, filename), 'utf8');
      const preview = req.query.preview === '1' || req.query.preview === 'true';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      // Inline = browser displays the Markdown source; attachment = downloads.
      res.setHeader('Content-Disposition',
        `${preview ? 'inline' : 'attachment'}; filename="${filename}"`);
      return res.status(200).send(content);
    } catch {
      return res.status(404).json({ error: 'Report not found.' });
    }
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Scan history
// ---------------------------------------------------------------------------

// GET /api/scans?domain=<domain>
app.get('/api/scans', (req, res, next) => {
  try {
    const { domain } = req.query;
    const rows = listScans(domain || null);
    const scans = rows.map(r => ({
      id:           r.id,
      domain:       r.domain,
      scanDate:     r.created_at,
      generatedAt:  r.generated_at,
      findingCount: r.finding_count,
    }));
    return res.status(200).json(scans);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Data ingest — called by exporter.sh at end of scan
// ---------------------------------------------------------------------------
app.post('/api/ingest', async (req, res, next) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'Payload must be a JSON object.' });
    }

    const domain = Object.keys(payload)[0];
    if (!domain) return res.status(400).json({ error: 'Payload has no target key.' });

    const node    = payload[domain] ?? {};
    const scanId  = insertScan(
      domain,
      node.generated_at        ?? new Date().toISOString(),
      node.subdomains          ?? [],
      node.live_services       ?? [],
      node.vulnerability_objects ?? [],
    );
    logInfo(`Ingest saved to SQLite: domain=${domain} scanId=${scanId}`);

    // Fire-and-forget: generate report in the background after ingest.
    const settings = await loadSettings();
    if (settings.geminiApiKey) {
      const extraEnv = { GEMINI_API_KEY: settings.geminiApiKey, REPORT_DOMAIN: domain };
      const rg = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
        cwd:   BACKEND_DIR,
        env:   { ...process.env, ...extraEnv },
        stdio: 'ignore',
      });
      rg.on('error', (e) => logError(`report_generator spawn error: ${e.message}`));
    } else {
      logInfo('No Gemini API key set — skipping auto report generation. (Configure in Settings.)');
    }

    return res.status(202).json({ message: 'Payload accepted.', scanId });
  } catch (err) { return next(err); }
});

// GET /api/data — most-recent scan payload (drives the vulnerability table)
app.get('/api/data', (req, res, next) => {
  try {
    const { domain } = req.query;
    const payload = getLatestScan(domain || null);
    if (!payload) return res.status(404).json({ error: 'No scan data found.' });
    const { _scanId, ...data } = payload; // strip internal field before sending
    return res.status(200).json(data);
  } catch (err) { return next(err); }
});

// GET /api/data/:id — single scan by SQLite id
app.get('/api/data/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid scan id.' });
    const payload = getScanById(id);
    if (!payload) return res.status(404).json({ error: 'Scan not found.' });
    const { _scanId, ...data } = payload;
    return res.status(200).json(data);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Scheduler — POST /api/targets/:id/schedule
// ---------------------------------------------------------------------------
app.post('/api/targets/:id/schedule', async (req, res, next) => {
  try {
    const targets = await loadTargets();
    const idx     = targets.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found.' });

    const { cronExpression } = req.body ?? {};
    unregisterCronJob(req.params.id);

    if (cronExpression && typeof cronExpression === 'string' && cronExpression.trim()) {
      if (!cron.validate(cronExpression.trim())) {
        return res.status(400).json({ error: 'Invalid cron expression.' });
      }
      targets[idx].schedule = cronExpression.trim();
    } else {
      delete targets[idx].schedule;
    }

    targets[idx].updatedAt = new Date().toISOString();
    await saveTargets(targets);
    if (targets[idx].schedule) registerCronJob(targets[idx]);
    return res.status(200).json(targets[idx]);
  } catch (err) { return next(err); }
});

// =============================================================================
// Bug-Bounty scope-restricted scan
// =============================================================================
//
// POST /api/bugbounty/scan
//   body: { scopeText: string, profile?: 'quick'|'standard'|'deep',
//           label?: string, notes?: string }
//
// Parses a free-form in-scope list (one per line, supports wildcards like
// https://x.com/admin/*), derives:
//   - root domain (first parsed URL's hostname)
//   - includeScope regex (passed through scope.sh)
// Creates/updates a saved target and launches a STRICT_SCOPE scan that will
// never touch out-of-scope hosts.
// =============================================================================

function _parseScopeText(scopeText) {
  // Extract URLs or host[/path[/*]] tokens from arbitrary pasted text.
  const tokens = new Set();
  const urlRe  = /https?:\/\/[^\s`'")>\]]+/gi;
  const m1     = String(scopeText || '').match(urlRe) || [];
  m1.forEach((u) => tokens.add(u.replace(/[.,)\]]+$/, '')));
  // Also accept bare host lines like "example.com/*"
  String(scopeText || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim().replace(/^[`*\-\s]+/, '').replace(/[`*\s]+$/, '');
    if (/^[a-z0-9.-]+(\/.*)?$/i.test(t) && t.includes('.')) tokens.add(t);
  });
  const list = [...tokens]
    .map(s => s.replace(/^https?:\/\//, ''))     // strip scheme
    .map(s => s.replace(/\/+$/, ''))             // trim trailing slash (preserves /*)
    .filter(Boolean);
  // Derive root domain from the first token: hostname minus path.
  let rootHost = '';
  for (const t of list) {
    const h = t.split('/')[0];
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)) { rootHost = h; break; }
  }
  return { tokens: list, rootHost };
}

app.post('/api/bugbounty/scan', async (req, res, next) => {
  try {
    const { scopeText, profile = 'standard', label, notes = '' } = req.body ?? {};
    if (!scopeText || typeof scopeText !== 'string' || scopeText.trim().length < 3) {
      return res.status(400).json({ error: 'scopeText is required.' });
    }
    if (!['quick','standard','deep'].includes(profile)) {
      return res.status(400).json({ error: 'Invalid profile.' });
    }
    if (activeScan) {
      return res.status(409).json({ error: 'A scan is already running.', pid: activeScan.pid });
    }

    const { tokens, rootHost } = _parseScopeText(scopeText);
    if (!rootHost) {
      return res.status(400).json({ error: 'Could not derive a root domain from the provided scope.' });
    }
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'No in-scope URLs parsed.' });
    }

    // Persist as a target so future runs / reports stay attached to this program.
    const targets    = await loadTargets();
    const safeDomain = rootHost.toLowerCase();
    const now        = new Date().toISOString();
    let target       = targets.find(t => t.domain.toLowerCase() === safeDomain);
    const includeScope = tokens.join('\n');
    if (!target) {
      target = {
        id: makeId(),
        domain: safeDomain,
        includeScope,
        excludeScope: '',
        notes: (label ? `[BugBounty] ${label}\n` : '[BugBounty]\n') + String(notes),
        createdAt: now, updatedAt: now,
      };
      targets.push(target);
    } else {
      target.includeScope = includeScope;
      target.notes        = (label ? `[BugBounty] ${label}\n` : target.notes || '') + (notes ? `\n${notes}` : '');
      target.updatedAt    = now;
    }
    await saveTargets(targets);

    // Launch scan with STRICT_SCOPE so subdomains.sh & friends drop OOS hosts.
    const settings = await loadSettings();
    const env = { ...buildScanEnv(settings, profile), STRICT_SCOPE: '1' };
    const scriptPath = path.join(FRAMEWORK_DIR, 'main.sh');
    const child = spawn(BASH_PATH, [scriptPath, '-d', safeDomain, '-p', profile], {
      cwd: FRAMEWORK_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    activeScan = { child, domain: safeDomain, profile, startedAt: now, pid: child.pid, paused: false };
    broadcast({ type: 'status', status: 'started', domain: safeDomain, profile, pid: child.pid });
    logInfo(`BugBounty scan started — domain=${safeDomain} tokens=${tokens.length} pid=${child.pid}`);

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) if (line) broadcast({ type: 'log', stream: 'stdout', line });
    });
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) if (line) broadcast({ type: 'log', stream: 'stderr', line });
    });
    child.on('error', (err) => { broadcast({ type: 'status', status: 'error', message: err.message }); activeScan = null; });
    child.on('close', (code) => { broadcast({ type: 'status', status: 'stopped', code }); activeScan = null; });

    return res.status(202).json({
      message: 'Bug-bounty scan started.',
      pid: child.pid, domain: safeDomain, profile,
      scopeTokens: tokens, targetId: target.id,
    });
  } catch (err) { return next(err); }
});

// =============================================================================
// AI assistance — scan planner + report-from-notes
// =============================================================================

let _aiClient = null;
async function getAiClient() {
  const s = await loadSettings();
  if (!s.geminiApiKey) throw new Error('Missing Gemini API key. Configure in Settings.');
  if (_aiClient && _aiClient._key === s.geminiApiKey) return _aiClient;
  const { GoogleGenAI } = await import('@google/genai');
  _aiClient = new GoogleGenAI({ apiKey: s.geminiApiKey });
  _aiClient._key = s.geminiApiKey;
  return _aiClient;
}

async function callGemini(prompt) {
  const client = await getAiClient();
  const resp   = await client.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
  const text   = typeof resp?.text === 'string' ? resp.text.trim() : '';
  if (!text) throw new Error('Empty response from Gemini.');
  return text;
}

// POST /api/ai/plan-scan
//   body: { prompt: string, scopeText?: string, techs?: string[] }
//   returns: { profile, modules:[], nucleiTags:[], rationale, raw }
app.post('/api/ai/plan-scan', async (req, res) => {
  try {
    const { prompt = '', scopeText = '', techs = [] } = req.body ?? {};
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required.' });

    const planningPrompt = [
      'You are a senior bug-bounty automation strategist.',
      'Given the analyst prompt, the in-scope assets, and detected technologies,',
      'pick the most efficient Fik scan plan. Respond with STRICT JSON only,',
      'no prose, no markdown fences. Schema:',
      '{',
      '  "profile": "quick"|"standard"|"deep",',
      '  "modules": [string],   // subset of: subdomains, dns_brute, port_scan, crawler, fuzzer, tech_detect, vulnscan, wayback, js_endpoints, takeover, secrets, gf_triage, screenshots, cors',
      '  "nucleiTags": [string],',
      '  "rationale": string    // 1-2 sentences',
      '}',
      '',
      `Analyst prompt: ${prompt}`,
      `In-scope (truncated): ${String(scopeText).slice(0, 2000)}`,
      `Detected technologies: ${Array.isArray(techs) ? techs.join(', ') : ''}`,
    ].join('\n');

    const raw = await callGemini(planningPrompt);
    // Be forgiving: strip code fences if model adds them.
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { return res.status(200).json({ raw, error: 'Model returned non-JSON.' }); }

    return res.status(200).json({ ...parsed, raw });
  } catch (err) {
    logError(`AI plan-scan failed: ${err.message}`);
    return res.status(503).json({ error: err.message });
  }
});

// POST /api/ai/report-from-notes
//   body: { domain?: string, prompt: string, notes: string, includeScan?: boolean }
//   returns: { reportName, content }
app.post('/api/ai/report-from-notes', async (req, res) => {
  try {
    const { domain = 'manual', prompt = '', notes = '', includeScan = false } = req.body ?? {};
    if (!prompt.trim() && !notes.trim()) {
      return res.status(400).json({ error: 'prompt or notes is required.' });
    }
    const safeDomain = String(domain).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'manual';

    // Optionally enrich with latest scan summary for the domain.
    let scanContext = '';
    if (includeScan) {
      try {
        const payload = getLatestScan(domain === 'manual' ? null : domain);
        if (payload) {
          const key = Object.keys(payload).find(k => k !== '_scanId');
          const node = payload[key] || {};
          const vulns = (node.vulnerability_objects || []).slice(0, 30).map(v => ({
            template_id: v.template_id ?? v['template-id'],
            name: v?.info?.name,
            severity: v?.info?.severity ?? v.severity,
            matched_at: v.matched_at ?? v['matched-at'] ?? v.host,
          }));
          scanContext = JSON.stringify({ domain: key, subdomainCount: (node.subdomains||[]).length, vulns }, null, 2);
        }
      } catch { /* ignore */ }
    }

    const fullPrompt = [
      'You are a senior bug-bounty researcher producing a professional Markdown report.',
      'Use clear section headings. Avoid speculation; flag uncertain items as "Assumed".',
      'If the notes describe a reproduction, mirror it precisely in "Steps to Reproduce".',
      '',
      `Target: ${domain}`,
      '',
      `Analyst instructions:\n${prompt}`,
      '',
      `Notes / evidence:\n${notes}`,
      scanContext ? `\nLatest scan context (JSON):\n${scanContext}` : '',
      '',
      'Output a single Markdown document. Do not wrap it in code fences.',
    ].filter(Boolean).join('\n');

    const md = await callGemini(fullPrompt);
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const reportName = `ai_${safeDomain}_${Date.now()}.md`;
    await fs.writeFile(path.join(REPORTS_DIR, reportName), md, 'utf8');
    logInfo(`AI report saved: ${reportName}`);
    return res.status(200).json({ reportName, content: md });
  } catch (err) {
    logError(`AI report-from-notes failed: ${err.message}`);
    return res.status(503).json({ error: err.message });
  }
});

// =============================================================================
// Global error handler (must be last)
// =============================================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    logError(`Invalid JSON: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }
  logError(`Unhandled error: ${err.stack ?? err.message}`);
  return res.status(500).json({ error: 'Internal server error.' });
});

// =============================================================================
// Process-level guards
// =============================================================================
process.on('unhandledRejection', (reason) => logError(`Unhandled rejection: ${reason}`));
process.on('uncaughtException',  (err)    => logError(`Uncaught exception: ${err.stack ?? err.message}`));

// =============================================================================
// Start
// =============================================================================
server.listen(PORT, () => {
  logInfo(`API + WebSocket server listening on http://localhost:${PORT}`);
  logInfo(`WebSocket log stream: ws://localhost:${PORT}/ws/logs`);
  initCronJobs().catch((e) => logError(`[cron] Init failed: ${e.message}`));
});