import React, { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = 'ws://localhost:3000/ws/logs';

// ---------------------------------------------------------------------------
// GaugeBar — compact horizontal progress bar with colour-coded thresholds.
// ---------------------------------------------------------------------------
function GaugeBar({ label, percent, valueLabel }) {
  const clampedPct = Math.min(Math.max(percent, 0), 100);
  const barColor =
    clampedPct > 80 ? 'bg-red-500'
    : clampedPct > 60 ? 'bg-yellow-400'
    : 'bg-emerald-500';
  const textColor =
    clampedPct > 80 ? 'text-red-400'
    : clampedPct > 60 ? 'text-yellow-400'
    : 'text-emerald-400';

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <span className={`text-xs font-semibold tabular-nums ${textColor}`}>{valueLabel}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      <p className="mt-0.5 text-right text-[10px] text-slate-600">{clampedPct}%</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

// ---------------------------------------------------------------------------
// ResourceMonitor component
// Opens its own WebSocket connection (no coupling to LiveLogView) so it can
// be placed independently in the layout.
// ---------------------------------------------------------------------------
export default function ResourceMonitor() {
  const [stats, setStats]         = useState(null);
  const [scanActive, setScanActive] = useState(false);
  const [paused, setPaused]       = useState(false);
  const [wsReady, setWsReady]     = useState(false);
  const wsRef                     = useRef(null);
  const reconnTimer               = useRef(null);

  // ── WebSocket lifecycle ────────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < 2) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen  = () => setWsReady(true);
    ws.onerror = () => setWsReady(false);

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'resources') {
        setStats(msg);
      } else if (msg.type === 'status') {
        if (msg.status === 'started' || msg.status === 'running') {
          setScanActive(true); setPaused(false);
        } else if (msg.status === 'paused') {
          setScanActive(true); setPaused(true);
        } else {
          // stopped / idle / error
          setScanActive(false); setPaused(false);
        }
      }
    };

    ws.onclose = () => {
      setWsReady(false);
      reconnTimer.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── Pause / Resume ────────────────────────────────────────────────────────

  function sendMsg(type) {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type }));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Determine if any resource is in a warning/critical state for the header dot.
  const cpuPct  = stats?.cpuPercent  ?? 0;
  const ramPct  = stats?.ramPercent  ?? 0;
  const swapPct = stats?.swapPercent ?? 0;
  const maxPct  = Math.max(cpuPct, ramPct, swapPct);
  const headerDot = maxPct > 80 ? 'bg-red-500 animate-pulse'
    : maxPct > 60 ? 'bg-yellow-400'
    : 'bg-emerald-500';

  return (
    <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      {/* ── Header ── */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-50">Resource Sentinel</h2>
          {stats && (
            <span
              className={`h-2.5 w-2.5 rounded-full ${headerDot}`}
              title={`Peak ${maxPct}%`}
            />
          )}
        </div>

        {/* Pause / Resume buttons */}
        <div className="flex items-center gap-2">
          {!scanActive && (
            <span className="text-xs text-slate-600">No active scan</span>
          )}
          <button
            onClick={() => sendMsg('pause_scan')}
            disabled={!scanActive || paused}
            className="rounded-xl bg-amber-600/70 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            title="Send SIGSTOP to scan process group"
          >
            ⏸ Pause
          </button>
          <button
            onClick={() => sendMsg('resume_scan')}
            disabled={!scanActive || !paused}
            className="rounded-xl bg-emerald-600/70 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            title="Send SIGCONT to scan process group"
          >
            ▶ Resume
          </button>
        </div>
      </div>

      {/* ── Paused banner ── */}
      {paused && (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-900/20 px-3 py-2 text-center text-xs font-semibold text-amber-400 animate-pulse">
          ⏸ Scan is paused — resources freed until resumed
        </div>
      )}

      {/* ── Gauges ── */}
      {!stats ? (
        <p className="text-xs text-slate-500">
          {wsReady ? 'Waiting for resource data…' : 'Connecting to backend…'}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <GaugeBar
            label="CPU"
            percent={cpuPct}
            valueLabel={`${cpuPct}%`}
          />
          <GaugeBar
            label="RAM"
            percent={ramPct}
            valueLabel={
              stats.ramTotalMB > 0
                ? `${fmtMB(stats.ramUsedMB)} / ${fmtMB(stats.ramTotalMB)}`
                : `${ramPct}%`
            }
          />
          <GaugeBar
            label="Swap"
            percent={swapPct}
            valueLabel={
              stats.swapTotalMB > 0
                ? `${fmtMB(stats.swapUsedMB)} / ${fmtMB(stats.swapTotalMB)}`
                : 'N/A'
            }
          />
        </div>
      )}

      {/* ── Footer ── */}
      <p className="mt-3 text-right text-[10px] text-slate-700">
        {wsReady ? 'live · 2 s interval' : 'reconnecting…'}
      </p>
    </article>
  );
}
