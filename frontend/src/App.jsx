import React, { useState } from 'react';
import LiveLogView from './LiveLogView';
import ResourceMonitor from './components/ResourceMonitor';
import SettingsPanel from './components/SettingsPanel';
import TargetManager from './components/TargetManager';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function IconSettings() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [showSettings, setShowSettings]     = useState(false);

  return (
    <div className="min-h-screen bg-gray-950 font-sans text-slate-100">
      {/* ── Ambient background glows ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -left-40 -top-20 h-[480px] w-[480px] rounded-full bg-cyan-500/[0.07] blur-3xl" />
        <div className="absolute right-0 top-1/4 h-96 w-96 rounded-full bg-orange-500/[0.07] blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-80 w-96 rounded-full bg-violet-500/[0.06] blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-screen-2xl space-y-5 px-4 py-6 md:px-6 lg:px-8">

        {/* ── Header ── */}
        <header className="flex items-center justify-between gap-4 rounded-2xl border border-slate-700/60 bg-slate-900/80 px-5 py-3.5 shadow-2xl shadow-black/50 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            {/* Logo badge */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 shadow-md shadow-cyan-500/40">
              <span className="text-xs font-bold tracking-tight text-white">FIK</span>
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none tracking-tight text-slate-50">
                Bug Bounty Dashboard
              </h1>
              <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-slate-500">
                Live Recon Intelligence
              </p>
            </div>
          </div>

          {/* Right-side controls */}
          <div className="flex items-center gap-2">
            {selectedDomain && (
              <div className="hidden items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-900/20 px-3 py-1.5 sm:flex">
                <span className="text-[10px] uppercase tracking-widest text-orange-400">target</span>
                <span className="text-xs font-semibold text-orange-300">{selectedDomain}</span>
                <button
                  onClick={() => setSelectedDomain(null)}
                  className="ml-1 text-orange-500 hover:text-orange-300 transition-colors"
                  title="Clear target"
                >
                  <IconClose />
                </button>
              </div>
            )}

            <button
              onClick={() => setShowSettings((v) => !v)}
              title="Toggle settings"
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-all duration-150 ${
                showSettings
                  ? 'border-cyan-500/60 bg-cyan-900/30 text-cyan-300 shadow-lg shadow-cyan-500/10'
                  : 'border-slate-700/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              <IconSettings />
              <span className="hidden sm:inline">Settings</span>
            </button>
          </div>
        </header>

        {/* ── Settings Panel (slide-down) ── */}
        {showSettings && (
          <div className="rounded-2xl border border-cyan-500/20 shadow-xl shadow-cyan-500/5">
            <SettingsPanel onClose={() => setShowSettings(false)} />
          </div>
        )}

        {/* ── Resource Sentinel ── */}
        <ResourceMonitor />

        {/* ── Main content grid ── */}
        {/*  Desktop: 2-col (target list left, scan console right)  */}
        {/*  Mobile:  stacked                                        */}
        <div className="grid gap-5 lg:grid-cols-[minmax(320px,2fr)_3fr]">
          <TargetManager onSelectTarget={setSelectedDomain} />
          <LiveLogView initialDomain={selectedDomain} />
        </div>

        {/* ── Footer ── */}
        <footer className="pb-2 text-center text-[10px] text-slate-700">
          FIK — automated bug bounty framework
        </footer>
      </div>
    </div>
  );
}


const API_URL = 'http://localhost:3000/api/data';

const severityStyles = {
  critical: 'bg-red-500/20 text-red-300 border border-red-400/40',
  high: 'bg-orange-500/20 text-orange-300 border border-orange-400/40',
  medium: 'bg-amber-500/20 text-amber-300 border border-amber-400/40',
  low: 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40',
  info: 'bg-slate-500/20 text-slate-200 border border-slate-300/30',
  unknown: 'bg-slate-500/20 text-slate-200 border border-slate-300/30',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractPort(service) {
  if (!service || typeof service !== 'string') {
    return null;
  }

  try {
    const withProtocol = /^https?:\/\//i.test(service) ? service : `http://${service}`;
    const parsed = new URL(withProtocol);

    if (parsed.port) {
      return Number(parsed.port);
    }

    return parsed.protocol === 'https:' ? 443 : 80;
  } catch (error) {
    const match = service.match(/:(\d{1,5})(?:\/|$)/);
    return match ? Number(match[1]) : null;
  }
}

function formatSeverity(vulnerability) {
  const raw = (vulnerability?.info?.severity || vulnerability?.severity || 'unknown').toLowerCase();
  return raw || 'unknown';
}

function getVulnerabilityName(vulnerability) {
  return (
    vulnerability?.info?.name ||
    vulnerability?.template_name ||
    vulnerability?.template_id ||
    vulnerability?.['template-id'] ||
    'Unnamed finding'
  );
}

function getMatchedHost(vulnerability) {
  return vulnerability?.matched_at || vulnerability?.['matched-at'] || vulnerability?.host || 'Unknown host';
}

function MetricCard({ label, value, accent }) {
  return (
    <article className={`rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25 ${accent}`}>
      <p className="text-xs uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-slate-50">{value}</p>
    </article>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, idx) => (
          <div
            key={`metric-skeleton-${idx}`}
            className="h-28 animate-pulse rounded-2xl border border-slate-700/60 bg-slate-900/70"
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {[...Array(6)].map((_, idx) => (
          <div
            key={`vuln-skeleton-${idx}`}
            className="h-44 animate-pulse rounded-2xl border border-slate-700/60 bg-slate-900/70"
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {[...Array(2)].map((_, idx) => (
          <div
            key={`list-skeleton-${idx}`}
            className="h-72 animate-pulse rounded-2xl border border-slate-700/60 bg-slate-900/70"
          />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchData() {
      setIsLoading(true);
      setError('');

      try {
        const response = await fetch(API_URL, { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        setData(payload);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Failed to load dashboard data.');
        }
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();

    return () => {
      controller.abort();
    };
  }, []);

  const normalized = useMemo(() => {
    if (!data || typeof data !== 'object') {
      return {
        target: 'No target data',
        subdomains: [],
        liveServices: [],
        vulnerabilities: [],
      };
    }

    const target = Object.keys(data)[0] || 'Unknown target';
    const node = data[target] && typeof data[target] === 'object' ? data[target] : {};

    return {
      target,
      subdomains: asArray(node.subdomains),
      liveServices: asArray(node.live_services),
      vulnerabilities: asArray(node.vulnerability_objects),
    };
  }, [data]);

  const metrics = useMemo(() => {
    const uniquePorts = new Set();

    normalized.liveServices.forEach((service) => {
      const port = extractPort(service);
      if (port !== null) {
        uniquePorts.add(port);
      }
    });

    const criticalCount = normalized.vulnerabilities.filter(
      (vulnerability) => formatSeverity(vulnerability) === 'critical',
    ).length;

    return {
      subdomains: normalized.subdomains.length,
      liveHosts: normalized.liveServices.length,
      openPorts: uniquePorts.size,
      criticalVulns: criticalCount,
    };
  }, [normalized]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100" style={{ fontFamily: '"Space Grotesk", "IBM Plex Sans", sans-serif' }}>
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-16 top-8 h-56 w-56 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute right-0 top-24 h-72 w-72 rounded-full bg-orange-500/15 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <section className="relative mx-auto w-full max-w-7xl px-4 py-10 md:px-8">
        <header className="mb-8 rounded-3xl border border-slate-700/70 bg-slate-900/70 p-6 shadow-2xl shadow-black/35 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-cyan-300">Bug Bounty Dashboard</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">Live Recon Intelligence</h1>
              <p className="mt-2 text-sm text-slate-300 md:text-base">
                Target: <span className="font-semibold text-orange-300">{normalized.target}</span>
              </p>
            </div>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`mt-1 shrink-0 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                showSettings ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300' : 'border-slate-600 text-slate-400 hover:border-slate-400'
              }`}
            >
              Settings
            </button>
          </div>
        </header>

        {/* Settings panel */}
        {showSettings && (
          <section className="mb-8">
            <SettingsPanel />
          </section>
        )}

        {/* ── Resource Sentinel ─────────────────────────────────────────── */}
        <section className="mb-8">
          <ResourceMonitor />
        </section>

        {/* ── Target Management ────────────────────────────────────────── */}
        <section className="mb-8">
          <TargetManager onSelectTarget={setSelectedDomain} />
        </section>

        {/* ── Scan Console (always visible) ─────────────────────────────── */}
        <section className="mb-8">
          <LiveLogView initialDomain={selectedDomain} />
        </section>

        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <section className="rounded-2xl border border-red-400/30 bg-red-500/10 p-6 text-red-200">
            <h2 className="text-xl font-semibold">Failed to load scan data</h2>
            <p className="mt-2 text-sm opacity-90">{error}</p>
          </section>
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Total Subdomains" value={metrics.subdomains} accent="shadow-cyan-900/40" />
              <MetricCard label="Live Hosts" value={metrics.liveHosts} accent="shadow-emerald-900/40" />
              <MetricCard label="Open Ports" value={metrics.openPorts} accent="shadow-orange-900/40" />
              <MetricCard label="Critical Vulns" value={metrics.criticalVulns} accent="shadow-red-900/40" />
            </section>

            <section className="mt-8">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-50">Vulnerability Findings</h2>
                <span className="text-sm text-slate-400">{normalized.vulnerabilities.length} total findings</span>
              </div>

              {normalized.vulnerabilities.length === 0 ? (
                <div className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-6 text-slate-300">
                  No vulnerabilities found in the latest scan payload.
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {normalized.vulnerabilities.map((vulnerability, index) => {
                    const severity = formatSeverity(vulnerability);
                    const name = getVulnerabilityName(vulnerability);
                    const host = getMatchedHost(vulnerability);
                    const template = vulnerability?.template_id || vulnerability?.['template-id'] || 'n/a';

                    return (
                      <article
                        key={`${name}-${host}-${index}`}
                        className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25"
                      >
                        <div className="mb-4 flex items-start justify-between gap-3">
                          <h3 className="text-base font-semibold text-slate-100">{name}</h3>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles[severity] || severityStyles.unknown}`}>
                            {severity}
                          </span>
                        </div>
                        <dl className="space-y-2 text-sm text-slate-300">
                          <div>
                            <dt className="text-slate-400">Host</dt>
                            <dd className="truncate text-slate-100">{host}</dd>
                          </div>
                          <div>
                            <dt className="text-slate-400">Template</dt>
                            <dd className="text-slate-100">{template}</dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="mt-8 grid gap-4 lg:grid-cols-2">
              <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
                <h2 className="text-lg font-semibold text-slate-50">Discovered Subdomains</h2>
                <p className="mt-1 text-sm text-slate-400">Hierarchical recon inventory from passive and active enumeration.</p>
                <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
                  {normalized.subdomains.length === 0 ? (
                    <p className="text-sm text-slate-400">No subdomains available.</p>
                  ) : (
                    <ul className="space-y-1.5 text-sm text-slate-200">
                      {normalized.subdomains.map((subdomain) => (
                        <li key={subdomain} className="truncate rounded-lg px-2 py-1.5 hover:bg-slate-800/60">
                          {subdomain}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>

              <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
                <h2 className="text-lg font-semibold text-slate-50">Active Services</h2>
                <p className="mt-1 text-sm text-slate-400">Live hosts and verified HTTP services detected during scanning.</p>
                <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
                  {normalized.liveServices.length === 0 ? (
                    <p className="text-sm text-slate-400">No active services available.</p>
                  ) : (
                    <ul className="space-y-1.5 text-sm text-slate-200">
                      {normalized.liveServices.map((service) => (
                        <li key={service} className="truncate rounded-lg px-2 py-1.5 hover:bg-slate-800/60">
                          {service}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
