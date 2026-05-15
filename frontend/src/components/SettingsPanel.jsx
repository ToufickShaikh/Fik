import React, { useEffect, useState } from 'react';

const API_BASE = 'http://localhost:3000';

const FIELDS = [
  {
    key: 'geminiApiKey',
    label: 'Gemini API Key',
    type: 'password',
    placeholder: 'AIza...',
    hint: 'Used by report_generator.js to produce AI vulnerability reports.',
    span: 2,
  },
  {
    key: 'proxyUrl',
    label: 'Proxy URL',
    type: 'text',
    placeholder: 'http://127.0.0.1:8080',
    hint: 'Passed as PROXY env var to scan modules (optional).',
    span: 2,
  },
  {
    key: 'defaultConcurrency',
    label: 'Default Concurrency',
    type: 'number',
    placeholder: '50',
    hint: 'CONCURRENCY env var — controls subdomain/crawl parallelism.',
    span: 1,
  },
  {
    key: 'nucleiConcurrency',
    label: 'Nuclei Concurrency (-c)',
    type: 'number',
    placeholder: '25',
    hint: 'NUCLEI_CONCURRENCY env var.',
    span: 1,
  },
  {
    key: 'swapFileSizeGB',
    label: 'Swap File Size (GB)',
    type: 'number',
    placeholder: '2',
    hint: 'Size of swap file created by self_healing.sh when RAM is low.',
    span: 1,
  },
  {
    key: 'enableSwapOnLowMem',
    label: 'Enable Swap on Low RAM',
    type: 'checkbox',
    hint: 'self_healing.sh creates swap when available RAM < 500 MB.',
    span: 2,
  },
];

export default function SettingsPanel() {
  const [values, setValues]   = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setValues(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function setField(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      setValues(body);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5">
        <p className="text-sm text-slate-500">Loading settings…</p>
      </article>
    );
  }

  return (
    <article className="rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5 shadow-lg shadow-black/25">
      <h2 className="mb-5 text-lg font-semibold text-slate-50">Settings</h2>

      {error && (
        <p className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      {saved && (
        <p className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          ✓ Settings saved.
        </p>
      )}

      <form onSubmit={handleSave}>
        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map(({ key, label, type, placeholder, hint, span }) => (
            <div key={key} className={`${span === 2 ? 'col-span-2' : 'col-span-1'}`}>
              {type === 'checkbox' ? (
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id={key}
                    checked={!!values[key]}
                    onChange={(e) => setField(key, e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 accent-cyan-500"
                  />
                  <div>
                    <label htmlFor={key} className="cursor-pointer text-sm text-slate-200">{label}</label>
                    {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
                  </div>
                </div>
              ) : (
                <>
                  <label className="mb-1 block text-xs text-slate-400">{label}</label>
                  <input
                    type={type}
                    value={values[key] ?? ''}
                    onChange={(e) =>
                      setField(key, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
                    }
                    placeholder={placeholder}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                  />
                  {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
                </>
              )}
            </div>
          ))}
        </div>

        <div className="mt-5">
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>
    </article>
  );
}
