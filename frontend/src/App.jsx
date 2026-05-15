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
      {/* â”€â”€ Ambient background glows â”€â”€ */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -left-40 -top-20 h-[480px] w-[480px] rounded-full bg-cyan-500/[0.07] blur-3xl" />
        <div className="absolute right-0 top-1/4 h-96 w-96 rounded-full bg-orange-500/[0.07] blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-80 w-96 rounded-full bg-violet-500/[0.06] blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-screen-2xl space-y-5 px-4 py-6 md:px-6 lg:px-8">

        {/* â”€â”€ Header â”€â”€ */}
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

        {/* â”€â”€ Settings Panel (slide-down) â”€â”€ */}
        {showSettings && (
          <div className="rounded-2xl border border-cyan-500/20 shadow-xl shadow-cyan-500/5">
            <SettingsPanel onClose={() => setShowSettings(false)} />
          </div>
        )}

        {/* â”€â”€ Resource Sentinel â”€â”€ */}
        <ResourceMonitor />

        {/* â”€â”€ Main content grid â”€â”€ */}
        {/*  Desktop: 2-col (target list left, scan console right)  */}
        {/*  Mobile:  stacked                                        */}
        <div className="grid gap-5 lg:grid-cols-[minmax(320px,2fr)_3fr]">
          <TargetManager onSelectTarget={setSelectedDomain} />
          <LiveLogView initialDomain={selectedDomain} />
        </div>

        {/* â”€â”€ Footer â”€â”€ */}
        <footer className="pb-2 text-center text-[10px] text-slate-700">
          FIK â€” automated bug bounty framework
        </footer>
      </div>
    </div>
  );
}
