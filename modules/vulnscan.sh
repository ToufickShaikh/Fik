#!/usr/bin/env bash
set -euo pipefail

run_vulnerability_scan() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v nuclei >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: nuclei"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local vulnerabilities_file="${OUTPUT_DIR}/vulnerabilities.txt"
  local vulnerabilities_jsonl_file="${OUTPUT_DIR}/vulnerabilities.jsonl"
  local nuclei_rate_limit="${NUCLEI_RATE_LIMIT:-20}"

  echo "=============================================================="
  echo "[VULNSCAN] Starting nuclei scan"
  echo "[VULNSCAN] Input file: ${live_hosts_file}"
  echo "[VULNSCAN] Rate limit: ${nuclei_rate_limit} req/sec"
  echo "=============================================================="

  if [[ ! -s "${live_hosts_file}" ]]; then
    echo "[WARN] No live hosts available. Writing empty vulnerabilities.txt"
    : > "${vulnerabilities_file}"
    : > "${vulnerabilities_jsonl_file}"
    return 0
  fi

  nuclei -silent -jsonl -l "${live_hosts_file}" -rate-limit "${nuclei_rate_limit}" -o "${vulnerabilities_jsonl_file}"

  if command -v jq >/dev/null 2>&1 && [[ -s "${vulnerabilities_jsonl_file}" ]]; then
    jq -r '[(.matched_at // .["matched-at"] // .host // "unknown_host"), (.template_id // .template // .["template-id"] // "unknown_template")] | @tsv' "${vulnerabilities_jsonl_file}" > "${vulnerabilities_file}"
  else
    cp "${vulnerabilities_jsonl_file}" "${vulnerabilities_file}"
  fi

  echo "[VULNSCAN] Vulnerability results saved to ${vulnerabilities_file}"
  echo "[VULNSCAN] JSONL results saved to ${vulnerabilities_jsonl_file}"
  echo "[VULNSCAN] Findings count: $(wc -l < "${vulnerabilities_file}" | tr -d ' ')"
}
