const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const BACKEND_DIR = __dirname;
const DATABASE_DIR = path.join(BACKEND_DIR, 'database');
const REPORT_GENERATOR_PATH = path.join(BACKEND_DIR, 'report_generator.js');

function logInfo(message) {
  console.log(`[${new Date().toISOString()}] [INFO] ${message}`);
}

function logError(message) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${message}`);
}

async function ensureDatabaseDir() {
  await fs.mkdir(DATABASE_DIR, { recursive: true });
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

function spawnReportGenerator() {
  const child = spawn(process.execPath, [REPORT_GENERATOR_PATH], {
    cwd: BACKEND_DIR,
    env: process.env,
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
    spawnReportGenerator();

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

app.listen(PORT, () => {
  logInfo(`API listener running at http://localhost:${PORT}`);
});
