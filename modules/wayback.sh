#!/usr/bin/env bash
# wayback.sh — Historical URL recon via the Wayback Machine + nuclei replay.
#
# Goal: surface endpoints (and old vulnerabilities) that no longer exist on
# the live site but are still indexed by archive.org. Many bug-bounty wins
# come from forgotten admin panels, leaked .env URLs, and deprecated API
# routes that the live crawler will never see.
#
# Pipeline:
#   1. Pull all archived URLs from web.archive.org for the target + subdomains.
#   2. Deduplicate + filter to "interesting" extensions/keywords.
#   3. Probe which of the archived URLs are STILL alive on the live target
#      (httpx -mc 200,401,403).
#   4. Run nuclei (exposures + misconfigs + cves templates) against survivors.
#
# Output files (under ${OUTPUT_DIR}):
#   wayback_urls_raw.txt     — every URL ever archived
#   wayback_urls_filtered.txt— juicy subset (configs, backups, tokens, ...)
#   wayback_urls_live.txt    — subset still reachable today
#   wayback_findings.jsonl   — nuclei JSONL appended to vulnerabilities.jsonl

run_wayback_recon() {
  if [[ -z "${TARGET_DOMAIN:-}" ]]; then
    log_error "TARGET_DOMAIN is not set."
    return 1
  fi
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  local raw="${OUTPUT_DIR}/wayback_urls_raw.txt"
  local filtered="${OUTPUT_DIR}/wayback_urls_filtered.txt"
  local live="${OUTPUT_DIR}/wayback_urls_live.txt"
  local findings="${OUTPUT_DIR}/wayback_findings.jsonl"
  local nuclei_jsonl="${OUTPUT_DIR}/vulnerabilities.jsonl"
  local subdomains_file="${OUTPUT_DIR}/subdomains.txt"

  : > "${raw}"
  : > "${filtered}"
  : > "${live}"
  : > "${findings}"

  log_step "Wayback Machine recon for ${TARGET_DOMAIN}"

  # ---------------------------------------------------------------------------
  # 1. Collect archived URLs.
  #    Prefer `waybackurls` (Tomnomnom) if installed; otherwise fall back to
  #    the public CDX API via curl so the module is never a hard dependency.
  # ---------------------------------------------------------------------------
  local domains_to_query=( "${TARGET_DOMAIN}" )
  if [[ -s "${subdomains_file}" ]]; then
    # Limit to first 50 subdomains to keep wayback queries bounded.
    while IFS= read -r d; do
      [[ -n "${d}" ]] && domains_to_query+=( "${d}" )
    done < <(head -n 50 "${subdomains_file}")
  fi

  if command -v waybackurls >/dev/null 2>&1; then
    log_info "Using waybackurls binary"
    printf '%s\n' "${domains_to_query[@]}" | sort -u | run_tool "waybackurls" \
      bash -c "waybackurls >> '${raw}'" || true
  fi

  # gau is a stronger archive aggregator (wayback + OTX + commoncrawl + URLscan)
  # and usually returns 5-50× more URLs than waybackurls alone. Run it as an
  # additional source whenever it is installed so cdn-protected / rate-limited
  # wayback queries don't silently zero the corpus.
  if command -v gau >/dev/null 2>&1; then
    log_info "Augmenting with gau (wayback + OTX + commoncrawl + URLscan)"
    local d
    for d in "${domains_to_query[@]}"; do
      run_tool "gau:${d}" bash -c \
        "echo '${d}' | gau --threads 5 --timeout 30 --subs --providers wayback,otx,commoncrawl,urlscan >> '${raw}' 2>/dev/null" \
        || true
    done
  fi

  # CDX API fallback when neither tool is present OR when the corpus is still
  # suspiciously small (< 25 URLs after the above runs).
  local _raw_n; _raw_n="$(wc -l < "${raw}" 2>/dev/null | tr -d ' ' || echo 0)"
  if (( _raw_n < 25 )); then
    log_warn "Wayback corpus is small (${_raw_n}); falling back to CDX API via curl"
    local d
    for d in "${domains_to_query[@]}"; do
      run_tool "cdx:${d}" bash -c \
        "curl -fsSL --max-time 30 'https://web.archive.org/cdx/search/cdx?url=${d}/*&output=text&fl=original&collapse=urlkey' >> '${raw}'" \
        || true
    done
  fi

  sort -u -o "${raw}" "${raw}"
  # Apply scope filter if loaded (out-of-scope hosts dropped).
  if declare -F scope_filter >/dev/null 2>&1; then
    scope_filter < "${raw}" > "${raw}.scoped" && mv "${raw}.scoped" "${raw}"
  fi
  # Hard cap to keep disk usage bounded — wayback can return millions of URLs
  # per popular domain. The filtered/live subsets that downstream tools rely
  # on are derived from this capped set. Override via MAX_WAYBACK_URLS.
  local _cap="${MAX_WAYBACK_URLS:-50000}"
  if [[ "${_cap}" =~ ^[0-9]+$ ]] && (( _cap > 0 )); then
    local _total; _total="$(wc -l < "${raw}" | tr -d ' ')"
    if (( _total > _cap )); then
      log_warn "Capping wayback URLs: ${_total} -> ${_cap} (set MAX_WAYBACK_URLS to override)"
      head -n "${_cap}" "${raw}" > "${raw}.cap" && mv "${raw}.cap" "${raw}"
    fi
  fi
  log_info "Raw archived URLs: $(wc -l < "${raw}" | tr -d ' ')"  

  if [[ ! -s "${raw}" ]]; then
    log_warn "No archived URLs returned. Wayback module exiting cleanly."
    return 0
  fi

  # ---------------------------------------------------------------------------
  # 2. Filter to interesting endpoints.
  #    Extensions + keywords commonly tied to leaks, debug pages, backups,
  #    and admin surfaces. Case-insensitive.
  # ---------------------------------------------------------------------------
  log_info "Filtering to high-signal URLs (configs, backups, secrets, admin, api)"
  grep -Ei \
    '\.(env|bak|old|backup|swp|sql|db|log|zip|tar|tgz|gz|7z|rar|conf|config|ini|yml|yaml|json|xml|key|pem|pfx|p12|crt|cer|git|svn|ds_store)(\?|$)|/(admin|debug|console|actuator|phpinfo|server-status|wp-admin|wp-config|graphql|swagger|api-docs|\.git|\.svn|\.env|backup|test|staging|internal)(/|\?|$)' \
    "${raw}" 2>/dev/null | sort -u > "${filtered}" || true

  log_info "Filtered URLs: $(wc -l < "${filtered}" | tr -d ' ')"

  if [[ ! -s "${filtered}" ]]; then
    log_warn "No high-signal URLs after filtering. Skipping liveness + nuclei."
    return 0
  fi

  # ---------------------------------------------------------------------------
  # 3. Liveness probe — which archived URLs still resolve today?
  # ---------------------------------------------------------------------------
  if command -v httpx >/dev/null 2>&1; then
    local rl threads
    case "${SCAN_PROFILE:-standard}" in
      quick) rl="${HTTPX_RATE_LIMIT:-30}";  threads="${HTTPX_THREADS:-10}" ;;
      deep)  rl="${HTTPX_RATE_LIMIT:-100}"; threads="${HTTPX_THREADS:-50}" ;;
      *)     rl="${HTTPX_RATE_LIMIT:-50}";  threads="${HTTPX_THREADS:-25}" ;;
    esac
    log_info "Probing archived URLs with httpx (mc 200,401,403)"
    run_tool "httpx-wayback" bash -c \
      "httpx -silent -mc 200,401,403 -threads ${threads} -rl ${rl} -l '${filtered}' > '${live}'" \
      || true
  else
    log_warn "httpx not available; treating filtered URLs as live."
    cp -f "${filtered}" "${live}"
  fi

  log_info "Live archived URLs: $(wc -l < "${live}" | tr -d ' ')"

  if [[ ! -s "${live}" ]]; then
    log_warn "No live archived URLs to scan. Wayback module done."
    return 0
  fi

  # ---------------------------------------------------------------------------
  # 4. Nuclei replay — focus on exposures + misconfigurations + CVEs.
  #    Output is appended (>>) into vulnerabilities.jsonl so the exporter
  #    picks them up alongside the live-site findings without code changes.
  # ---------------------------------------------------------------------------
  if command -v nuclei >/dev/null 2>&1; then
    log_step "Running nuclei against archived-but-live URLs"
    local nuclei_rl nuclei_c
    case "${SCAN_PROFILE:-standard}" in
      quick) nuclei_rl="${NUCLEI_RATE_LIMIT:-50}";  nuclei_c="${NUCLEI_CONCURRENCY:-10}" ;;
      deep)  nuclei_rl="${NUCLEI_RATE_LIMIT:-150}"; nuclei_c="${NUCLEI_CONCURRENCY:-50}" ;;
      *)     nuclei_rl="${NUCLEI_RATE_LIMIT:-100}"; nuclei_c="${NUCLEI_CONCURRENCY:-25}" ;;
    esac

    run_tool "nuclei-wayback" bash -c \
      "nuclei -silent -l '${live}' \
              -tags exposure,misconfig,cve,backup,config \
              -severity high,critical \
              -rl ${nuclei_rl} -c ${nuclei_c} \
              -jsonl -o '${findings}'" \
      || true

    if [[ -s "${findings}" ]]; then
      cat "${findings}" >> "${nuclei_jsonl}"
      log_success "Appended $(wc -l < "${findings}" | tr -d ' ') wayback findings to ${nuclei_jsonl}"
    else
      log_info "No nuclei findings from wayback URLs."
    fi
  else
    log_warn "nuclei not available; archived URLs saved but not scanned."
  fi
}
