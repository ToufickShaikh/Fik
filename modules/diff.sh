#!/usr/bin/env bash
# diff.sh — Continuous-monitoring diff.
# Compares the *current* scan_results.json with the previous scan for the
# same target_domain and writes:
#   diff_new_subdomains.txt
#   diff_new_services.txt
#   diff_new_vulnerabilities.jsonl
#
# This is what makes Fik useful for scheduled re-scans: only NEW findings
# surface to the notify module.

run_diff_against_previous() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "jq missing; cannot produce diff."
    return 0
  fi

  local current="${OUTPUT_DIR}/scan_results.json"
  if [[ ! -f "${current}" ]]; then
    log_warn "scan_results.json not yet written; diff skipped (run after exporter)."
    return 0
  fi

  local results_root
  results_root="$(dirname "${OUTPUT_DIR}")"
  local safe_domain
  safe_domain="$(basename "${OUTPUT_DIR}" | sed -E 's/_[0-9]{8}_[0-9]{6}$//')"

  # Find the previous scan dir for the same target (lexically prior).
  local prev_dir
  prev_dir="$(find "${results_root}" -maxdepth 1 -type d -name "${safe_domain}_*" \
    | sort | grep -v "$(basename "${OUTPUT_DIR}")$" | tail -1 || true)"

  if [[ -z "${prev_dir}" || ! -f "${prev_dir}/scan_results.json" ]]; then
    log_info "No previous scan found for ${safe_domain}; baseline established."
    return 0
  fi

  log_step "Diff vs previous scan: ${prev_dir}"

  local prev="${prev_dir}/scan_results.json"
  local new_subs="${OUTPUT_DIR}/diff_new_subdomains.txt"
  local new_svcs="${OUTPUT_DIR}/diff_new_services.txt"
  local new_vulns="${OUTPUT_DIR}/diff_new_vulnerabilities.jsonl"

  jq -r --slurpfile prev "${prev}" '
    . as $cur
    | ($cur | to_entries[0].value) as $c
    | ($prev[0] | to_entries[0].value) as $p
    | ($c.subdomains // []) - ($p.subdomains // [])
    | .[]
  ' "${current}" 2>/dev/null > "${new_subs}" || : > "${new_subs}"

  jq -r --slurpfile prev "${prev}" '
    . as $cur
    | ($cur | to_entries[0].value) as $c
    | ($prev[0] | to_entries[0].value) as $p
    | ($c.live_services // []) - ($p.live_services // [])
    | .[]
  ' "${current}" 2>/dev/null > "${new_svcs}" || : > "${new_svcs}"

  # Vuln diff keyed by (template_id, matched_at).
  jq -c --slurpfile prev "${prev}" '
    . as $cur
    | ($cur | to_entries[0].value.vulnerability_objects // []) as $c
    | ($prev[0] | to_entries[0].value.vulnerability_objects // []) as $p
    | ($p | map((."template-id" // .template_id // "") + "|" + (."matched-at" // .matched_at // ""))) as $pk
    | $c[]
    | select((((."template-id" // .template_id // "") + "|" + (."matched-at" // .matched_at // "")) as $k | ($pk | index($k)) | not))
  ' "${current}" 2>/dev/null > "${new_vulns}" || : > "${new_vulns}"

  log_success "Diff: +$(wc -l < "${new_subs}" | tr -d ' ') subs, +$(wc -l < "${new_svcs}" | tr -d ' ') svcs, +$(wc -l < "${new_vulns}" | tr -d ' ') vulns"
}
