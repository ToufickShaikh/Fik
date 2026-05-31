// =============================================================================
// Fik — Report Generator
// Reads the latest HIGH/CRITICAL findings from SQLite, generates:
//   1. Individual Markdown vulnerability reports (one per finding)
//   2. A single email-ready summary (copy-paste into your bounty submission)
// =============================================================================

import path             from 'path';
import fs               from 'fs/promises';
import dotenv           from 'dotenv';
import { GoogleGenAI }  from '@google/genai';
import { fileURLToPath } from 'url';
import { getLatestScan } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const REPORTS_DIR = path.join(__dirname, 'reports');

function logInfo(msg)  { console.log(`[${new Date().toISOString()}] [REPORT] ${msg}`); }
function logError(msg) { console.error(`[${new Date().toISOString()}] [REPORT][ERROR] ${msg}`); }

function sanitizeFilePart(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
}

function getSeverity(finding) {
  return ((finding?.info?.severity ?? finding?.severity ?? 'unknown')
    .toLowerCase().trim());
}

function getVulnName(finding) {
  return (
    finding?.info?.name      ??
    finding?.template_name   ??
    finding?.template_id     ??
    finding?.['template-id'] ??
    finding?.template        ??
    'Unnamed Vulnerability'
  );
}

function getMatchedAt(finding) {
  return finding?.matched_at ?? finding?.['matched-at'] ?? finding?.host ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Deduplicated output path helper
// ---------------------------------------------------------------------------
async function uniqueReportPath(baseName, usedPaths) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  let candidate = `${baseName}.md`;
  let fullPath  = path.join(REPORTS_DIR, candidate);
  let counter   = 2;

  while (usedPaths.has(fullPath)) {
    candidate = `${baseName}_${counter}.md`;
    fullPath  = path.join(REPORTS_DIR, candidate);
    counter++;
  }

  usedPaths.add(fullPath);
  return fullPath;
}

// ---------------------------------------------------------------------------
// Per-finding report prompt
// ---------------------------------------------------------------------------
function buildFindingPrompt(targetDomain, finding) {
  const vulnName   = getVulnName(finding);
  const severity   = getSeverity(finding) || 'unknown';
  const matchedAt  = getMatchedAt(finding);
  const templateId = finding?.template_id ?? finding?.['template-id'] ?? 'unknown';

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
    JSON.stringify({ targetDomain, vulnerabilityName: vulnName, severity, matchedAt, templateId, finding }, null, 2),
    '',
    'Write clearly and avoid speculative claims. If specific details are missing, state assumptions explicitly.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Email summary prompt — no subject line, just the body
// ---------------------------------------------------------------------------
function buildEmailSummaryPrompt(targetDomain, criticalFindings, highFindings) {
  const total = criticalFindings.length + highFindings.length;

  const formatList = (findings) => findings.map((f, i) => {
    const name      = getVulnName(f);
    const matchedAt = getMatchedAt(f);
    const sev       = getSeverity(f).toUpperCase();
    return `${i + 1}. [${sev}] **${name}** — \`${matchedAt}\``;
  }).join('\n');

  const criticalSection = criticalFindings.length > 0
    ? `### Critical Findings (${criticalFindings.length})\n${formatList(criticalFindings)}`
    : '';
  const highSection = highFindings.length > 0
    ? `### High Findings (${highFindings.length})\n${formatList(highFindings)}`
    : '';

  return [
    'You are a professional bug bounty researcher writing to a security team or bug bounty program.',
    `Write a concise, professional email body (Markdown) for submitting ${total} security findings against "${targetDomain}".`,
    'Requirements:',
    '- Open with 2–3 sentences summarising what was found and the overall risk',
    '- List each finding clearly using the data provided below',
    '- End with a call-to-action (e.g. happy to provide PoC, schedule a call)',
    '- Use plain professional language — no filler, no fluff',
    '- Do NOT include a subject line — only the body',
    '- Keep it under 400 words',
    '',
    `Findings for ${targetDomain}:`,
    criticalSection,
    highSection,
    '',
    'The researcher will attach full technical reports separately.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Gemini call with retry
// ---------------------------------------------------------------------------
async function generateContent(aiClient, prompt, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await aiClient.models.generateContent({
        model:    'gemini-2.5-flash',
        contents: prompt,
      });
      const text = typeof response?.text === 'string' ? response.text.trim() : '';
      if (!text) throw new Error('Model returned empty content.');
      return text;
    } catch (err) {
      if (attempt > retries) throw err;
      logInfo(`Gemini attempt ${attempt} failed (${err.message}), retrying…`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing API key. Set GEMINI_API_KEY in backend/.env');
  }

  // Pull latest scan from SQLite (already filtered to high/critical by db.js).
  const payload = getLatestScan(null);
  if (!payload) {
    logInfo('No scan data in database. Nothing to process.');
    return;
  }

  const targetDomain = Object.keys(payload).find(k => k !== '_scanId');
  if (!targetDomain) {
    logInfo('Could not determine target domain from payload.');
    return;
  }

  const node  = payload[targetDomain];
  const vulns = Array.isArray(node?.vulnerability_objects) ? node.vulnerability_objects : [];

  if (vulns.length === 0) {
    logInfo(`No high/critical findings for ${targetDomain}. No reports generated.`);
    return;
  }

  const criticalFindings = vulns.filter(f => getSeverity(f) === 'critical');
  const highFindings     = vulns.filter(f => getSeverity(f) === 'high');

  logInfo(`Target: ${targetDomain} — critical=${criticalFindings.length} high=${highFindings.length}`);

  const aiClient   = new GoogleGenAI({ apiKey });
  const usedPaths  = new Set();
  const safeTarget = sanitizeFilePart(targetDomain);
  const dateTag    = new Date().toISOString().slice(0, 10);

  await fs.mkdir(REPORTS_DIR, { recursive: true });

  // ── 1. Per-finding reports ───────────────────────────────────────────────
  for (const finding of vulns) {
    const vulnName = getVulnName(finding);
    logInfo(`Generating report: ${vulnName}`);
    try {
      const markdown   = await generateContent(aiClient, buildFindingPrompt(targetDomain, finding));
      const reportPath = await uniqueReportPath(`${safeTarget}_${sanitizeFilePart(vulnName)}`, usedPaths);
      await fs.writeFile(reportPath, markdown, 'utf8');
      logInfo(`Saved: ${reportPath}`);
    } catch (err) {
      logError(`Failed for "${vulnName}": ${err.message}`);
    }
  }

  // ── 2. Email summary ─────────────────────────────────────────────────────
  logInfo('Generating email summary…');
  try {
    const summaryMarkdown = await generateContent(
      aiClient,
      buildEmailSummaryPrompt(targetDomain, criticalFindings, highFindings),
    );

    const header = [
      `**Program/Target:** ${targetDomain}`,
      `**Date:** ${dateTag}`,
      `**Findings:** ${criticalFindings.length} Critical / ${highFindings.length} High`,
      '',
      '---',
      '',
    ].join('\n');

    const summaryPath = path.join(REPORTS_DIR, `email_summary_${safeTarget}_${dateTag}.md`);
    await fs.writeFile(summaryPath, header + summaryMarkdown, 'utf8');
    logInfo(`Email summary saved: ${summaryPath}`);
  } catch (err) {
    logError(`Email summary failed: ${err.message}`);
  }

  logInfo(`Done. ${vulns.length} individual report(s) + 1 email summary generated.`);
}

main().catch((err) => {
  logError(err.stack ?? err.message);
  process.exitCode = 1;
});
