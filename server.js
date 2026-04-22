const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

app.post('/api/ingest', async (req, res, next) => {
  try {
    const payload = req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'Payload must be a JSON object.' });
    }

    const targetNames = Object.keys(payload);
    const targetName = targetNames.length > 0 ? targetNames[0] : 'unknown_target';
    const targetData = payload[targetName] && typeof payload[targetName] === 'object'
      ? payload[targetName]
      : {};

    const liveHostsCount = Array.isArray(targetData.live_services)
      ? targetData.live_services.length
      : 0;
    const vulnerabilityCount = Array.isArray(targetData.vulnerability_objects)
      ? targetData.vulnerability_objects.length
      : 0;

    console.log('==============================================================');
    console.log('[INGEST] Scan payload received');
    console.log(`[INGEST] Target: ${targetName}`);
    console.log(`[INGEST] Live hosts/services: ${liveHostsCount}`);
    console.log(`[INGEST] Vulnerabilities: ${vulnerabilityCount}`);
    console.log('==============================================================');

    const databaseDir = path.join(__dirname, 'database');
    await fs.mkdir(databaseDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `scan_${timestamp}.json`;
    const filePath = path.join(databaseDir, fileName);

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');

    res.status(201).json({
      message: 'Payload ingested successfully.',
      file: fileName,
      target: targetName,
      liveHosts: liveHostsCount,
      vulnerabilities: vulnerabilityCount,
    });
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on http://localhost:${PORT}`);
});
