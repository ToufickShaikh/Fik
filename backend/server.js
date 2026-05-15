// =============================================================================
// FIK Bug Bounty Framework — Backend API Server
// ES Module · Express · ws · node-cron
// =============================================================================

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// ES-module equivalent of __dirname
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------
const BACKEND_DIR           = __dirname;
const FRAMEWORK_DIR         = path.join(BACKEND_DIR, '..');
const DATABASE_DIR          = path.join(BACKEND_DIR, 'database');
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

/** Absolute path of the most-recently-modified .json file in a directory. */
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

  const child = spawn('bash', [scriptPath, '-d', domain, '-p', profile], {
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
  if (task) { task.destroy(); cronJobs.delete(targetId); }
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
      const child = spawn('bash', [techScript, domain], {
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
    const extraEnv = settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : {};

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
        cwd:   BACKEND_DIR,
        env:   { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => logInfo(`[report_generator] ${d.toString().trim()}`));
      child.stderr.on('data', (d) => logError(`[report_generator] ${d.toString().trim()}`));
      child.on('error',  reject);
      child.on('close',  (code) => (code === 0 ? resolve() : reject(new Error(`report_generator exited ${code}`))));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Report generation timed out after 120 s'));
      }, 120_000);
      child.on('close', () => clearTimeout(timer));
    });

    return res.status(200).json({ message: 'Reports generated.', reports: await listReports() });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Reports — list + download
// ---------------------------------------------------------------------------

app.get('/api/reports', async (req, res, next) => {
  try {
    return res.status(200).json(await listReports());
  } catch (err) { return next(err); }
});

// GET /api/reports/:filename — path-traversal-safe download
app.get('/api/reports/:filename', async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    try {
      const content = await fs.readFile(path.join(REPORTS_DIR, filename), 'utf8');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
app.get('/api/scans', async (req, res, next) => {
  try {
    await ensureDatabaseDir();
    const { domain } = req.query;
    const entries    = await fs.readdir(DATABASE_DIR, { withFileTypes: true });
    const scans      = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('scan_') || !entry.name.endsWith('.json')) continue;
      try {
        const fullPath   = path.join(DATABASE_DIR, entry.name);
        const stat       = await fs.stat(fullPath);
        const payload    = JSON.parse(await fs.readFile(fullPath, 'utf8'));
        const scanDomain = typeof payload === 'object' && !Array.isArray(payload)
          ? Object.keys(payload)[0] ?? 'unknown' : 'unknown';
        if (domain && scanDomain !== domain) continue;
        scans.push({ fileName: entry.name, domain: scanDomain, scanDate: stat.mtime.toISOString() });
      } catch { /* skip corrupt files */ }
    }

    scans.sort((a, b) => new Date(b.scanDate) - new Date(a.scanDate));
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

    await ensureDatabaseDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName  = `scan_${timestamp}.json`;
    const filePath  = path.join(DATABASE_DIR, fileName);

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    logInfo(`Ingest saved: ${filePath}`);

    // Fire-and-forget: generate report in the background after ingest.
    const settings = await loadSettings();
    const extraEnv = settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : {};
    const rg = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
      cwd:   BACKEND_DIR,
      env:   { ...process.env, ...extraEnv },
      stdio: 'ignore',
    });
    rg.on('error', (e) => logError(`report_generator spawn error: ${e.message}`));

    return res.status(202).json({ message: 'Payload accepted.', file: fileName });
  } catch (err) { return next(err); }
});

// GET /api/data — most-recent scan payload (drives the vulnerability table)
app.get('/api/data', async (req, res, next) => {
  try {
    await ensureDatabaseDir();
    const latest = await getMostRecentJsonFile(DATABASE_DIR);
    if (!latest) return res.status(404).json({ error: 'No scan data found.' });

    let parsed;
    try { parsed = JSON.parse(await fs.readFile(latest, 'utf8')); }
    catch { return res.status(500).json({ error: 'Stored scan data is corrupted.' }); }

    logInfo(`Serving latest scan data from ${latest}`);
    return res.status(200).json(parsed);
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