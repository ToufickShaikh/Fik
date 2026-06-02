import React, { useEffect, useRef, useState } from 'react';

const API_BASE = ''; // relative â€” Vite proxies /api â†’ localhost:3000

const EMPTY_FORM = { domain: '', includeScope: '', excludeScope: '', notes: '' };

// Match report_generator.js sanitizeFilePart to filter reports by domain.
function sanitizeForFilename(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'unknown';
}

function validate(form) {
  if (!form.domain.trim()) return 'Domain is required.';
  if (!/^[a-zA-Z0-9._-]+$/.test(form.domain.trim()))
    return 'Domain may only contain letters, numbers, dots, hyphens, and underscores.';
  return null;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function TargetManager({ onSelectTarget }) {
  const [targets, setTargets]         = useState([]);
  const [formOpen, setFormOpen]       = useState(false);
  const [editId, setEditId]           = useState(null);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [formError, setFormError]     = useState('');
  const [listError, setListError]     = useState('');
  const [saving, setSaving]           = useState(false);
  const [expandedId, setExpandedId]   = useState(null);
  // details: { [targetId]: { scans, reports, scheduleInput, scheduleSaving, generating, error } }
  const [details, setDetails]         = useState({});
  const domainRef                     = useRef(null);

  // â”€â”€ Data fetching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function fetchTargets() {
    try {
      const res = await fetch(`${API_BASE}/api/targets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTargets(await res.json());
      setListError('');
    } catch (err) {
      setListError(err.message);
    }
  }

  useEffect(() => { fetchTargets(); }, []);
  useEffect(() => { if (formOpen) domainRef.current?.focus(); }, [formOpen]);

  async function loadDetails(target) {
    setDetails((prev) => ({
      ...prev,
      [target.id]: {
        scans: [], reports: [], scheduleInput: target.schedule || '',
        scheduleSaving: false, generating: false, error: '',
        ...prev[target.id],
      },
    }));
    try {
      const [scansRes, reportsRes] = await Promise.all([
        fetch(`${API_BASE}/api/scans?domain=${encodeURIComponent(target.domain)}`),
        fetch(`${API_BASE}/api/reports`),
      ]);
      const scans      = scansRes.ok   ? await scansRes.json()   : [];
      const allReports = reportsRes.ok ? await reportsRes.json() : [];
      const safe       = sanitizeForFilename(target.domain);
      const reports    = allReports.filter((r) => r.name.toLowerCase().startsWith(safe.toLowerCase()));
      setDetails((prev) => ({ ...prev, [target.id]: { ...prev[target.id], scans, reports, scheduleInput: target.schedule || '' } }));
    } catch (err) {
      setDetails((prev) => ({ ...prev, [target.id]: { ...prev[target.id], error: err.message } }));
    }
  }

  function toggleExpand(target) {
    if (expandedId === target.id) {
      setExpandedId(null);
    } else {
      setExpandedId(target.id);
      loadDetails(target);
    }
  }

  // â”€â”€ Target CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function openAdd() {
    setEditId(null); setForm(EMPTY_FORM); setFormError(''); setFormOpen(true);
  }

  function openEdit(target) {
    setEditId(target.id);
    setForm({ domain: target.domain, includeScope: target.includeScope || '', excludeScope: target.excludeScope || '', notes: target.notes || '' });
    setFormError(''); setFormOpen(true);
  }

  function closeForm() { setFormOpen(false); setEditId(null); setForm(EMPTY_FORM); setFormError(''); }

  async function handleSave(e) {
    e.preventDefault();
    const err = validate(form);
    if (err) { setFormError(err); return; }
    setSaving(true); setFormError('');
    try {
      const url    = editId ? `${API_BASE}/api/targets/${editId}` : `${API_BASE}/api/targets`;
      const method = editId ? 'PUT' : 'POST';
      const res    = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: form.domain.trim(), includeScope: form.includeScope.trim(), excludeScope: form.excludeScope.trim(), notes: form.notes.trim() }),
      });
      const body = await res.json();
      if (!res.ok) { setFormError(body.error || `HTTP ${res.status}`); return; }
      await fetchTargets(); closeForm();
    } catch (err) { setFormError(err.message); }
    finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this target?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/targets/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setListError(body.error || `HTTP ${res.status}`); return;
      }
      setTargets((prev) => prev.filter((t) => t.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (err) { setListError(err.message); }
  }

  // â”€â”€ Schedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function handleSetSchedule(targetId) {
    const cronExpr = (details[targetId]?.scheduleInput || '').trim();
    setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], scheduleSaving: true, error: '' } }));
    try {
      const res = await fetch(`${API_BASE}/api/targets/${targetId}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cronExpression: cronExpr }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setTargets((prev) => prev.map((t) => t.id === targetId ? { ...t, schedule: cronExpr || undefined } : t));
    } catch (err) {
      setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], error: err.message } }));
    } finally {
      setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], scheduleSaving: false } }));
    }
  }

  // â”€â”€ Report generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function handleGenerateReport(targetId, scanId = null) {
    setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], generating: true, error: '' } }));
    try {
      const t = targets.find((x) => x.id === targetId);
      const body = {
        ...(t?.domain && { domain: t.domain }),
        ...(Number.isInteger(scanId) && scanId > 0 && { scanId }),
      };
      const res  = await fetch(`${API_BASE}/api/report/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (t) await loadDetails(t);

      const reports = data.reports || [];
      // Always open SOMETHING so the click never feels silent. Prefer the
      // learning report; otherwise the newest report; otherwise show the
      // backend message in the panel so the user knows what happened.
      const fresh = reports.find((r) => r.name.startsWith('learning_report_')) ?? reports[0];
      if (fresh) {
        window.open(`${API_BASE}/api/reports/${encodeURIComponent(fresh.name)}?preview=1`, '_blank');
      }
      if (data.message || !fresh) {
        setDetails((prev) => ({ ...prev, [targetId]: {
          ...prev[targetId],
          error: data.message || 'Report generator finished but produced no files.',
        } }));
      }
    } catch (err) {
      setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], error: err.message } }));
    } finally {
      setDetails((prev) => ({ ...prev, [targetId]: { ...prev[targetId], generating: false } }));
    }
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  return (
    <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-50">Target Management</h2>
        <button
          onClick={openAdd}
          className="rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition-colors"
        >
          + Add Target
        </button>
      </div>

      {listError && (
        <p className="mb-3 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{listError}</p>
      )}

      {/* Add / Edit form */}
      {formOpen && (
        <form onSubmit={handleSave} className="mb-5 rounded-xl border border-slate-600/60 bg-slate-800/70 p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-200">{editId ? 'Edit Target' : 'New Target'}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-400">Domain *</label>
              <input ref={domainRef} value={form.domain}
                onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
                placeholder="example.com"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Notes</label>
              <input value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Include scope (regex)</label>
              <input value={form.includeScope}
                onChange={(e) => setForm((f) => ({ ...f, includeScope: e.target.value }))}
                placeholder=".*\.example\.com"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Exclude scope (regex)</label>
              <input value={form.excludeScope}
                onChange={(e) => setForm((f) => ({ ...f, excludeScope: e.target.value }))}
                placeholder="out-of-scope\.example\.com"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none" />
            </div>
          </div>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={saving}
              className="rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors">
              {saving ? 'Savingâ€¦' : editId ? 'Update' : 'Add'}
            </button>
            <button type="button" onClick={closeForm}
              className="rounded-lg border border-slate-600 px-4 py-1.5 text-xs text-slate-300 hover:border-slate-400 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Target list */}
      {targets.length === 0 ? (
        <p className="text-sm text-slate-500">No targets yet. Click â€œ+ Add Targetâ€ to get started.</p>
      ) : (
        <ul className="space-y-2">
          {targets.map((t) => {
            const isExpanded = expandedId === t.id;
            const d = details[t.id] || {};
            return (
              <li key={t.id} className="rounded-xl border border-slate-700/60 bg-slate-950/50">
                {/* Row */}
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold text-slate-100 text-sm">{t.domain}</p>
                      {t.schedule && (
                        <span className="rounded-full border border-purple-500/40 bg-purple-900/20 px-1.5 py-0.5 text-[10px] text-purple-400">
                          â° {t.schedule}
                        </span>
                      )}
                    </div>
                    {t.notes && <p className="truncate text-xs text-slate-500">{t.notes}</p>}
                    {(t.includeScope || t.excludeScope) && (
                      <p className="truncate text-xs text-slate-600">
                        {t.includeScope && <span className="text-green-600">+{t.includeScope} </span>}
                        {t.excludeScope && <span className="text-red-600">âˆ’{t.excludeScope}</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button onClick={() => onSelectTarget && onSelectTarget(t.domain)}
                      className="rounded-lg bg-orange-600/70 px-2.5 py-1 text-xs font-semibold text-white hover:bg-orange-500 transition-colors"
                      title="Start scan for this target">Scan</button>
                    <button onClick={() => openEdit(t)}
                      className="rounded-lg border border-slate-600 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-400 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(t.id)}
                      className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-400 hover:border-red-400 transition-colors">Delete</button>
                    <button onClick={() => toggleExpand(t)}
                      className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-400 hover:border-slate-400 transition-colors"
                      title={isExpanded ? 'Collapse' : 'Details'}>{isExpanded ? 'â–²' : 'â–¼'}</button>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-slate-700/60 px-4 py-4 space-y-5">
                    {d.error && <p className="text-xs text-red-400">{d.error}</p>}

                    {/* Schedule */}
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Auto-Schedule</p>
                      <div className="flex gap-2">
                        <input
                          value={d.scheduleInput ?? ''}
                          onChange={(e) => setDetails((prev) => ({ ...prev, [t.id]: { ...prev[t.id], scheduleInput: e.target.value } }))}
                          placeholder="Cron expression (e.g. 0 2 * * *) â€” leave blank to disable"
                          className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                        />
                        <button onClick={() => handleSetSchedule(t.id)} disabled={d.scheduleSaving}
                          className="rounded-lg bg-purple-600/70 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-500 disabled:opacity-50 transition-colors">
                          {d.scheduleSaving ? 'Savingâ€¦' : 'Set'}
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-600">
                        5-field cron. Examples:Â <code className="text-slate-500">0 2 * * *</code> (daily 2 AM),Â <code className="text-slate-500">0 0 * * 0</code> (weekly Sunday)
                      </p>
                    </div>

                    {/* Past scans */}
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Past Scans</p>
                      {!d.scans ? (
                        <p className="text-xs text-slate-600">Loading…</p>
                      ) : d.scans.length === 0 ? (
                        <p className="text-xs text-slate-600">No scans recorded yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {d.scans.slice(0, 8).map((s) => (
                            <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/60 px-3 py-1.5">
                              <span className="flex min-w-0 flex-1 items-center gap-2">
                                <span className="truncate font-mono text-xs text-slate-300">scan #{s.id}</span>
                                <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                  {s.findingCount ?? 0} finding{s.findingCount === 1 ? '' : 's'}
                                </span>
                              </span>
                              <span className="flex shrink-0 items-center gap-3">
                                <span className="text-[10px] text-slate-500">{fmtDate(s.scanDate || s.generatedAt)}</span>
                                <button
                                  onClick={() => handleGenerateReport(t.id, s.id)}
                                  disabled={d.generating}
                                  title="Regenerate the learning report from this past scan"
                                  className="rounded-md border border-emerald-600/40 px-2 py-0.5 text-[10px] text-emerald-400 hover:border-emerald-400 disabled:opacity-50 transition-colors"
                                >
                                  Report
                                </button>
                              </span>
                            </li>
                          ))}
                          {d.scans.length > 8 && (
                            <li className="text-[10px] text-slate-600 pl-1">+{d.scans.length - 8} more</li>
                          )}
                        </ul>
                      )}
                    </div>

                    {/* Reports */}
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reports</p>
                        <button onClick={() => handleGenerateReport(t.id)} disabled={d.generating}
                          className="rounded-lg border border-emerald-600/50 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-400 disabled:opacity-50 transition-colors">
                          {d.generating ? 'Generatingâ€¦' : '+ Generate'}
                        </button>
                      </div>
                      {!d.reports ? (
                        <p className="text-xs text-slate-600">Loadingâ€¦</p>
                      ) : d.reports.length === 0 ? (
                        <p className="text-xs text-slate-600">No reports yet. Click â€œ+ Generateâ€ to create one from the latest scan.</p>
                      ) : (
                        <ul className="space-y-1">
                          {d.reports.map((r) => (
                            <li key={r.name} className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-1.5">
                              <span className="truncate font-mono text-xs text-slate-300">{r.name}</span>
                              <span className="ml-2 flex shrink-0 items-center gap-3">
                                <a href={`${API_BASE}/api/reports/${encodeURIComponent(r.name)}?preview=1`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
                                  Read
                                </a>
                                <a href={`${API_BASE}/api/reports/${encodeURIComponent(r.name)}`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                                  Download
                                </a>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
