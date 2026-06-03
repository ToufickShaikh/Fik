#!/usr/bin/env bash
# sqli.sh — Automated SQL injection sweep with sqlmap.
#
# Input : every parameterised URL collected during the scan
#         (katana endpoints + gau/waybackurls history + paramspider output).
# Filter: only URLs with at least one query parameter.
# Tool  : sqlmap in --batch --smart mode, with a sane time-cap per URL.
#
# Authorisation: gated behind `deep` profile AND SQLI_OK=1.

[[ -n "${_FIK_SQLI_SOURCED:-}" ]] && return 0
_FIK_SQLI_SOURCED=1

run_sqli_scan() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }

  if [[ "${SCAN_PROFILE:-standard}" != "deep" ]]; then
    log_info "sqli scan only runs in 'deep' profile; skipping."
    return 0
  fi
  if [[ "${SQLI_OK:-0}" != "1" ]]; then
    log_warn "SQLI_OK is not set to 1 — refusing to run sqlmap (active injection probes)."
    log_warn "Set SQLI_OK=1 (only against targets you are authorised to test) to enable."
    return 0
  fi
  if ! command -v sqlmap >/dev/null 2>&1; then
    log_warn "sqlmap not installed; skipping SQLi scan."
    log_warn "Install via: apt-get install -y sqlmap   (or: pip install sqlmap)"
    return 0
  fi

  local out_dir="${OUTPUT_DIR}/sqli"
  mkdir -p "${out_dir}"

  local candidates="${out_dir}/sqli_candidates.txt"
  _build_sqli_candidates > "${candidates}"
  local n; n="$(wc -l < "${candidates}" | tr -d ' ')"

  log_step "SQLi scan with sqlmap (${n} parameterised URLs)"
  if (( n == 0 )); then
    log_warn "No parameterised URLs to test; SQLi scan done."
    return 0
  fi

  local cap="${SQLI_MAX_URLS:-200}"
  if (( n > cap )); then
    log_warn "Capping SQLi targets to ${cap} of ${n} (override SQLI_MAX_URLS)"
    head -n "${cap}" "${candidates}" > "${candidates}.cap" && mv "${candidates}.cap" "${candidates}"
    n=${cap}
  fi

  local per_url_timeout="${SQLI_PER_URL_TIMEOUT:-120}"
  local risk="${SQLI_RISK:-2}"
  local level="${SQLI_LEVEL:-2}"
  local threads="${SQLI_THREADS:-2}"

  local findings="${out_dir}/sqli_findings.txt"
  : > "${findings}"
  local nuclei_jsonl="${OUTPUT_DIR}/vulnerabilities.jsonl"

  local url i=0
  while IFS= read -r url; do
    [[ -z "${url}" ]] && continue
    i=$((i + 1))
    local safe; safe="$(echo "${url}" | md5sum | awk '{print $1}')"
    local target_dir="${out_dir}/${safe}"
    mkdir -p "${target_dir}"

    log_info "[${i}/${n}] sqlmap ${url}"
    run_tool "sqlmap:${safe:0:8}" timeout "${per_url_timeout}" sqlmap \
      --batch --smart --random-agent --disable-coloring \
      --level "${level}" --risk "${risk}" --threads "${threads}" \
      --timeout 8 --retries 1 \
      -u "${url}" \
      --output-dir "${target_dir}" 2>&1 | tail -50 > "${target_dir}/sqlmap.log" || true

    if grep -qiE 'is vulnerable|might be injectable|the back-end DBMS is' "${target_dir}/sqlmap.log" 2>/dev/null; then
      printf '[VULN] %s\n' "${url}" >> "${findings}"
      grep -iE 'parameter:|type:|title:|payload:|back-end DBMS' "${target_dir}/sqlmap.log" 2>/dev/null \
        | sed 's/^/    /' >> "${findings}"
      printf '\n' >> "${findings}"

      # Synthesise a nuclei-shaped JSONL line so the finding shows up in the
      # main report aggregator without a custom path.
      printf '{"template-id":"sqlmap-positive","info":{"name":"SQL injection (sqlmap)","severity":"high","tags":["sqli","sqlmap"]},"host":"%s","matched-at":"%s","url":"%s"}\n' \
        "${url}" "${url}" "${url}" >> "${nuclei_jsonl}"
    fi
  done < "${candidates}"

  local hit_n; hit_n="$(grep -c '^\[VULN\]' "${findings}" 2>/dev/null || echo 0)"
  log_success "SQLi confirmed: ${hit_n} URL(s). Details in ${findings}"
}

# ---------------------------------------------------------------------------
# _build_sqli_candidates — emit URLs that have at least one ?param=value
# pair. Pulled from every URL corpus the framework already produced.
# ---------------------------------------------------------------------------
_build_sqli_candidates() {
  local sources=(
    "${OUTPUT_DIR}/endpoints.txt"
    "${OUTPUT_DIR}/wayback_urls_raw.txt"
    "${OUTPUT_DIR}/wayback_urls_live.txt"
    "${OUTPUT_DIR}/js_endpoints.txt"
    "${OUTPUT_DIR}/paramspider.txt"
  )
  local f
  {
    for f in "${sources[@]}"; do
      [[ -s "${f}" ]] && cat "${f}"
    done
  } | grep -E '\?[^=]+=' \
    | grep -vE '\.(png|jpg|jpeg|gif|webp|svg|css|js|woff2?|ttf|eot|ico|mp4|webm|pdf)(\?|$)' \
    | sort -u
}
