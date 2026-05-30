#!/usr/bin/env bash
# Result exporter + backend uploader.
# JSON shape is locked: { "<target>": { generated_at, subdomains, live_services, vulnerability_objects } }
# Do not change keys without updating backend/server.js and frontend/src/App.jsx.

export_to_json() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  if [[ -z "${TARGET_DOMAIN:-}" ]]; then
    log_error "TARGET_DOMAIN is not set."
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    log_error "Missing required tool: jq"
    return 1
  fi

  local subdomains_file="${OUTPUT_DIR}/subdomains.txt"
  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local active_ports_file="${OUTPUT_DIR}/active_ports.txt"
  local nuclei_jsonl_file="${NUCLEI_JSONL_FILE:-${OUTPUT_DIR}/vulnerabilities.jsonl}"
  local combined_live_services_file="${OUTPUT_DIR}/live_services.txt"
  local output_json_file="${OUTPUT_DIR}/scan_results.json"

  log_step "JSON export"
  log_info "Target domain      : ${TARGET_DOMAIN}"
  log_info "Nuclei JSONL source: ${nuclei_jsonl_file}"

  [[ -f "${subdomains_file}"   ]] || : > "${subdomains_file}"
  [[ -f "${live_hosts_file}"   ]] || : > "${live_hosts_file}"
  [[ -f "${active_ports_file}" ]] || : > "${active_ports_file}"

  if [[ ! -f "${nuclei_jsonl_file}" ]]; then
    log_warn "Nuclei JSONL file not found. Proceeding with empty vulnerability array."
    : > "${nuclei_jsonl_file}"
  fi

  log_info "Building merged live services list"
  cat "${live_hosts_file}" "${active_ports_file}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${combined_live_services_file}"

  local subdomains_json live_services_json
  subdomains_json="$(jq -Rn '[inputs | select(length > 0)]' < "${subdomains_file}")"
  live_services_json="$(jq -Rn '[inputs | select(length > 0)]' < "${combined_live_services_file}")"

  local max_scan_results_vulns="${MAX_SCAN_RESULTS_VULNS:-20000}"
  local total_vulns=0
  if [[ -s "${nuclei_jsonl_file}" ]]; then
    total_vulns="$(grep -cve '^[[:space:]]*$' "${nuclei_jsonl_file}" 2>/dev/null || echo 0)"
    if [[ "${max_scan_results_vulns}" =~ ^[0-9]+$ ]] && (( max_scan_results_vulns > 0 )) && (( total_vulns > max_scan_results_vulns )); then
      log_warn "Trimming scan_results.json to first ${max_scan_results_vulns}/${total_vulns} vulnerability objects. Full raw file retained at ${nuclei_jsonl_file}."
    fi
  fi

  log_info "Writing consolidated scan_results.json"
  if [[ -s "${nuclei_jsonl_file}" ]]; then
    {
      printf '{\n  "%s": {\n' "${TARGET_DOMAIN}"
      printf '    "generated_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '    "subdomains": %s,\n' "${subdomains_json}"
      printf '    "live_services": %s,\n' "${live_services_json}"
      printf '    "vulnerability_objects": [\n'

      local vuln_count=0
      while IFS= read -r line; do
        [[ -z "${line}" ]] && continue
        if (( vuln_count > 0 )); then
          printf ',\n'
        fi
        printf '%s' "${line}"
        vuln_count=$((vuln_count + 1))
        if [[ "${max_scan_results_vulns}" =~ ^[0-9]+$ ]] && (( max_scan_results_vulns > 0 )) && (( vuln_count >= max_scan_results_vulns )); then
          break
        fi
      done < "${nuclei_jsonl_file}"

      printf '\n    ]\n  }\n}\n'
    } > "${output_json_file}"
  else
    jq -n \
      --arg target_domain "${TARGET_DOMAIN}" \
      --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson subdomains "${subdomains_json}" \
      --argjson live_services "${live_services_json}" \
      --argjson vulnerability_objects '[]' \
      '{
        ($target_domain): {
          generated_at: $generated_at,
          subdomains: $subdomains,
          live_services: $live_services,
          vulnerability_objects: $vulnerability_objects
        }
      }' > "${output_json_file}"
  fi

  log_success "JSON export saved to ${output_json_file}"
}

upload_results() {
  local json_file_path="${1:-}"
  local target_url="${2:-http://localhost:3000/api/ingest}"

  if [[ -z "${json_file_path}" ]]; then
    log_error "upload_results requires a JSON file path as the first argument."
    return 1
  fi

  if [[ ! -f "${json_file_path}" ]]; then
    log_error "JSON file not found: ${json_file_path}"
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    log_error "Missing required tool: curl"
    return 1
  fi

  log_step "Uploading scan results"
  log_info "File: ${json_file_path}"
  log_info "URL : ${target_url}"

  local http_code
  if ! http_code="$(curl -sS -o /dev/null -w "%{http_code}" \
        --connect-timeout 10 --max-time 60 \
        -X POST -H "Content-Type: application/json" \
        --data-binary "@${json_file_path}" "${target_url}")"; then
    log_warn "Request failed before receiving a valid HTTP response."
    return 1
  fi

  if [[ "${http_code}" =~ ^2[0-9][0-9]$ ]]; then
    log_success "Results uploaded successfully (HTTP ${http_code})."
    return 0
  fi

  log_warn "Upload failed with HTTP ${http_code}."
  return 1
}
