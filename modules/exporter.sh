#!/usr/bin/env bash
set -euo pipefail

export_to_json() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  if [[ -z "${TARGET_DOMAIN:-}" ]]; then
    echo "[ERROR] TARGET_DOMAIN is not set."
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: jq"
    return 1
  fi

  local subdomains_file="${OUTPUT_DIR}/subdomains.txt"
  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local active_ports_file="${OUTPUT_DIR}/active_ports.txt"
  local nuclei_jsonl_file="${NUCLEI_JSONL_FILE:-${OUTPUT_DIR}/vulnerabilities.jsonl}"
  local combined_live_services_file="${OUTPUT_DIR}/live_services.txt"
  local output_json_file="${OUTPUT_DIR}/scan_results.json"

  echo "======================================================================"
  echo "[EXPORT] Starting JSON export module"
  echo "[EXPORT] Target domain: ${TARGET_DOMAIN}"
  echo "[EXPORT] Nuclei JSONL source: ${nuclei_jsonl_file}"
  echo "======================================================================"

  if [[ ! -f "${subdomains_file}" ]]; then
    : > "${subdomains_file}"
  fi

  if [[ ! -f "${live_hosts_file}" ]]; then
    : > "${live_hosts_file}"
  fi

  if [[ ! -f "${active_ports_file}" ]]; then
    : > "${active_ports_file}"
  fi

  if [[ ! -f "${nuclei_jsonl_file}" ]]; then
    echo "[WARN] Nuclei JSONL file not found. Proceeding with empty vulnerability array."
    : > "${nuclei_jsonl_file}"
  fi

  echo "======================================================================"
  echo "[EXPORT] Building merged live services list"
  echo "======================================================================"
  cat "${live_hosts_file}" "${active_ports_file}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${combined_live_services_file}"

  local subdomains_json
  local live_services_json
  local vulnerabilities_json

  subdomains_json="$(jq -Rn '[inputs | select(length > 0)]' < "${subdomains_file}")"
  live_services_json="$(jq -Rn '[inputs | select(length > 0)]' < "${combined_live_services_file}")"

  if [[ -s "${nuclei_jsonl_file}" ]]; then
    vulnerabilities_json="$(jq -cs '.' "${nuclei_jsonl_file}")"
  else
    vulnerabilities_json='[]'
  fi

  echo "======================================================================"
  echo "[EXPORT] Writing consolidated scan_results.json"
  echo "======================================================================"
  jq -n \
    --arg target_domain "${TARGET_DOMAIN}" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson subdomains "${subdomains_json}" \
    --argjson live_services "${live_services_json}" \
    --argjson vulnerability_objects "${vulnerabilities_json}" \
    '{
      ($target_domain): {
        generated_at: $generated_at,
        subdomains: $subdomains,
        live_services: $live_services,
        vulnerability_objects: $vulnerability_objects
      }
    }' > "${output_json_file}"

  echo "[EXPORT] JSON export saved to ${output_json_file}"
  echo "[EXPORT] NoSQL-ready payload generated for domain ${TARGET_DOMAIN}"
}

upload_results() {
  local json_file_path="${1:-}"
  local target_url="${2:-http://localhost:3000/api/ingest}"

  if [[ -z "${json_file_path}" ]]; then
    echo "[ERROR] upload_results requires a JSON file path as the first argument."
    return 1
  fi

  if [[ ! -f "${json_file_path}" ]]; then
    echo "[ERROR] JSON file not found: ${json_file_path}"
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: curl"
    return 1
  fi

  echo "======================================================================"
  echo "[UPLOAD] Uploading scan results"
  echo "[UPLOAD] File: ${json_file_path}"
  echo "[UPLOAD] URL : ${target_url}"
  echo "======================================================================"

  local http_code
  if ! http_code="$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data-binary "@${json_file_path}" "${target_url}")"; then
    echo "[UPLOAD][FAIL] Request failed before receiving a valid HTTP response."
    return 1
  fi

  if [[ "${http_code}" =~ ^2[0-9][0-9]$ ]]; then
    echo "[UPLOAD][SUCCESS] Results uploaded successfully (HTTP ${http_code})."
    return 0
  fi

  echo "[UPLOAD][FAIL] Upload failed with HTTP ${http_code}."
  return 1
}
