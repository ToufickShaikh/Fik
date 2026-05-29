#!/usr/bin/env bash
# takeover.sh — Subdomain takeover detection (CNAME-dangling, NXDOMAIN
# fingerprinting). Uses `subzy` (preferred) and falls back to nuclei
# takeover templates. Findings are appended to vulnerabilities.jsonl.

run_subdomain_takeover() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }
  local subs="${OUTPUT_DIR}/subdomains.txt"
  if [[ ! -s "${subs}" ]]; then
    log_warn "subdomains.txt empty; skipping takeover."
    return 0
  fi

  local report="${OUTPUT_DIR}/takeover.txt"
  local jsonl="${OUTPUT_DIR}/takeover.jsonl"
  : > "${report}"; : > "${jsonl}"

  log_step "Subdomain takeover scan"

  if command -v subzy >/dev/null 2>&1; then
    run_tool "subzy" subzy run --targets "${subs}" --hide_fails --concurrency 20 \
      --output "${jsonl}" --output_format json || true
    if [[ -s "${jsonl}" ]] && command -v jq >/dev/null 2>&1; then
      jq -r '.[] | "[\(.status)] \(.subdomain) -> \(.service // "unknown")"' \
        "${jsonl}" 2>/dev/null > "${report}" || true
    fi
  else
    log_warn "subzy not available; using nuclei takeover templates as fallback."
  fi

  if command -v nuclei >/dev/null 2>&1; then
    local nuclei_out="${OUTPUT_DIR}/takeover_nuclei.jsonl"
    run_tool "nuclei-takeover" nuclei -silent -l "${subs}" \
      -tags takeover -severity high,critical \
      -jsonl -o "${nuclei_out}" || true
    if [[ -s "${nuclei_out}" ]]; then
      cat "${nuclei_out}" >> "${OUTPUT_DIR}/vulnerabilities.jsonl"
      log_success "Takeover findings appended: $(wc -l < "${nuclei_out}" | tr -d ' ')"
    fi
  fi

  log_success "Takeover module complete. Report: ${report}"
}
