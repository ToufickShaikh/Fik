import React, { useState } from 'react';

const API_BASE = '';

const SAMPLE = `# Paste your "In Scope" list — one URL/wildcard per line.
# Wildcards like /admin/* are supported.

https://www.example.com/*
https://api.example.com/v1/*
https://admin.example.com/*
`;

export default function BugBountyScan() {
  const [scopeText, setScopeText] = useState('');
  const [profile, setProfile]     = useState('standard');
  const [label, setLabel]         = useState('');
  const [notes, setNotes]         = useState('');
  const [busy, setBusy]           = useState(false);
  const [planBusy, setPlanBusy]   = useState(false);
  const [error, setError]         = useState('');
  const [info, setInfo]           = useState('');
  const [plan, setPlan]           = useState(null);

  async function handleAiPlan() {
    setError(''); setPlan(null); setPlanBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/ai/plan-scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: notes || 'Plan an efficient bug-bounty scan for the in-scope assets.',
          scopeText,
          techs: [],
        }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      setPlan(body);
      if (body.profile && ['quick','standard','deep'].includes(body.profile)) {
        setProfile(body.profile);
      }
    } catch (err) { setError(err.message); }
    finally { setPlanBusy(false); }
  }

  async function handleLaunch(e) {
    e.preventDefault();
    if (!scopeText.trim()) { setError('Paste at least one in-scope URL.'); return; }
    setBusy(true); setError(''); setInfo('');
    try {
      const res = await fetch(`${API_BASE}/api/bugbounty/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopeText, profile, label, notes }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      setInfo(`Scan launched against ${body.domain} (${body.scopeTokens?.length || 0} scope tokens). Watch the Scan Console.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <article className="rounded-2xl border border-purple-700/40 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">Bug-Bounty Scope Scan</h2>
          <p className="text-[11px] text-slate-500">
            Strict in-scope only — out-of-scope hosts are dropped at every stage.
          </p>
        </div>
        <span className="rounded-full border border-purple-500/40 bg-purple-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-purple-300">
          strict
        </span>
      </div>

      <form onSubmit={handleLaunch} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-slate-400">In-Scope URLs (wildcards OK)</label>
          <textarea
            value={scopeText}
            onChange={(e) => setScopeText(e.target.value)}
            placeholder={SAMPLE}
            rows={8}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 placeholder-slate-600 focus:border-purple-500 focus:outline-none"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Program label (optional)</label>
            <input
              value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. QuintoAndar"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-purple-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Profile</label>
            <select
              value={profile} onChange={(e) => setProfile(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-purple-500 focus:outline-none"
            >
              <option value="quick">Quick</option>
              <option value="standard">Standard</option>
              <option value="deep">Deep</option>
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-slate-400">Notes / focus (optional, also used by AI planner)</label>
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Focus on auth bypass & IDORs in /admin endpoints."
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-purple-500 focus:outline-none"
          />
        </div>

        {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        {info  && <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{info}</p>}

        {plan && (
          <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/30 p-3 text-xs text-slate-200 space-y-1">
            <p><span className="text-cyan-300 font-semibold">AI Plan:</span> profile=<code>{plan.profile}</code></p>
            {plan.nucleiTags && <p>Tags: <code className="text-slate-400">{(plan.nucleiTags||[]).join(', ')}</code></p>}
            {plan.modules   && <p>Modules: <code className="text-slate-400">{(plan.modules||[]).join(', ')}</code></p>}
            {plan.rationale && <p className="text-slate-400 italic">“{plan.rationale}”</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy}
            className="rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-50 transition-colors">
            {busy ? 'Launching…' : 'Launch Strict-Scope Scan'}
          </button>
          <button type="button" onClick={handleAiPlan} disabled={planBusy || !scopeText.trim()}
            className="rounded-xl border border-cyan-500/50 px-4 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-400 disabled:opacity-50 transition-colors">
            {planBusy ? 'Thinking…' : '✨ AI Scan Plan'}
          </button>
        </div>
      </form>
    </article>
  );
}
