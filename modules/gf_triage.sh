#!/usr/bin/env bash
# gf_triage.sh — Pattern-based URL triage.
# Uses Tomnomnom's `gf` over the unified URL corpus (all_urls.txt) to bucket
# candidates by vulnerability class: xss, sqli, ssrf, redirect, lfi, rce,
# idor, debug_logic, interestingparams.
# Output: one .txt per pattern + a summary in gf_summary.txt.

run_gf_triage() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }
  if ! command -v gf >/dev/null 2>&1; then
    log_warn "gf not installed; skipping pattern triage."
    return 0
  fi

  local corpus="${OUTPUT_DIR}/all_urls.txt"
  if [[ ! -s "${corpus}" ]]; then
    corpus="${OUTPUT_DIR}/endpoints.txt"
  fi
  if [[ ! -s "${corpus}" ]]; then
    log_warn "No URL corpus to triage; skipping gf."
    return 0
  fi

  local gf_dir="${OUTPUT_DIR}/gf"
  mkdir -p "${gf_dir}"

  local summary="${OUTPUT_DIR}/gf_summary.txt"
  : > "${summary}"

  log_step "gf pattern triage (corpus: $(wc -l < "${corpus}" | tr -d ' ') URLs)"

  local patterns=( xss sqli ssrf redirect lfi rce idor debug_logic interestingparams ssti img-traversal )
  local p out cnt
  for p in "${patterns[@]}"; do
    out="${gf_dir}/${p}.txt"
    : > "${out}"
    gf "${p}" < "${corpus}" 2>/dev/null | sort -u > "${out}" || true
    cnt="$(wc -l < "${out}" | tr -d ' ')"
    printf "%-22s %s\n" "${p}" "${cnt}" >> "${summary}"
    (( cnt > 0 )) && log_info "  gf:${p} → ${cnt} candidates"
  done

  log_success "gf triage complete. Summary: ${summary}"
}
