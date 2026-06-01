import React, { useState } from 'react';

const API_BASE = '';

export default function AIReportPanel() {
  const [domain, setDomain]    = useState('');
  const [prompt, setPrompt]    = useState('');
  const [notes, setNotes]      = useState('');
  const [includeScan, setIncludeScan] = useState(true);
  const [busy, setBusy]        = useState(false);
  const [error, setError]      = useState('');
  const [output, setOutput]    = useState(null);
  const [reportName, setReportName] = useState('');

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError('File too large (max 5 MB).'); return; }
    const text = await file.text();
    setNotes((prev) => prev ? `${prev}\n\n--- ${file.name} ---\n${text}` : text);
  }

  async function handleGenerate(e) {
    e.preventDefault();
    if (!prompt.trim() && !notes.trim()) { setError('Add a prompt or notes.'); return; }
    setBusy(true); setError(''); setOutput(null); setReportName('');
    try {
      const res = await fetch(`${API_BASE}/api/ai/report-from-notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() || 'manual', prompt, notes, includeScan }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      setOutput(body.content);
      setReportName(body.reportName);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <article className="rounded-2xl border border-emerald-700/40 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">AI Report Builder</h2>
          <p className="text-[11px] text-slate-500">
            Generate a Markdown report from a prompt + your notes. Optionally enriches with the latest scan data.
          </p>
        </div>
        <span className="rounded-full border border-emerald-500/40 bg-emerald-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
          gemini
        </span>
      </div>

      <form onSubmit={handleGenerate} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Target (optional)</label>
            <input
              value={domain} onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={includeScan} onChange={(e) => setIncludeScan(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-emerald-500" />
              Include latest scan findings as context
            </label>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-slate-400">Prompt</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
            placeholder="e.g. Write a P2 IDOR report. Include reproduction steps from my notes and a CVSS estimate."
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none" />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-slate-400">Notes / evidence (paste or upload)</label>
            <label className="cursor-pointer rounded-lg border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-400">
              Upload file
              <input type="file" className="hidden" accept=".txt,.md,.log,.json,.csv"
                onChange={handleFile} />
            </label>
          </div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={6}
            placeholder="Burp requests, response snippets, repro steps…"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none" />
        </div>

        {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
            {busy ? 'Generating…' : '✨ Generate Report'}
          </button>
          {reportName && (
            <a href={`${API_BASE}/api/reports/${encodeURIComponent(reportName)}`} target="_blank" rel="noopener noreferrer"
              className="rounded-xl border border-emerald-500/50 px-4 py-2 text-sm font-semibold text-emerald-300 hover:border-emerald-400 transition-colors">
              Download ({reportName})
            </a>
          )}
        </div>
      </form>

      {output && (
        <pre className="mt-4 max-h-96 overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-xs text-slate-200 whitespace-pre-wrap">
{output}
        </pre>
      )}
    </article>
  );
}
