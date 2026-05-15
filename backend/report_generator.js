import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const BACKEND_DIR = __dirname;
const DATABASE_DIR = path.join(BACKEND_DIR, 'database');
const REPORTS_DIR = path.join(BACKEND_DIR, 'reports');

function logInfo(message) {
  console.log(`[${new Date().toISOString()}] [REPORT] ${message}`);
}

function logError(message) {
  console.error(`[${new Date().toISOString()}] [REPORT][ERROR] ${message}`);
}

function sanitizeFilePart(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
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

function extractTargetData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { targetDomain: 'unknown_target', targetNode: {} };
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return { targetDomain: 'unknown_target', targetNode: {} };
  }

  const firstKey = keys[0];
  const firstValue = payload[firstKey];

  if (firstValue && typeof firstValue === 'object' && !Array.isArray(firstValue)) {
    return { targetDomain: firstKey, targetNode: firstValue };
  }

  return { targetDomain: firstKey, targetNode: payload };
}

function extractSeverity(finding) {
  const directSeverity = finding && typeof finding.severity === 'string' ? finding.severity : '';
  const infoSeverity = finding && finding.info && typeof finding.info.severity === 'string'
    ? finding.info.severity
    : '';

  return (infoSeverity || directSeverity).toLowerCase().trim();
}

function extractVulnName(finding) {
  return (
    finding?.info?.name ||
    finding?.template_name ||
    finding?.template_id ||
    finding?.['template-id'] ||
    finding?.template ||
    'Unnamed Vulnerability'
  );
}

function buildPrompt(targetDomain, finding) {
  const vulnName = extractVulnName(finding);
  const severity = extractSeverity(finding) || 'unknown';
  const matchedAt = finding?.matched_at || finding?.['matched-at'] || finding?.host || 'unknown';
  const templateId = finding?.template_id || finding?.['template-id'] || 'unknown';

  return [
    'You are a senior bug bounty security researcher.',
    'Generate a concise, professional Markdown vulnerability report for the following finding.',
    'Use exactly these section headers in this order:',
    '1. Vulnerability Name',
    '2. Description',
    '3. Steps to Reproduce',
    '4. Impact',
    '5. Remediation',
    '',
    'Finding data (JSON):',
    JSON.stringify(
      {
        targetDomain,
        vulnerabilityName: vulnName,
        severity,
        matchedAt,
        templateId,
        finding,
      },
      null,
      2,
    ),
    '',
    'Write clearly and avoid speculative claims. If specific details are missing, state assumptions explicitly.',
  ].join('\n');
}

async function generateReportMarkdown(aiClient, targetDomain, finding) {
  const prompt = buildPrompt(targetDomain, finding);

  const response = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const markdown = typeof response?.text === 'string' ? response.text.trim() : '';
  if (!markdown) {
    throw new Error('Model returned an empty report.');
  }

  return markdown;
}

async function writeReportFile(targetDomain, vulnName, markdown, usedPaths) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const safeTarget = sanitizeFilePart(targetDomain);
  const safeVuln = sanitizeFilePart(vulnName);
  const baseName = `${safeTarget}_${safeVuln}`;

  let candidateName = `${baseName}.md`;
  let candidatePath = path.join(REPORTS_DIR, candidateName);
  let counter = 2;

  while (usedPaths.has(candidatePath)) {
    candidateName = `${baseName}_${counter}.md`;
    candidatePath = path.join(REPORTS_DIR, candidateName);
    counter += 1;
  }

  usedPaths.add(candidatePath);
  await fs.writeFile(candidatePath, markdown, 'utf8');
  return candidatePath;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in backend/.env');
  }

  await fs.mkdir(DATABASE_DIR, { recursive: true });

  const latestJsonPath = await getMostRecentJsonFile(DATABASE_DIR);
  if (!latestJsonPath) {
    logInfo('No JSON scan payload found in backend/database. Nothing to process.');
    return;
  }

  logInfo(`Using newest payload: ${latestJsonPath}`);
  const raw = await fs.readFile(latestJsonPath, 'utf8');
  const payload = JSON.parse(raw);

  const { targetDomain, targetNode } = extractTargetData(payload);
  const vulnerabilities = Array.isArray(targetNode.vulnerability_objects)
    ? targetNode.vulnerability_objects
    : [];

  const selectedFindings = vulnerabilities.filter((finding) => {
    const severity = extractSeverity(finding);
    return severity === 'high' || severity === 'critical';
  });

  if (selectedFindings.length === 0) {
    logInfo('No high/critical findings found. No reports generated.');
    return;
  }

  const aiClient = new GoogleGenAI({ apiKey });

  const usedPaths = new Set();

  for (const finding of selectedFindings) {
    const vulnName = extractVulnName(finding);
    logInfo(`Generating report for: ${vulnName}`);

    const markdown = await generateReportMarkdown(aiClient, targetDomain, finding);
    const reportPath = await writeReportFile(targetDomain, vulnName, markdown, usedPaths);

    logInfo(`Saved report: ${reportPath}`);
  }

  logInfo(`Report generation complete. Generated ${selectedFindings.length} report(s).`);
}

main().catch((error) => {
  logError(error.stack || error.message);
  process.exitCode = 1;
});
