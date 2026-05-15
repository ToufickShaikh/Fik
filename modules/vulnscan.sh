#!/usr/bin/env bash
# Vulnerability scanning with nuclei.
# Stealth: rate-limited, bulk-size capped, retries enabled. Tool failures
# are absorbed by run_tool so the pipeline still produces an export.

run_vulnerability_scan() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v nuclei >/dev/null 2>&1; then
    log_error "Missing required tool: nuclei"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local vulnerabilities_file="${OUTPUT_DIR}/vulnerabilities.txt"
  local vulnerabilities_jsonl_file="${OUTPUT_DIR}/vulnerabilities.jsonl"
  local nuclei_rate_limit="${NUCLEI_RATE_LIMIT:-20}"
  local nuclei_bulk_size="${NUCLEI_BULK_SIZE:-10}"
  local nuclei_retries="${NUCLEI_RETRIES:-2}"
  # Profile-aware defaults (NUCLEI_TAGS / NUCLEI_CONCURRENCY env vars take precedence).
  local _profile_tags
  case "${SCAN_PROFILE:-standard}" in
    quick) _profile_tags="cve,medium,low" ;;
    deep)  _profile_tags="cve,exposure,misconfig,takeover,network" ;;
    *)     _profile_tags="cve,exposure" ;;
  esac
  local nuclei_concurrency
  case "${SCAN_PROFILE:-standard}" in
    quick) nuclei_concurrency="${NUCLEI_CONCURRENCY:-5}"  ;;
    deep)  nuclei_concurrency="${NUCLEI_CONCURRENCY:-25}" ;;
    *)     nuclei_concurrency="${NUCLEI_CONCURRENCY:-10}" ;;
  esac
  # NUCLEI_TAGS (set by detect_technologies) overrides the profile default.
  local effective_tags="${NUCLEI_TAGS:-${_profile_tags}}"

  log_step "Vulnerability scan (nuclei)"
  log_info "Input file : ${live_hosts_file}"
  log_info "Rate-limit : ${nuclei_rate_limit} req/s, bulk ${nuclei_bulk_size}, retries ${nuclei_retries}"
  log_info "Tags       : ${effective_tags}"

  if [[ ! -s "${live_hosts_file}" ]]; then
    log_warn "No live hosts available. Writing empty vulnerability output files."
    : > "${vulnerabilities_file}"
    : > "${vulnerabilities_jsonl_file}"
    return 0
  fi

  : > "${vulnerabilities_jsonl_file}"
  run_tool "nuclei" nuclei -silent -jsonl \
    -l "${live_hosts_file}" \
    -rate-limit "${nuclei_rate_limit}" \
    -bulk-size "${nuclei_bulk_size}" \
    -c "${nuclei_concurrency}" \
    -retries "${nuclei_retries}" \
    -tags "${effective_tags}" \
    -o "${vulnerabilities_jsonl_file}" || true

  if command -v jq >/dev/null 2>&1 && [[ -s "${vulnerabilities_jsonl_file}" ]]; then
    jq -r '[(.matched_at // .["matched-at"] // .host // "unknown_host"), (.template_id // .template // .["template-id"] // "unknown_template")] | @tsv' "${vulnerabilities_jsonl_file}" 2>/dev/null > "${vulnerabilities_file}" || cp "${vulnerabilities_jsonl_file}" "${vulnerabilities_file}"
  else
    cp "${vulnerabilities_jsonl_file}" "${vulnerabilities_file}" 2>/dev/null || : > "${vulnerabilities_file}"
  fi

  log_success "Findings recorded: $(wc -l < "${vulnerabilities_file}" | tr -d ' ')"
}
