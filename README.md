# Fik — Automated Bug-Bounty Recon Framework

Fik is an end-to-end bash + Node.js framework that chains together best-of-breed
recon tools (subfinder, httpx, katana, ffuf, nuclei, gowitness, …) into a single
reproducible pipeline, ships findings to a small Express + WebSocket backend, and
visualizes them in a React/Vite dashboard. It is designed to run **continuously
on a low-spec Linux box** (Parrot OS, Debian-slim, or any container host) without
filling the disk.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                  Fik runtime                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  main.sh -d <domain> -p quick|standard|deep                                  │
│     │                                                                        │
│     ├─► modules/*.sh   (recon pipeline, see table below)                     │
│     ├─► scan_results.json + summary.json + summary.txt                       │
│     │                                                                        │
│     └─► POST /api/ingest ──►  backend/server.js  ──► WebSocket /ws/logs      │
│                                       ▲                                      │
│                                       └── frontend (Vite/React, port 5173)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Quick start

### Docker (recommended)

```bash
docker compose build      # builds backend image with Go 1.23.4 + all PD tools
docker compose up -d      # starts backend (3000), frontend (5173)
# open http://localhost:5173 — add a target → Run scan
```

### Bare metal (Linux)

```bash
./setup_linux.sh          # strips BOM/CRLF, marks scripts executable
./modules/install_tools.sh # installs Go tools to ~/go/bin
./main.sh -d example.com -p standard
```

The framework writes everything under `results/<safe_domain>_<timestamp>/`.
The backend ingests `scan_results.json` automatically when run via the GUI;
when launched manually you can post it yourself:

```bash
curl -X POST -H 'Content-Type: application/json' \
     --data-binary @results/example_com_20260101_120000/scan_results.json \
     http://localhost:3000/api/ingest
```

---

## 2. Module pipeline

Every module lives in [modules/](modules/) and exports exactly one entry-point
function. `main.sh` sources them in the order below and executes only the
functions enabled by the active scan profile.

| # | Module                                       | Function                     | Tools                            | Primary outputs                                                           |
|---|----------------------------------------------|------------------------------|----------------------------------|----------------------------------------------------------------------------|
| 0 | [_lib.sh](modules/_lib.sh)                   | (sourced helpers)            | —                                | log_*, run_tool, register_tempfile                                         |
| 1 | [self_healing.sh](modules/self_healing.sh)   | `ensure_required_tools`      | apt / go install                 | (side-effect: installs missing binaries)                                   |
| 2 | [install_tools.sh](modules/install_tools.sh) | `ensure_required_tools` (impl) | go install                     | (side-effect)                                                              |
| 3 | [scope.sh](modules/scope.sh)                 | `load_scope`                 | —                                | in-memory include/exclude regex from `targets.json`                        |
| 4 | [subdomains.sh](modules/subdomains.sh)       | `run_subdomain_enumeration`  | subfinder, assetfinder, httpx    | `subdomains.txt`, `live_hosts.txt`                                         |
| 5 | [dnsbrute.sh](modules/dnsbrute.sh)           | `run_dns_brute`              | puredns / shuffledns             | `bruted_subdomains.txt`                                                    |
| 6 | [portscan.sh](modules/portscan.sh)           | `run_port_scan`              | naabu                            | `active_ports.txt`                                                         |
| 7 | [crawler.sh](modules/crawler.sh)             | `run_crawler`                | katana                           | `endpoints.txt` (capped), `js_files.txt`, `potential_leaks.txt`            |
| 8 | [fuzzer.sh](modules/fuzzer.sh)               | `run_fuzzer`                 | ffuf, jq                         | `discovered_directories.txt` (per-host JSON files cleaned up post-scan)    |
| 9 | [tech_detector.sh](modules/tech_detector.sh) | `detect_technologies`        | httpx -tech, wappalyzer          | `technologies.txt`, sets `NUCLEI_TAGS`                                     |
| 10 | [vulnscan.sh](modules/vulnscan.sh)          | `run_vulnerability_scan`     | nuclei                           | `vulnerabilities.jsonl`, `vulnerabilities.txt`                             |
| 11 | [wayback.sh](modules/wayback.sh)            | `run_wayback_recon`          | waybackurls / cdx, httpx, nuclei | `wayback_urls_{raw,filtered,live}.txt` (raw capped), `wayback_findings.jsonl` |
| 12 | [jsendpoints.sh](modules/jsendpoints.sh)    | `run_js_endpoints`           | subjs, katana -jc, curl+regex    | `js_endpoints.txt`, `all_urls.txt` (capped)                                |
| 13 | [takeover.sh](modules/takeover.sh)          | `run_subdomain_takeover`     | subjack / subzy                  | `takeover_findings.txt`                                                    |
| 14 | [secrets.sh](modules/secrets.sh)            | `run_secret_scan`            | trufflehog / regex on JS         | `secrets.jsonl`, `secrets.txt` (`js_stash/` cleaned up post-scan)          |
| 15 | [gf_triage.sh](modules/gf_triage.sh)        | `run_gf_triage`              | gf                               | `gf_<pattern>.txt` per pattern                                             |
| 16 | [screenshots.sh](modules/screenshots.sh)    | `run_screenshots`            | gowitness                        | `screenshots/*.png` (gowitness sqlite removed post-scan)                   |
| 17 | [cors.sh](modules/cors.sh)                  | `run_cors_check`             | curl                             | `cors_findings.txt`                                                        |
| 18 | [exporter.sh](modules/exporter.sh)          | `export_to_json`             | jq                               | **`scan_results.json`** (locked schema — see §5)                           |
| 19 | [diff.sh](modules/diff.sh)                  | `run_diff_against_previous`  | jq                               | `diff_new_subdomains.txt`, `diff_new_services.txt`, `diff_new_vulnerabilities.jsonl` |
| 20 | [cleanup.sh](modules/cleanup.sh)            | `run_cleanup`                | jq, gzip, find                   | **`summary.json`**, **`summary.txt`**, slim `scan_results.json`, gzipped raw artefacts |
| 21 | [notify.sh](modules/notify.sh)              | `run_notifications`          | notify (PD)                      | (push to Slack/Discord/Telegram webhook)                                   |

After the loop finishes, `main.sh` POSTs `scan_results.json` to `${INGEST_URL:-http://localhost:3000/api/ingest}`.

---

## 3. Scan profiles

Profiles select which modules run. They are an aggressive way to control the
total **wall-clock time** and **disk usage** of a scan.

| Profile    | Modules executed                                              | Typical runtime | Typical disk / scan |
|------------|---------------------------------------------------------------|-----------------|---------------------|
| `quick`    | scope, subdomains, portscan, tech_detector, vulnscan, takeover, cors, exporter, diff, cleanup, notify | 3–10 min        | 1–10 MB             |
| `standard` | quick + crawler, fuzzer, wayback, js_endpoints, secrets, gf_triage, cors                              | 20–60 min       | 20–200 MB           |
| `deep`     | everything (adds dns_brute + screenshots)                                                              | 1–6 h           | 100 MB – 2 GB       |

Profile is selected with `-p` on the CLI or via the dashboard's target form.

Skip lists live in `main.sh`:

```bash
_QUICK_SKIP=( run_crawler run_fuzzer run_wayback_recon run_js_endpoints
              run_secret_scan run_gf_triage run_screenshots run_dns_brute )
_STD_SKIP=( run_dns_brute run_screenshots )
```

---

## 4. Scope filtering

`backend/targets.json` (mounted read-only into the container) supports
per-target `includeScope` / `excludeScope` regex arrays. `modules/scope.sh`
loads them at start-up and exposes a `scope_filter` shell function consumed by
`subdomains.sh`, `wayback.sh`, and `crawler.sh` to drop hosts that fall outside
program scope.

```jsonc
{
  "id": "acme",
  "domain": "acme.com",
  "includeScope": ["\\.acme\\.com$", "^acme\\."],
  "excludeScope": ["^marketing\\.acme\\.com$"]
}
```

---

## 5. Output schema (locked)

The shape of `scan_results.json` is the contract between `main.sh`,
`backend/server.js`, `backend/report_generator.js`, and `frontend/src/App.jsx`.
**Do not change top-level keys without coordinating all four files.**

```jsonc
{
  "<target_domain>": {
    "generated_at": "2026-05-15T02:22:43Z",
    "subdomains":    ["a.example.com", "b.example.com", "..."],
    "live_services": ["https://a.example.com", "https://1.2.3.4:8443", "..."],
    "vulnerability_objects": [
      // After cleanup.sh runs (default), each finding is slimmed to:
      {
        "template-id": "CVE-2023-12345",
        "type":         "http",
        "host":         "https://a.example.com",
        "matched-at":   "https://a.example.com/api/v1/users",
        "url":          "https://a.example.com/api/v1/users",
        "info": {
          "name":     "Example RCE",
          "severity": "high",
          "tags":     ["cve", "rce"]
        }
      }
    ]
  }
}
```

The full nuclei output (templates, request/response bodies, base64 dumps,
extracted-results) is preserved on disk as `vulnerabilities.jsonl.gz` if you
need it for forensics, but it is **not** embedded in `scan_results.json`. This
is the single biggest win against the multi-GB scan files Fik used to produce.

The companion `summary.json` is the canonical small artefact — useful for
fast triage on disk-constrained hosts and for the GUI dashboard:

```jsonc
{
  "target": "example.com",
  "profile": "standard",
  "generated_at": "2026-05-15T02:22:43Z",
  "counts": {
    "subdomains": 142,
    "live_services": 38,
    "vulnerabilities": 17,
    "secrets": 2,
    "endpoints": 7841,
    "discovered_paths": 233,
    "cors_findings": 4,
    "takeover_findings": 0,
    "wayback_live_urls": 489
  },
  "severity":      { "high": 2, "medium": 5, "low": 6, "info": 4 },
  "top_templates": [{ "key": "tech-detect", "value": 18 }, ...]
}
```

---

## 6. Disk-footprint optimization

Fik keeps repository + per-scan size tightly bounded:

| Knob                    | Default     | Effect                                                          |
|-------------------------|-------------|------------------------------------------------------------------|
| `MAX_WAYBACK_URLS`      | 50000       | Cap raw archived URLs (`wayback_urls_raw.txt`)                   |
| `MAX_ENDPOINTS`         | 50000       | Cap katana output (`endpoints.txt`)                              |
| `MAX_ALL_URLS`          | 100000      | Cap merged `all_urls.txt`                                        |
| `COMPRESS_MIN_BYTES`    | 65536       | gzip every artefact larger than this after the scan              |
| `RETENTION_KEEP`        | 10          | Keep only this many scan dirs per target prefix                  |
| `KEEP_RAW_VULNS`        | 1           | Keep gzipped full nuclei jsonl on disk                           |
| `KEEP_RAW_WAYBACK`      | 1           | Keep gzipped raw wayback URL list                                |
| `SLIM_VULN_FIELDS`      | 1           | Rewrite `scan_results.json` with the slim vulnerability shape    |

`run_cleanup` is the last module before `run_notifications`. Concretely it:

1. Slims `scan_results.json` so `vulnerability_objects[*]` only contains the
   six fields consumed by the report generator.
2. Removes `js_stash/` (up to 500 MB of raw JS) and `ffuf_json/` (per-host JSON
   blobs) — both are pure intermediates whose useful data is already extracted
   into `secrets.txt` and `discovered_directories.txt`.
3. Drops `screenshots/gowitness.sqlite3` (the PNGs are kept).
4. Gzips every remaining text/jsonl artefact above `COMPRESS_MIN_BYTES`.
5. Writes `summary.json` + `summary.txt`.
6. Prunes scan directories beyond `RETENTION_KEEP` per target prefix.
7. Logs a before/after disk-usage delta.

### Container-image bloat

`.dockerignore` excludes `node_modules/`, `results/`, `backend/database/`,
`backend/reports/`, `frontend/dist/`, `.git/`, archives, and logs from the
Docker build context. This single change cuts the build context from
multi-GB to ~MB on a workspace with prior scans.

The backend `Dockerfile` further runs `go clean -cache -modcache -testcache`
and `rm -rf /root/sdk /root/go/pkg /tmp/*` at the end of the install layer to
keep the final image lean.

### Repo-side hygiene

`.gitignore` excludes `results/`, `backend/database/scan_*.json`,
`backend/reports/*.html|*.md`, `node_modules/`, `frontend/dist/`, plus the
usual editor / OS noise and `*.gz`/`*.zip`/`*.tar` archives.

---

## 7. Environment variables

### Backend (`backend/server.js`)

| Variable        | Default                              | Notes                                                |
|-----------------|--------------------------------------|------------------------------------------------------|
| `PORT`          | `3000`                               | HTTP + WebSocket port                                |
| `FRAMEWORK_DIR` | `..` of backend dir (or `/framework` in container) | Where `main.sh` lives           |
| `INGEST_URL`    | `http://localhost:3000/api/ingest`   | Used by `main.sh` to POST results                    |

`backend/settings.json` (created on first save by the dashboard):

```jsonc
{
  "geminiApiKey":       "",       // optional, enables AI report writer
  "proxyUrl":           "",
  "defaultConcurrency": 50,
  "nucleiConcurrency":  25,
  "swapFileSizeGB":     2,
  "enableSwapOnLowMem": true
}
```

### Recon pipeline

| Variable                | Default              | Purpose                                                                  |
|-------------------------|----------------------|--------------------------------------------------------------------------|
| `SCAN_PROFILE`          | `standard`           | `quick`, `standard`, `deep`                                              |
| `HTTPX_RATE_LIMIT`      | profile-aware        | rps for httpx                                                            |
| `HTTPX_THREADS`         | profile-aware        | concurrency for httpx                                                    |
| `KATANA_DELAY`          | profile-aware        | seconds between katana requests                                          |
| `KATANA_CONCURRENCY`    | profile-aware        | parallel katana fetches                                                  |
| `KATANA_DURATION`       | profile-aware        | hard cap on crawl duration (e.g. `3m`, `15m`)                            |
| `FFUF_RATE`             | profile-aware        | rps per host                                                             |
| `FFUF_MAXTIME`          | 180/300              | max seconds per host                                                     |
| `FFUF_WORDLIST`         | `/usr/share/wordlists/dirb/common.txt` | overrides default                                       |
| `NUCLEI_RATE_LIMIT`     | 20                   | global rps                                                               |
| `NUCLEI_BULK_SIZE`      | 10                   | nuclei `-bulk-size`                                                      |
| `NUCLEI_CONCURRENCY`    | profile-aware        | nuclei `-c`                                                              |
| `NUCLEI_TAGS`           | profile-aware        | overridden by `tech_detector` if it identifies stacks                    |
| `NUCLEI_RETRIES`        | 2                    | nuclei `-retries`                                                        |
| `MAX_WAYBACK_URLS`      | 50000                | hard cap on `wayback_urls_raw.txt`                                       |
| `MAX_ENDPOINTS`         | 50000                | hard cap on `endpoints.txt`                                              |
| `MAX_ALL_URLS`          | 100000               | hard cap on `all_urls.txt`                                               |
| `COMPRESS_MIN_BYTES`    | 65536                | gzip threshold in cleanup                                                |
| `RETENTION_KEEP`        | 10                   | per-target scan-dir retention                                            |
| `KEEP_RAW_VULNS`        | 1                    | keep gzipped nuclei jsonl                                                |
| `KEEP_RAW_WAYBACK`      | 1                    | keep gzipped wayback raw URLs                                            |
| `SLIM_VULN_FIELDS`      | 1                    | enable slim transform on `scan_results.json`                             |
| `CHROME_PATH`           | `/usr/bin/chromium`  | gowitness Chrome binary                                                  |
| `NOTIFY_WEBHOOK_URL`    | (unset)              | Slack/Discord/Telegram URL                                               |
| `NOTIFY_WEBHOOK_TYPE`   | `slack`              | `slack`, `discord`, `telegram`, `generic`                                |

---

## 8. Backend API

```
GET  /api/health                       liveness
GET  /api/data                         most-recent ingested scan payload
POST /api/ingest                       receives scan_results.json (≤20 MB)
GET  /api/targets                      list configured targets
POST /api/targets                      add target
PUT  /api/targets/:id                  update target
DELETE /api/targets/:id                remove target
POST /api/targets/:id/run              spawn ./main.sh -d <domain> -p <profile>
POST /api/targets/:id/schedule         set node-cron expression
GET  /api/settings                     read settings.json
PUT  /api/settings                     write settings.json
GET  /api/system                       CPU / RAM / disk pressure
WS   /ws/logs                          live scan log stream (line-by-line)
```

---

## 9. Tools that Fik depends on

Installed at image build time via `apt-get` and `go install`. Missing tools
are retried at runtime by `modules/install_tools.sh` and any still-missing
tool causes its module to be skipped (never fatal).

| Tool        | Source                                            | Pinned Go ver |
|-------------|---------------------------------------------------|---------------|
| subfinder   | `github.com/projectdiscovery/subfinder/...`       | latest        |
| httpx       | `github.com/projectdiscovery/httpx/...`           | latest        |
| naabu       | `github.com/projectdiscovery/naabu/...`           | latest        |
| nuclei      | `github.com/projectdiscovery/nuclei/...`          | latest        |
| katana      | `github.com/projectdiscovery/katana/...`          | latest        |
| notify      | `github.com/projectdiscovery/notify/...`          | latest        |
| gowitness   | `github.com/sensepost/gowitness`                  | latest        |
| assetfinder | `github.com/tomnomnom/assetfinder`                | latest        |
| waybackurls | `github.com/tomnomnom/waybackurls`                | latest        |
| gf          | `github.com/tomnomnom/gf` + sample patterns       | latest        |
| subjs       | `github.com/lc/subjs`                             | latest        |
| ffuf        | `github.com/ffuf/ffuf/v2`                         | latest        |
| jq, curl    | apt                                               | distro        |

Image base: `node:20-bookworm-slim` + Go 1.23.4 (installed to `/usr/local/go`).

---

## 10. Troubleshooting

### `bad interpreter: No such file or directory` on Linux

Caused by Windows-style BOM/CRLF on the `.sh` files. Run:

```bash
./setup_linux.sh
```

This strips the UTF-8 BOM and CRLF endings from every `*.sh` and marks them
executable. `.gitattributes` plus `.vscode/settings.json` prevent the issue
from recurring.

### `no space left on device` during build / scan

1. Run a deeper scan with `RETENTION_KEEP=3` or smaller.
2. `docker builder prune -af && docker image prune -af`.
3. Check `du -sh results/* | sort -h` and remove old target folders.

### Build fails at `go install …notify@v1.0.10` 404

Already fixed: `notify` is installed via `go install
github.com/projectdiscovery/notify/cmd/notify@latest` and the entire build
layer is wrapped in `|| warn` so missing optional tools never abort the image
build. See [backend/Dockerfile](backend/Dockerfile).

### Tools not found at runtime

`modules/self_healing.sh` + `modules/install_tools.sh` re-install missing
binaries on the first scan. If you still see "Missing required tool: X",
manually run:

```bash
GOPATH=$HOME/go go install github.com/projectdiscovery/X/cmd/X@latest
export PATH="$HOME/go/bin:$PATH"
```

### Scan output is still too large

Tighten the caps:

```bash
MAX_WAYBACK_URLS=10000 \
MAX_ENDPOINTS=10000 \
MAX_ALL_URLS=20000 \
KEEP_RAW_VULNS=0 \
KEEP_RAW_WAYBACK=0 \
RETENTION_KEEP=3 \
./main.sh -d example.com -p standard
```

A `quick` profile run with these settings produces ~1–5 MB per scan.

---

## 11. Layout

```
├── main.sh                 # pipeline orchestrator (sources modules, filters by profile, uploads)
├── setup_linux.sh          # one-shot BOM/CRLF stripper + chmod
├── docker-compose.yml      # backend + frontend services
├── backend/
│   ├── Dockerfile          # node:20 + Go 1.23.4 + all PD/community tools
│   ├── server.js           # Express + WebSocket + node-cron scheduler
│   ├── report_generator.js # AI report writer (Gemini)
│   ├── settings.json       # runtime config (managed via dashboard)
│   ├── targets.json        # configured targets (read-only mounted into container)
│   ├── database/           # ingested scan_results.json files (one per scan)
│   └── reports/            # generated markdown reports for high/critical findings
├── frontend/               # Vite + React + Tailwind dashboard
├── modules/                # 21 bash modules (see §2)
├── config/
│   └── tech_to_tags.json   # tech_detector → nuclei tag mapping
└── results/                # per-scan output (auto-pruned by cleanup.sh)
```

---

## 12. Locked invariants — do not break

1. **`scan_results.json` top-level shape**: `{ "<target>": { generated_at, subdomains, live_services, vulnerability_objects } }`.
2. **`vulnerability_objects[*]` fields consumed by `report_generator.js`**:
   `template-id`, `info.severity`, `info.name`, `matched-at` (or fallbacks).
   `cleanup.sh` keeps every one of these.
3. **`main.sh` strict mode**: `set -eo pipefail`, never `-u` (optional env vars).
4. **All module functions are best-effort**: they may return non-zero on partial
   failure; `run_module_function` absorbs the return code so one tool crash
   never kills the whole pipeline.
5. **No module ever calls `exit`** — only `main.sh` exits.

---

## License

Internal / private framework. Tool dependencies retain their own licenses.
