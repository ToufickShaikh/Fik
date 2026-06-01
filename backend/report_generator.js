// =============================================================================
// Fik — Report Generator
// Always produces an educational "learning report" from the latest scan's
// recon artifacts (subdomains, live hosts, ports, JS endpoints, tech, etc.).
// When high/critical findings exist, also produces:
//   • one Markdown deep-dive per finding
//   • an email-ready submission summary
// =============================================================================

import path             from 'path';
import fs               from 'fs/promises';
import fsSync           from 'fs';
import dotenv           from 'dotenv';
import { GoogleGenAI }  from '@google/genai';
import { fileURLToPath } from 'url';
import { getLatestScan } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const REPORTS_DIR    = path.join(__dirname, 'reports');
const FRAMEWORK_DIR  = process.env.FRAMEWORK_DIR || path.resolve(__dirname, '..');
const RESULTS_DIR    = path.join(FRAMEWORK_DIR, 'results');

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
// Recon-artifact discovery: find the newest results/<safe_domain>_* dir
// ---------------------------------------------------------------------------
function findLatestScanDir(targetDomain) {
  const safe = targetDomain.replace(/[^a-zA-Z0-9._-]/g, '_');
  let entries;
  try {
    entries = fsSync.readdirSync(RESULTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter(e => e.isDirectory() && e.name.startsWith(`${safe}_`))
    .map(e => {
      const full = path.join(RESULTS_DIR, e.name);
      let mtime = 0;
      try { mtime = fsSync.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.full ?? null;
}

function readLines(file, cap = 5000) {
  try {
    const data = fsSync.readFileSync(file, 'utf8');
    const lines = data.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.slice(0, cap);
  } catch {
    return [];
  }
}

function readJsonl(file, cap = 1000) {
  return readLines(file, cap).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function countFiles(dir, pattern) {
  try {
    return fsSync.readdirSync(dir).filter(f => pattern.test(f)).length;
  } catch { return 0; }
}

/** Collect every artifact useful for an educational report. */
function gatherReconArtifacts(scanDir) {
  if (!scanDir) return null;
  const file = (name) => path.join(scanDir, name);

  const subdomains       = readLines(file('subdomains.txt'),    2000);
  const liveHosts        = readLines(file('live_hosts.txt'),    2000);
  const activePorts      = readLines(file('active_ports.txt'),  2000);
  const nonStandardPorts = readLines(file('non_standard_ports.txt'), 500);
  const endpoints        = readLines(file('endpoints.txt'),     3000);
  const jsFiles          = readLines(file('js_files.txt'),      1500);
  const jsEndpoints      = readLines(file('js_endpoints.txt'),  1500);
  const allUrls          = readLines(file('all_urls.txt'),      3000);
  const discoveredDirs   = readLines(file('discovered_directories.txt'), 500);
  const potentialLeaks   = readLines(file('potential_leaks.txt'), 200);
  const gfSummary        = readLines(file('gf_summary.txt'),    200);
  const takeoverReport   = readLines(file('takeover.txt'),      200);
  const corsReport       = readLines(file('cors_clickjacking.txt'), 200);
  const secretsReport    = readLines(file('secrets.txt'),       100);
  const dnsbrute         = readLines(file('dnsbrute.txt'),      500);
  const wayback          = readLines(file('wayback_urls_raw.txt'), 1000);

  // Nuclei findings (already high/critical only, but include for the deep dive).
  const vulnerabilities  = readJsonl(file('vulnerabilities.jsonl'), 500);

  const screenshotsDir = path.join(scanDir, 'screenshots');
  const screenshotCount = countFiles(screenshotsDir, /\.(png|jpe?g)$/i);

  return {
    scanDir,
    counts: {
      subdomains:        subdomains.length,
      liveHosts:         liveHosts.length,
      activePorts:       activePorts.length,
      nonStandardPorts:  nonStandardPorts.length,
      endpoints:         endpoints.length,
      jsFiles:           jsFiles.length,
      jsEndpoints:       jsEndpoints.length,
      allUrls:           allUrls.length,
      discoveredDirs:    discoveredDirs.length,
      potentialLeaks:    potentialLeaks.length,
      gfSummaryLines:    gfSummary.length,
      takeoverLines:     takeoverReport.length,
      corsLines:         corsReport.length,
      secretsLines:      secretsReport.length,
      dnsbrute:          dnsbrute.length,
      wayback:           wayback.length,
      screenshots:       screenshotCount,
      vulnerabilities:   vulnerabilities.length,
    },
    samples: {
      subdomains:       subdomains.slice(0, 40),
      liveHosts:        liveHosts.slice(0, 30),
      nonStandardPorts: nonStandardPorts.slice(0, 30),
      endpoints:        endpoints.slice(0, 40),
      jsFiles:          jsFiles.slice(0, 20),
      jsEndpoints:      jsEndpoints.slice(0, 30),
      discoveredDirs:   discoveredDirs.slice(0, 30),
      potentialLeaks:   potentialLeaks.slice(0, 20),
      gfSummary:        gfSummary.slice(0, 30),
      takeoverReport:   takeoverReport.slice(0, 30),
      corsReport:       corsReport.slice(0, 30),
      secretsReport:    secretsReport.slice(0, 20),
    },
  };
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
// Per-finding deep-dive prompt
// ---------------------------------------------------------------------------
function buildFindingPrompt(targetDomain, finding) {
  const vulnName   = getVulnName(finding);
  const severity   = getSeverity(finding) || 'unknown';
  const matchedAt  = getMatchedAt(finding);
  const templateId = finding?.template_id ?? finding?.['template-id'] ?? 'unknown';

  return [
    'You are a senior bug bounty security researcher and mentor.',
    'Generate a concise, professional Markdown vulnerability report for the following finding.',
    'Write so a beginner bug-bounty hunter can both submit AND learn from it.',
    'Use exactly these section headers in this order:',
    '1. Vulnerability Name',
    '2. Description (what it is, in plain English, with one short example)',
    '3. Steps to Reproduce (numbered curl/browser steps a reviewer can copy)',
    '4. Proof of Concept (an exact request/response or URL the triager can replay)',
    '5. Impact (concrete, real-world consequence — not generic CIA fluff)',
    '6. Remediation (specific code/config fix, with a code block if applicable)',
    '7. What I Learned (2-3 bullets teaching the hunter why this template fires and which manual tests confirm it is real vs. a false positive)',
    '',
    'Finding data (JSON):',
    JSON.stringify({ targetDomain, vulnerabilityName: vulnName, severity, matchedAt, templateId, finding }, null, 2),
    '',
    'Write clearly and avoid speculative claims. If specific details are missing, state assumptions explicitly.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Educational "learning" report prompt — always generated
// ---------------------------------------------------------------------------
function buildLearningReportPrompt(targetDomain, recon, criticalCount, highCount) {
  const safeRecon = recon ?? { counts: {}, samples: {} };
  const c = safeRecon.counts;
  const s = safeRecon.samples;

  const surfaceJson = JSON.stringify({
    target: targetDomain,
    counts: c,
    highSeverityFindings: highCount,
    criticalSeverityFindings: criticalCount,
  }, null, 2);

  // Truncated raw samples so the prompt stays reasonable (~25 KB max).
  const samplesJson = JSON.stringify({
    subdomains_first_40:       s.subdomains       ?? [],
    live_hosts_first_30:       s.liveHosts        ?? [],
    non_standard_ports_first_30: s.nonStandardPorts ?? [],
    endpoints_first_40:        s.endpoints        ?? [],
    js_files_first_20:         s.jsFiles          ?? [],
    js_endpoints_first_30:     s.jsEndpoints      ?? [],
    discovered_dirs_first_30:  s.discoveredDirs   ?? [],
    potential_leaks_first_20:  s.potentialLeaks   ?? [],
    gf_pattern_hits:           s.gfSummary        ?? [],
    takeover_report:           s.takeoverReport   ?? [],
    cors_report:               s.corsReport       ?? [],
    secrets_report:            s.secretsReport    ?? [],
  }, null, 2);

  return [
    'You are a senior bug bounty mentor writing a teaching report for a NEW hunter.',
    `Target: ${targetDomain}`,
    '',
    'Goal: turn the raw recon output below into an actionable, *educational* Markdown',
    'report. The hunter should be able to read this report and (a) understand the target\'s',
    'attack surface, (b) know exactly which URLs/endpoints to test by hand next, and',
    '(c) learn WHY each thing matters.',
    '',
    'Required Markdown structure (use these exact H2 headings, in order):',
    '',
    '## 1. Executive Summary',
    '   2-4 sentences: what was scanned, attack surface size, headline risks.',
    '',
    '## 2. Attack Surface Overview',
    '   A small Markdown table of the key counts (subdomains, live hosts, open non-standard',
    '   ports, JS files, endpoints, screenshots, etc.) with a one-line teaching note',
    '   beside each row explaining why a hunter cares about that number.',
    '',
    '## 3. Interesting Subdomains & Hosts',
    '   Pick the 5-10 most interesting subdomains/hosts (admin., dev., staging., api.,',
    '   unusual TLDs, internal-sounding names, IP-only hosts). For each: the hostname,',
    '   ONE sentence on why it stands out, and ONE concrete manual test to run.',
    '',
    '## 4. Endpoints & JavaScript Intelligence',
    '   Highlight the most promising endpoints (admin, debug, api, upload, login, oauth,',
    '   .git, backup, .env, swagger, graphql). Explain what to look for in the JS files',
    '   (hardcoded API keys, internal URLs, role flags). Recommend 3-5 specific manual',
    '   checks (curl examples encouraged).',
    '',
    '## 5. Findings by Severity',
    '   Summarize the high/critical nuclei findings (if any). If zero, say "No automated',
    '   high/critical findings — this does NOT mean the target is safe" and explain why',
    '   manual testing of the surface above is the next step.',
    '',
    '## 6. Manual Testing Playbook',
    '   A numbered checklist of 8-12 *specific* manual tests to run against THIS target',
    '   based on what was discovered. Use real hostnames/paths from the data — not generic',
    '   advice. Each item: one line of what to test + one line of how (curl/Burp tip).',
    '',
    '## 7. What I Learned (Mentor Notes)',
    '   4-6 bullet points teaching the hunter recon concepts that this scan demonstrated',
    '   (e.g. "non-standard ports often reveal forgotten admin panels", "JS files leak',
    '   undocumented API routes", etc.).',
    '',
    'Rules:',
    '- Use real hostnames/URLs/paths from the data — never invent.',
    '- Be concrete and short. No filler. No emoji.',
    '- If a section has nothing to report, say so honestly in one sentence.',
    '- Total length 600-1200 words.',
    '',
    'Attack surface (numbers):',
    surfaceJson,
    '',
    'Raw recon samples (truncated):',
    samplesJson,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Email summary prompt — only when there is at least one high/critical
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
// Static fallback learning report (used when no Gemini key is configured).
// We still want the user to have a useful document.
// ---------------------------------------------------------------------------
function buildStaticLearningReport(targetDomain, recon, criticalCount, highCount, dateTag) {
  const c = recon?.counts ?? {};
  const s = recon?.samples ?? {};
  const list = (title, items, limit = 15) => {
    if (!items || items.length === 0) return `### ${title}\n_None found._\n`;
    return `### ${title} (${items.length}${items.length >= limit ? '+' : ''} shown)\n` +
      items.slice(0, limit).map(x => `- \`${x}\``).join('\n') + '\n';
  };

  return [
    `# Learning Report — ${targetDomain}`,
    `_Generated ${dateTag} • ${recon?.scanDir ? 'Recon dir: `' + recon.scanDir + '`' : 'No recon dir found'}_`,
    '',
    '> **Note:** Gemini API key not configured, so this report contains the raw recon',
    '> summary only. Configure it in **Settings → Gemini API Key** to get the full AI-',
    '> generated educational walkthrough with explanations and manual-testing playbook.',
    '',
    '## Attack Surface',
    '',
    '| Metric | Count | Why it matters |',
    '|---|---|---|',
    `| Subdomains discovered | ${c.subdomains ?? 0} | Wider surface = more places to find forgotten apps |`,
    `| Live HTTP services | ${c.liveHosts ?? 0} | Hosts actually responding right now |`,
    `| Open ports | ${c.activePorts ?? 0} | Non-web services (SSH, DB, RDP) are common goldmines |`,
    `| Non-standard ports | ${c.nonStandardPorts ?? 0} | Custom apps and admin panels often hide off 80/443 |`,
    `| Crawled endpoints | ${c.endpoints ?? 0} | Each one is a candidate for IDOR / auth bypass / injection |`,
    `| JavaScript files | ${c.jsFiles ?? 0} | JS often leaks API routes, role flags, hardcoded keys |`,
    `| Endpoints extracted from JS | ${c.jsEndpoints ?? 0} | Undocumented APIs the dev team forgot about |`,
    `| Discovered directories (ffuf) | ${c.discoveredDirs ?? 0} | Admin, backup, .git, .env style paths |`,
    `| Screenshots captured | ${c.screenshots ?? 0} | Visual triage — spot default panels in seconds |`,
    `| GF triage hits | ${c.gfSummaryLines ?? 0} | Pre-filtered candidates for XSS / SQLi / SSRF |`,
    `| Potential leaks (regex) | ${c.potentialLeaks ?? 0} | API keys / tokens found in raw responses |`,
    `| Subdomain takeover candidates | ${c.takeoverLines ?? 0} | Dangling DNS = easy P1 |`,
    `| CORS / clickjacking notes | ${c.corsLines ?? 0} | Misconfigured headers = account takeover chains |`,
    `| Secret scan hits | ${c.secretsLines ?? 0} | trufflehog/gitleaks-style findings |`,
    `| Wayback URLs | ${c.wayback ?? 0} | Historical URLs uncover old/deprecated endpoints |`,
    `| Nuclei high/critical | C=${criticalCount} H=${highCount} | Automated wins — verify each manually before submitting |`,
    '',
    list('Top Subdomains', s.subdomains, 20),
    list('Live Hosts', s.liveHosts, 15),
    list('Non-Standard Ports', s.nonStandardPorts, 15),
    list('Sample Endpoints', s.endpoints, 25),
    list('JavaScript Files', s.jsFiles, 15),
    list('Endpoints Extracted from JS', s.jsEndpoints, 20),
    list('Discovered Directories (ffuf)', s.discoveredDirs, 20),
    list('GF Pattern Hits', s.gfSummary, 20),
    list('Potential Leaks', s.potentialLeaks, 15),
    list('Subdomain Takeover Report', s.takeoverReport, 20),
    list('CORS / Clickjacking Report', s.corsReport, 20),
    list('Secret Scan Report', s.secretsReport, 15),
    '',
    '## Manual Testing — Quick Start',
    '',
    '1. Open every non-standard port in a browser — admin panels often live there.',
    '2. Grep the JS files for `api`, `token`, `secret`, `internal`, `admin`, `debug`.',
    '3. Replay the most "interesting" endpoint with cookies stripped — auth bypass?',
    '4. Test every login/forgot-password form for user enumeration.',
    '5. Visit `/.git/HEAD`, `/.env`, `/server-status`, `/actuator/env` on each live host.',
    '6. Compare two account contexts on every authenticated endpoint — IDOR.',
    '7. Try the takeover candidates in the report above with `subzy` / manual CNAME check.',
    '8. Use Burp\'s Param Miner on the top 10 endpoints to find hidden parameters.',
    '',
  ].join('\n');
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
  const apiKey      = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const wantedDomain = (process.env.REPORT_DOMAIN || '').trim() || null;

  // Pull latest scan from SQLite (high/critical findings only at this layer).
  const payload = getLatestScan(wantedDomain);
  if (!payload) {
    logInfo(wantedDomain
      ? `No scan data for "${wantedDomain}". Run a scan first.`
      : 'No scan data in database. Run a scan first.');
    return;
  }

  const targetDomain = Object.keys(payload).find(k => k !== '_scanId');
  if (!targetDomain) {
    logInfo('Could not determine target domain from payload.');
    return;
  }

  const node  = payload[targetDomain];
  const vulns = Array.isArray(node?.vulnerability_objects) ? node.vulnerability_objects : [];

  // Final-stage dedupe: same template_id at the same host = one report.
  const seen = new Set();
  const uniqueVulns = vulns.filter((f) => {
    const key = `${f?.template_id ?? f?.['template-id'] ?? f?.template ?? 'unknown'}|${getMatchedAt(f)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const criticalFindings = uniqueVulns.filter(f => getSeverity(f) === 'critical');
  const highFindings     = uniqueVulns.filter(f => getSeverity(f) === 'high');

  // Gather recon artifacts from the on-disk results dir (this is what powers
  // the always-generated learning report, regardless of nuclei findings).
  const scanDir = findLatestScanDir(targetDomain);
  const recon   = scanDir ? gatherReconArtifacts(scanDir) : null;
  if (scanDir) {
    logInfo(`Recon dir: ${scanDir}`);
  } else {
    logInfo(`No recon dir found under ${RESULTS_DIR} for "${targetDomain}".`);
  }

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const safeTarget = sanitizeFilePart(targetDomain);
  const dateTag    = new Date().toISOString().slice(0, 10);
  const learningPath = path.join(REPORTS_DIR, `learning_report_${safeTarget}_${dateTag}.md`);

  logInfo(`Target: ${targetDomain} — critical=${criticalFindings.length} high=${highFindings.length} ` +
          `subdomains=${recon?.counts.subdomains ?? 0} live=${recon?.counts.liveHosts ?? 0} ` +
          `endpoints=${recon?.counts.endpoints ?? 0} screenshots=${recon?.counts.screenshots ?? 0}`);

  // ── 0. Always-on educational/learning report ─────────────────────────────
  // If no API key, write the static fallback (still very useful — full tables
  // of every artifact found). Otherwise, ask Gemini for the rich walkthrough.
  if (!apiKey) {
    logInfo('No GEMINI_API_KEY — writing static learning report (no AI narrative).');
    const md = buildStaticLearningReport(targetDomain, recon, criticalFindings.length, highFindings.length, dateTag);
    await fs.writeFile(learningPath, md, 'utf8');
    logInfo(`Learning report saved: ${learningPath}`);
    // Soft-exit 2 = "report produced, but AI features skipped" — backend treats as success.
    process.exitCode = 2;
    return;
  }

  const aiClient  = new GoogleGenAI({ apiKey });
  const usedPaths = new Set();

  try {
    logInfo('Generating educational learning report…');
    const learningMd = await generateContent(
      aiClient,
      buildLearningReportPrompt(targetDomain, recon, criticalFindings.length, highFindings.length),
    );
    const header = [
      `# Learning Report — ${targetDomain}`,
      `_Generated ${dateTag}${scanDir ? ' • Recon dir: `' + scanDir + '`' : ''}_`,
      '',
      '---',
      '',
    ].join('\n');
    await fs.writeFile(learningPath, header + learningMd, 'utf8');
    logInfo(`Learning report saved: ${learningPath}`);
  } catch (err) {
    logError(`Learning report failed: ${err.message}. Falling back to static template.`);
    const md = buildStaticLearningReport(targetDomain, recon, criticalFindings.length, highFindings.length, dateTag);
    await fs.writeFile(learningPath, md, 'utf8');
    logInfo(`Static learning report saved: ${learningPath}`);
  }

  // ── 1. Per-finding deep-dives (only when there are high/critical) ────────
  for (const finding of uniqueVulns) {
    const vulnName = getVulnName(finding);
    logInfo(`Generating per-finding report: ${vulnName}`);
    try {
      const markdown   = await generateContent(aiClient, buildFindingPrompt(targetDomain, finding));
      const reportPath = await uniqueReportPath(`${safeTarget}_${sanitizeFilePart(vulnName)}`, usedPaths);
      await fs.writeFile(reportPath, markdown, 'utf8');
      logInfo(`Saved: ${reportPath}`);
    } catch (err) {
      logError(`Failed for "${vulnName}": ${err.message}`);
    }
  }

  // ── 2. Email submission summary (only when there are high/critical) ──────
  if (uniqueVulns.length > 0) {
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
  } else {
    logInfo('No high/critical findings → skipping per-finding deep-dives and email summary.');
  }

  logInfo(`Done. learning report + ${uniqueVulns.length} per-finding report(s)` +
          (uniqueVulns.length > 0 ? ' + 1 email summary.' : '.'));
}

main().catch((err) => {
  logError(err.stack ?? err.message);
  process.exitCode = 1;
});
