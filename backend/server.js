import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const BACKEND_DIR = __dirname;
const FRAMEWORK_DIR = path.join(BACKEND_DIR, '..');
const DATABASE_DIR = path.join(BACKEND_DIR, 'database');
const REPORT_GENERATOR_PATH = path.join(BACKEND_DIR, 'report_generator.js');
const TARGETS_FILE  = path.join(BACKEND_DIR, 'targets.json');
const SETTINGS_FILE = path.join(BACKEND_DIR, 'settings.json');
const REPORTS_DIR   = path.join(BACKEND_DIR, 'reports');

const DEFAULT_SETTINGS = {
  geminiApiKey:        '',
  proxyUrl:            '',
  defaultConcurrency:  50,
  nucleiConcurrency:   25,
  swapFileSizeGB:      2,
  enableSwapOnLowMem:  true,
};

// ---------------------------------------------------------------------------
// HTTP server + WebSocket server (share the same port via upgrade handling).
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Route upgrade requests: only accept /ws/logs, destroy everything else.
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/logs') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Broadcast a JSON message to every connected WS client.
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  });
}

// ---------------------------------------------------------------------------
// Active scan state (single scan at a time; extend later if needed).
// ---------------------------------------------------------------------------
// activeScan: { child, domain, profile, startedAt, pid, paused } | null
let activeScan = null;

// Active cron tasks for scheduled scans: targetId → cron.ScheduledTask
const cronJobs = new Map();

// Stores the previous /proc/stat CPU counters for delta-based CPU% calculation.
let prevCpuStats = null;

// ---------------------------------------------------------------------------
// Resource stats — reads /proc/stat + /proc/meminfo (Linux only).
// Returns zeroed-out object on any OS that lacks /proc.
// ---------------------------------------------------------------------------
async function getResourceStats() {
  let cpuPercent = 0;
  try {
    const statRaw = await fs.readFile('/proc/stat', 'utf8');
    const cpuLine = statRaw.split('\n').find((l) => l.startsWith('cpu '));
    if (cpuLine) {
      // Fields: user nice system idle iowait irq softirq steal guest guest_nice
      const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      const idle  = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
      const total = parts.reduce((a, b) => a + b, 0);
      if (prevCpuStats) {
        const diffIdle  = idle  - prevCpuStats.idle;
        const diffTotal = total - prevCpuStats.total;
        cpuPercent = diffTotal > 0 ? Math.round((1 - diffIdle / diffTotal) * 100) : 0;
      }
      prevCpuStats = { idle, total };
    }
  } catch { /* /proc unavailable — not Linux */ }

  let ramUsedMB = 0, ramTotalMB = 0, ramPercent = 0;
  let swapUsedMB = 0, swapTotalMB = 0, swapPercent = 0;
  try {
    const meminfoRaw = await fs.readFile('/proc/meminfo', 'utf8');
    const kbOf = (key) => {
      const m = meminfoRaw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    ramTotalMB  = Math.round(kbOf('MemTotal')     / 1024);
    const ramAvailMB  = Math.round(kbOf('MemAvailable') / 1024);
    ramUsedMB   = ramTotalMB - ramAvailMB;
    ramPercent  = ramTotalMB  > 0 ? Math.round((ramUsedMB  / ramTotalMB)  * 100) : 0;
    swapTotalMB = Math.round(kbOf('SwapTotal') / 1024);
    swapUsedMB  = Math.round((kbOf('SwapTotal') - kbOf('SwapFree')) / 1024);
    swapPercent = swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0;
  } catch { /* /proc unavailable */ }

  return { cpuPercent, ramUsedMB, ramTotalMB, ramPercent, swapUsedMB, swapTotalMB, swapPercent };
}

// ---------------------------------------------------------------------------
// WebSocket connection handler — sends initial state and handles messages.
// ---------------------------------------------------------------------------
wss.on('connection', async (ws) => {
  // ── Initial state snapshot ──────────────────────────────────────────────
  const scanStatus = activeScan
    ? { type: 'status', status: activeScan.paused ? 'paused' : 'running',
        domain: activeScan.domain, profile: activeScan.profile, pid: activeScan.pid }
    : { type: 'status', status: 'idle' };
  ws.send(JSON.stringify(scanStatus));

  // Send current resource snapshot so the gauge renders immediately.
  try {
    const snap = await getResourceStats();
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resources', ...snap }));
  } catch { /* ignore */ }

  // ── Inbound message handler (pause / resume) ────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'pause_scan') {
      if (!activeScan || activeScan.paused) return;
      try {
        // Negative PID targets the whole process group (requires detached:true).
        process.kill(-activeScan.pid, 'SIGSTOP');
        activeScan.paused = true;
        logInfo(`Scan paused — SIGSTOP sent to process group -${activeScan.pid}`);
        broadcast({ type: 'log', stream: 'stdout', line: '[SYSTEM] Scan paused.' });
        broadcast({ type: 'status', status: 'paused', domain: activeScan.domain, pid: activeScan.pid });
      } catch (err) {
        logError(`Failed to pause scan: ${err.message}`);
        ws.send(JSON.stringify({ type: 'log', stream: 'stderr',
          line: `[SYSTEM] Pause not supported on this OS: ${err.message}` }));
      }

    } else if (msg.type === 'resume_scan') {
      if (!activeScan || !activeScan.paused) return;
      try {
        process.kill(-activeScan.pid, 'SIGCONT');
        activeScan.paused = false;
        logInfo(`Scan resumed — SIGCONT sent to process group -${activeScan.pid}`);
        broadcast({ type: 'log', stream: 'stdout', line: '[SYSTEM] Scan resumed.' });
        broadcast({ type: 'status', status: 'running', domain: activeScan.domain, pid: activeScan.pid });
      } catch (err) {
        logError(`Failed to resume scan: ${err.message}`);
        ws.send(JSON.stringify({ type: 'log', stream: 'stderr',
          line: `[SYSTEM] Resume not supported on this OS: ${err.message}` }));
      }
    }
  });
});

function logInfo(message) {
  console.log(`[${new Date().toISOString()}] [INFO] ${message}`);
}

function logError(message) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${message}`);
}

async function ensureDatabaseDir() {
  await fs.mkdir(DATABASE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Target persistence helpers
// ---------------------------------------------------------------------------

async function loadTargets() {
  try {
    const raw = await fs.readFile(TARGETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTargets(targets) {
  await fs.writeFile(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf8');
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

async function listReports() {
  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const entries = await fs.readdir(REPORTS_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
    const withStats = await Promise.all(
      files.map(async (name) => {
        const stat = await fs.stat(path.join(REPORTS_DIR, name));
        return { name, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      }),
    );
    withStats.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return withStats;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared scan launcher + env builder
// ---------------------------------------------------------------------------

function buildScanEnv(settings, profile) {
  return {
    ...process.env,
    SCAN_PROFILE: profile,
    ...(settings.proxyUrl           ? { PROXY:              settings.proxyUrl                  } : {}),
    ...(settings.defaultConcurrency ? { CONCURRENCY:        String(settings.defaultConcurrency) } : {}),
    ...(settings.nucleiConcurrency  ? { NUCLEI_CONCURRENCY: String(settings.nucleiConcurrency)  } : {}),
    ...(settings.geminiApiKey       ? { GEMINI_API_KEY:     settings.geminiApiKey               } : {}),
  };
}

async function triggerScan(domain, profile = 'standard') {
  if (activeScan) throw new Error('A scan is already running.');
  const settings = await loadSettings();
  const scriptPath = path.join(FRAMEWORK_DIR, 'main.sh');
  const child = spawn('bash', [scriptPath, '-d', domain], {
    cwd: FRAMEWORK_DIR,
    env: buildScanEnv(settings, profile),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  activeScan = { child, domain, profile, startedAt: new Date().toISOString(), pid: child.pid, paused: false };
  broadcast({ type: 'status', status: 'started', domain, profile, pid: child.pid });
  logInfo(`Scan started: domain=${domain} profile=${profile} pid=${child.pid}`);
  child.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').forEach((line) => { if (line) broadcast({ type: 'log', stream: 'stdout', line }); });
  });
  child.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').forEach((line) => { if (line) broadcast({ type: 'log', stream: 'stderr', line }); });
  });
  child.on('error', (error) => {
    logError(`Scan process error: ${error.message}`);
    broadcast({ type: 'status', status: 'error', message: error.message });
    activeScan = null;
  });
  child.on('close', (code) => {
    logInfo(`Scan process closed with code ${code}`);
    broadcast({ type: 'status', status: 'stopped', code });
    activeScan = null;
  });
  return { pid: child.pid };
}

// ---------------------------------------------------------------------------
// Cron job management
// ---------------------------------------------------------------------------

function registerCronJob(target) {
  if (!target.schedule || !cron.validate(target.schedule)) {
    if (target.schedule) logError(`[cron] Invalid expression for ${target.id}: "${target.schedule}"`);
    return;
  }
  const task = cron.schedule(target.schedule, () => {
    if (activeScan) {
      logInfo(`[cron] Skipped scheduled scan for ${target.domain} — another scan is running.`);
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

async function getMostRecentJsonFile(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name);

  if (jsonFiles.length === 0) {
    return null;
  }

  const filesWithStats = await Promise.all(
    jsonFiles.map(async (fileName) => {
      const fullPath = path.join(directoryPath, fileName);
      const stats = await fs.stat(fullPath);
      return { fullPath, modified: stats.mtimeMs };
    }),
  );

  filesWithStats.sort((a, b) => b.modified - a.modified);
  return filesWithStats[0].fullPath;
}

function spawnReportGenerator(extraEnv = {}) {
  const child = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      logInfo(`[report_generator] ${output}`);
    }
  });

  child.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      logError(`[report_generator] ${output}`);
    }
  });

  child.on('error', (error) => {
    logError(`Failed to spawn report_generator.js: ${error.message}`);
  });

  child.on('close', (code) => {
    logInfo(`report_generator.js exited with code ${code}`);
  });

  logInfo('Spawned report_generator.js asynchronously.');
}

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.post('/api/ingest', async (req, res, next) => {
  try {
    const payload = req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'Payload must be a JSON object.' });
    }

    await ensureDatabaseDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `scan_${timestamp}.json`;
    const filePath = path.join(DATABASE_DIR, fileName);

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');

    logInfo(`Saved ingest payload to ${filePath}`);
    loadSettings()
      .then((s) => spawnReportGenerator(s.geminiApiKey ? { GEMINI_API_KEY: s.geminiApiKey } : {}))
      .catch(() => spawnReportGenerator());

    return res.status(202).json({
      message: 'Payload accepted and queued for report generation.',
      file: fileName,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/data', async (req, res, next) => {
  try {
    await ensureDatabaseDir();

    const latestFilePath = await getMostRecentJsonFile(DATABASE_DIR);
    if (!latestFilePath) {
      return res.status(404).json({ error: 'No scan data found.' });
    }

    const raw = await fs.readFile(latestFilePath, 'utf8');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logError(`Latest scan file is invalid JSON: ${latestFilePath}`);
      return res.status(500).json({ error: 'Stored scan data is corrupted.' });
    }

    logInfo(`Serving latest scan data from ${latestFilePath}`);
    return res.status(200).json(parsed);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Target CRUD routes
// ---------------------------------------------------------------------------

app.get('/api/targets', async (req, res, next) => {
  try {
    return res.status(200).json(await loadTargets());
  } catch (error) {
    return next(error);
  }
});

app.post('/api/targets', async (req, res, next) => {
  try {
    const { domain, includeScope = '', excludeScope = '', notes = '' } = req.body || {};
    if (!domain || typeof domain !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(domain.trim())) {
      return res.status(400).json({ error: 'Valid domain is required.' });
    }
    const targets = await loadTargets();
    const now = new Date().toISOString();
    const target = { id: makeId(), domain: domain.trim(), includeScope, excludeScope, notes, createdAt: now, updatedAt: now };
    targets.push(target);
    await saveTargets(targets);
    return res.status(201).json(target);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/targets/:id', async (req, res, next) => {
  try {
    const targets = await loadTargets();
    const idx = targets.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found.' });
    const { domain, includeScope, excludeScope, notes } = req.body || {};
    if (domain !== undefined && !/^[a-zA-Z0-9._-]+$/.test(domain.trim())) {
      return res.status(400).json({ error: 'Invalid domain.' });
    }
    targets[idx] = {
      ...targets[idx],
      ...(domain      !== undefined && { domain: domain.trim() }),
      ...(includeScope !== undefined && { includeScope }),
      ...(excludeScope !== undefined && { excludeScope }),
      ...(notes       !== undefined && { notes }),
      updatedAt: new Date().toISOString(),
    };
    await saveTargets(targets);
    return res.status(200).json(targets[idx]);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/targets/:id', async (req, res, next) => {
  try {
    const targets = await loadTargets();
    const next_targets = targets.filter((t) => t.id !== req.params.id);
    if (next_targets.length === targets.length) return res.status(404).json({ error: 'Target not found.' });
    await saveTargets(next_targets);
    return res.status(200).json({ message: 'Deleted.' });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Scan control routes
// ---------------------------------------------------------------------------

// POST /api/scan/start  { domain?, targetId?, profile? }
// If targetId is given, domain is loaded from targets.json.
app.post('/api/scan/start', async (req, res, next) => {
  try {
    if (activeScan) {
      return res.status(409).json({ error: 'A scan is already running.' });
    }

    let { domain, targetId, profile = 'standard' } = req.body || {};

    // Resolve domain from saved target when targetId is provided.
    if (targetId) {
      const targets = await loadTargets();
      const target = targets.find((t) => t.id === targetId);
      if (!target) return res.status(404).json({ error: 'Target not found.' });
      domain = target.domain;
    }

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required.' });
    }

    // SECURITY: Restrict domain to safe characters to prevent shell injection.
    if (!/^[a-zA-Z0-9._-]+$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain. Only alphanumerics, dots, hyphens, and underscores are allowed.' });
    }

    const validProfiles = ['quick', 'standard', 'deep'];
    if (!validProfiles.includes(profile)) {
      return res.status(400).json({ error: `profile must be one of: ${validProfiles.join(', ')}` });
    }

    const { pid } = await triggerScan(domain, profile);
    return res.status(202).json({ message: 'Scan started.', pid, domain, profile });
  } catch (error) {
    return next(error);
  }
});

// POST /api/scan/stop
// Sends SIGTERM to the entire process group (bash + child tools).
app.post('/api/scan/stop', (req, res) => {
  if (!activeScan) {
    return res.status(404).json({ error: 'No active scan.' });
  }
  // Resume first if paused so SIGTERM is delivered (SIGTERM is blocked by SIGSTOP).
  try {
    if (activeScan.paused) process.kill(-activeScan.pid, 'SIGCONT');
    process.kill(-activeScan.pid, 'SIGTERM');
  } catch {
    activeScan.child.kill('SIGTERM'); // fallback if group kill fails
  }
  logInfo(`Stop signal sent to process group -${activeScan.pid}`);
  return res.status(200).json({ message: 'Stop signal sent.' });
});

// GET /api/scan/status
// Lets the frontend poll state on page reload (complements the WS sync).
app.get('/api/scan/status', (req, res) => {
  if (!activeScan) {
    return res.status(200).json({ status: 'idle' });
  }
  return res.status(200).json({
    status: 'running',
    domain: activeScan.domain,
    profile: activeScan.profile,
    startedAt: activeScan.startedAt,
    pid: activeScan.pid,
  });
});

// GET /api/tech/:domain
// Runs tech_detector.sh on demand (no active scan required) and returns
// detected technologies plus the Nuclei tags that would be applied.
app.get('/api/tech/:domain', async (req, res, next) => {
  try {
    const { domain } = req.params;

    if (!/^[a-zA-Z0-9._-]+$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain.' });
    }

    const techScript = path.join(FRAMEWORK_DIR, 'modules', 'tech_detector.sh');
    const tagsConfig = path.join(FRAMEWORK_DIR, 'config', 'tech_to_tags.json');

    // Spawn tech_detector.sh; enforce a 30s timeout.
    const rawOutput = await new Promise((resolve) => {
      let out = '';
      const child = spawn('bash', [techScript, domain], {
        cwd: FRAMEWORK_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => resolve(out.trim() || 'unknown'));
      child.on('error', () => resolve('unknown'));
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve('unknown'); }, 30000);
      child.on('close', () => clearTimeout(timer));
    });

    const techs = rawOutput === 'unknown' ? [] : rawOutput.split(',').filter(Boolean);

    // Map detected techs to Nuclei tags.
    const tagSet = new Set();
    try {
      const raw = await fs.readFile(tagsConfig, 'utf8');
      const tagMap = JSON.parse(raw);
      for (const tech of techs) {
        const mapped = tagMap[tech.toLowerCase()];
        if (Array.isArray(mapped)) mapped.forEach((t) => tagSet.add(t));
      }
      // If nothing matched, fall back to the "unknown" bucket.
      if (tagSet.size === 0) {
        const fallback = tagMap.unknown || [];
        fallback.forEach((t) => tagSet.add(t));
      }
    } catch {
      // Config absent or corrupt — return empty tags list, not an error.
    }

    return res.status(200).json({
      domain,
      techs,
      tags: [...tagSet],
      nucleiTagsArg: tagSet.size > 0 ? [...tagSet].join(',') : 'cve,exposure',
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Settings routes
// ---------------------------------------------------------------------------

app.get('/api/settings', async (req, res, next) => {
  try {
    return res.status(200).json(await loadSettings());
  } catch (error) { return next(error); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const current = await loadSettings();
    const { geminiApiKey, proxyUrl, defaultConcurrency, nucleiConcurrency, swapFileSizeGB, enableSwapOnLowMem } = req.body || {};
    const updated = {
      ...current,
      ...(geminiApiKey       !== undefined && { geminiApiKey:       String(geminiApiKey).trim()                       }),
      ...(proxyUrl           !== undefined && { proxyUrl:           String(proxyUrl).trim()                           }),
      ...(defaultConcurrency !== undefined && { defaultConcurrency: Math.max(1, Number(defaultConcurrency) || current.defaultConcurrency) }),
      ...(nucleiConcurrency  !== undefined && { nucleiConcurrency:  Math.max(1, Number(nucleiConcurrency)  || current.nucleiConcurrency)  }),
      ...(swapFileSizeGB     !== undefined && { swapFileSizeGB:     Math.max(1, Number(swapFileSizeGB)     || current.swapFileSizeGB)     }),
      ...(enableSwapOnLowMem !== undefined && { enableSwapOnLowMem: Boolean(enableSwapOnLowMem) }),
    };
    await saveSettings(updated);
    return res.status(200).json(updated);
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Report routes
// ---------------------------------------------------------------------------

app.get('/api/reports', async (req, res, next) => {
  try {
    return res.status(200).json(await listReports());
  } catch (error) { return next(error); }
});

// POST /api/report/generate — runs report_generator.js synchronously, waits,
// then returns the updated reports list. Timeout: 120 s.
app.post('/api/report/generate', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const extraEnv = settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : {};
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
        cwd: BACKEND_DIR,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`report_generator exited with code ${code}`))));
      child.on('error', reject);
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Report generation timed out (120s)')); }, 120000);
      child.on('close', () => clearTimeout(timer));
    });
    return res.status(200).json({ message: 'Reports generated.', reports: await listReports() });
  } catch (error) { return next(error); }
});

// GET /api/reports/:filename — download a Markdown report.
app.get('/api/reports/:filename', async (req, res, next) => {
  try {
    const { filename } = req.params;
    // SECURITY: strict allowlist to prevent path traversal.
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
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Scan history
// ---------------------------------------------------------------------------

// GET /api/scans?domain=<domain>
app.get('/api/scans', async (req, res, next) => {
  try {
    await ensureDatabaseDir();
    const { domain } = req.query;
    const entries = await fs.readdir(DATABASE_DIR, { withFileTypes: true });
    const scans = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('scan_') || !entry.name.endsWith('.json')) continue;
      try {
        const fullPath = path.join(DATABASE_DIR, entry.name);
        const stat = await fs.stat(fullPath);
        const raw = await fs.readFile(fullPath, 'utf8');
        const payload = JSON.parse(raw);
        const scanDomain = (typeof payload === 'object' && !Array.isArray(payload)) ? Object.keys(payload)[0] : 'unknown';
        if (domain && scanDomain !== domain) continue;
        scans.push({ fileName: entry.name, domain: scanDomain, scanDate: stat.mtime.toISOString() });
      } catch { /* skip corrupt */ }
    }
    scans.sort((a, b) => new Date(b.scanDate) - new Date(a.scanDate));
    return res.status(200).json(scans);
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Scheduler routes
// ---------------------------------------------------------------------------

// POST /api/targets/:id/schedule  { cronExpression: "0 2 * * *" | "" | null }
app.post('/api/targets/:id/schedule', async (req, res, next) => {
  try {
    const targets = await loadTargets();
    const idx = targets.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found.' });
    const { cronExpression } = req.body || {};
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
  } catch (error) { return next(error); }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logError(`Invalid JSON payload: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  logError(`Unhandled request error: ${err.stack || err.message}`);
  return res.status(500).json({ error: 'Internal server error.' });
});

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled promise rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logError(`Uncaught exception: ${error.stack || error.message}`);
});

// ---------------------------------------------------------------------------
// Resource Sentinel — broadcast system stats every 2 s to all WS clients.
// The interval is lightweight: /proc reads are fast kernel pseudo-file reads.
// ---------------------------------------------------------------------------
setInterval(async () => {
  if (wss.clients.size === 0) return; // no clients connected, skip
  try {
    const stats = await getResourceStats();
    broadcast({ type: 'resources', ...stats });
  } catch { /* ignore */ }
}, 2000);

// Use the shared http.Server so Express and the WebSocket server coexist on
// the same port. The 'upgrade' handler above routes WS traffic to wss.
server.listen(PORT, () => {
  logInfo(`API + WebSocket listener running at http://localhost:${PORT}`);
  logInfo(`WebSocket log stream available at ws://localhost:${PORT}/ws/logs`);
  initCronJobs().catch((e) => logError(`[cron] Init failed: ${e.message}`));
});
