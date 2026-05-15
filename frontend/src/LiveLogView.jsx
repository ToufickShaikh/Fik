import React, { useCallback, useEffect, useRef, useState } from 'react';

// Derive the WebSocket URL from the current page origin so Vite's /ws proxy
// works in dev and a reverse-proxy works in production without changes.
function makeWsUrl(path) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${path}`;
}

const API_BASE = ''; // relative — Vite proxies /api → localhost:3000

// Strip ANSI/VT100 escape sequences so terminal colors don't appear as raw
// escape codes in the browser. The bash log_* functions in _lib.sh emit them.
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

// Assign a Tailwind text color based on the line content's log prefix so the
// log panel retains visual hierarchy without needing full ANSI support.
function lineColor(line) {
  if (line.includes('[ERROR]')) return 'text-red-400';
  if (line.includes('[WARN]'))  return 'text-yellow-400';
  if (line.includes('[OK]'))    return 'text-green-400';
  if (line.includes('==>'))     return 'text-cyan-300 font-semibold';
  if (line.includes('[INFO]'))  return 'text-slate-300';
  return 'text-slate-400';
}

const PROFILES = [
  { value: 'quick',    label: 'Quick  — CVE + low/medium tags' },
  { value: 'standard', label: 'Standard — param discovery + ffuf' },
  { value: 'deep',     label: 'Deep  — full chain, all modules' },
];

export default function LiveLogView({ initialDomain }) {
  const [lines, setLines]         = useState([]);
  const [status, setStatus]       = useState('idle'); // idle | running | error
  const [domain, setDomain]       = useState('');
  const [profile, setProfile]     = useState('standard');
  const [inputDomain, setInputDomain] = useState('');
  const [wsReady, setWsReady]     = useState(false);
  const [error, setError]         = useState('');
  const [detectedTechs, setDetectedTechs] = useState(null);
  const [nucleiTags, setNucleiTags]       = useState(null);
  const [showTechPanel, setShowTechPanel] = useState(true);
  const [generatingReport, setGeneratingReport] = useState(false);

  // Sync input field whenever the parent passes a new initialDomain.
  useEffect(() => {
    if (initialDomain && typeof initialDomain === 'string') {
      setInputDomain(initialDomain);
    }
  }, [initialDomain]);

  const wsRef       = useRef(null);
  const logEndRef   = useRef(null);
  const reconnTimer = useRef(null);

  // Auto-scroll to the bottom whenever new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Append lines; cap at 5000 to prevent DOM bloat on large scans.
  const pushLine = useCallback((line) => {
    setLines((prev) => {
      const next = [...prev, stripAnsi(line)];
      return next.length > 5000 ? next.slice(next.length - 5000) : next;
    });
  }, []);

  // WebSocket lifecycle: connect, auto-reconnect on close, clean up on unmount.
  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < 2) return;

    const ws = new WebSocket(makeWsUrl('/ws/logs'));
    wsRef.current = ws;

    ws.onopen = () => {
      setWsReady(true);
      setError('');
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        pushLine(evt.data);
        return;
      }

      if (msg.type === 'log') {
        pushLine(msg.line);
        // Parse tech-detection markers emitted by tech_detector.sh → main.sh.
        const stripped = stripAnsi(msg.line);
        const techMatch = stripped.match(/Detected technologies:\s*(.+)/);
        if (techMatch && techMatch[1].trim() !== '(none)') setDetectedTechs(techMatch[1].trim());
        const tagsMatch = stripped.match(/Nuclei tags selected:\s*(.+)/);
        if (tagsMatch) setNucleiTags(tagsMatch[1].trim());
      } else if (msg.type === 'status') {
        setStatus(msg.status === 'started' || msg.status === 'running' ? 'running' : 'idle');
        if (msg.domain) setDomain(msg.domain);
        if (msg.status === 'started') {
          setLines([]); // clear old log on each new scan
          setDetectedTechs(null);
          setNucleiTags(null);
        }
        if (msg.status === 'error') {
          setError(msg.message || 'Unknown scan error');
          setStatus('idle');
        }
      }
    };

    ws.onerror = () => setError('WebSocket error — is the backend running?');

    ws.onclose = () => {
      setWsReady(false);
      // Auto-reconnect after 3s so the panel recovers from backend restarts.
      reconnTimer.current = setTimeout(connect, 3000);
    };
  }, [pushLine]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleStart(e) {
    e.preventDefault();
    const d = inputDomain.trim();
    if (!d) return;

    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/scan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: d, profile }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleStop() {
    try {
      await fetch(`${API_BASE}/api/scan/stop`, { method: 'POST' });
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleGenerateReport() {
    setGeneratingReport(true);
    setError('');
    try {
      const res  = await fetch(`${API_BASE}/api/report/generate`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      if (body.reports && body.reports.length > 0) {
        window.open(`${API_BASE}/api/reports/${encodeURIComponent(body.reports[0].name)}`, '_blank');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingReport(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isRunning = status === 'running';

  return (
    <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      {/* Header row */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-50">Scan Console</h2>
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              !wsReady
                ? 'bg-slate-500'
                : isRunning
                ? 'animate-pulse bg-green-400'
                : 'bg-slate-500'
            }`}
            title={wsReady ? (isRunning ? 'Scan running' : 'Idle') : 'Disconnected'}
          />
          {isRunning && (
            <span className="text-xs text-green-400">
              Scanning <span className="font-semibold text-orange-300">{domain}</span>
            </span>
          )}
        </div>

        {/* WS status badge */}
        <span className={`text-xs ${wsReady ? 'text-green-400' : 'text-slate-500'}`}>
          {wsReady ? 'WS connected' : 'WS disconnected'}
        </span>
      </div>

      {/* Launch form */}
      <form onSubmit={handleStart} className="mb-4 flex flex-wrap gap-2">
        <input
          type="text"
          value={inputDomain}
          onChange={(e) => setInputDomain(e.target.value)}
          placeholder="example.com"
          disabled={isRunning}
          className="flex-1 min-w-[180px] rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
        />

        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          disabled={isRunning}
          className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
        >
          {PROFILES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        <button
          type="submit"
          disabled={isRunning || !inputDomain.trim()}
          className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          Start Scan
        </button>

        <button
          type="button"
          onClick={handleStop}
          disabled={!isRunning}
          className="rounded-xl bg-red-600/70 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          Stop
        </button>
      </form>

      {/* Error banner */}
      {error && (
        <p className="mb-3 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* Tech detection panel — visible once results arrive */}
      {(detectedTechs || nucleiTags) && (
        <div className="mb-3 rounded-xl border border-slate-700/60 bg-slate-800/50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-300">Detected Technologies</span>
            <button
              onClick={() => setShowTechPanel((v) => !v)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              {showTechPanel ? 'Hide' : 'Show'}
            </button>
          </div>
          {showTechPanel && (
            <>
              {detectedTechs && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {detectedTechs.split(',').map((t) => (
                    <span key={t} className="rounded-full border border-cyan-500/40 bg-cyan-900/30 px-2 py-0.5 text-xs text-cyan-300">
                      {t.trim()}
                    </span>
                  ))}
                </div>
              )}
              {nucleiTags && (
                <div>
                  <span className="mr-1.5 text-xs text-slate-500">Nuclei tags:</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {nucleiTags.split(',').map((t) => (
                      <span key={t} className="rounded-full border border-orange-500/40 bg-orange-900/20 px-2 py-0.5 text-xs text-orange-300">
                        {t.trim()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Log panel */}
      <div className="h-72 overflow-auto rounded-xl border border-slate-700/60 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-slate-600">
            {isRunning ? 'Waiting for output…' : 'Start a scan to see live logs here.'}
          </p>
        ) : (
          lines.map((line, idx) => (
            <div key={idx} className={lineColor(line)}>
              {line}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {/* Footer: line count + generate report */}
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-slate-600">
          {lines.length} line{lines.length !== 1 ? 's' : ''}
          {lines.length >= 5000 ? ' (capped at 5000)' : ''}
        </p>
        {!isRunning && lines.length > 0 && (
          <button
            onClick={handleGenerateReport}
            disabled={generatingReport}
            className="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-50 transition-colors"
          >
            {generatingReport ? 'Generating...' : 'Generate Report'}
          </button>
        )}
      </div>
    </article>
  );
}
