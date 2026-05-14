#!/usr/bin/env bash
# Port scanning with naabu + httpx verification.
# Stealth: input sanitization (strip URL schemes/paths) before naabu, httpx
# rate-limited on the verification pass.

run_port_scan() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  for required_tool in naabu httpx; do
    if ! command -v "${required_tool}" >/dev/null 2>&1; then
      log_error "Missing required tool: ${required_tool}"
      return 1
    fi
  done

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local CLEAN_HOSTS="${OUTPUT_DIR}/hosts_stripped.txt"
  local ports_file="${OUTPUT_DIR}/ports.txt"
  local non_standard_ports_file="${OUTPUT_DIR}/non_standard_ports.txt"
  local active_ports_file="${OUTPUT_DIR}/active_ports.txt"
  local naabu_rate_limit="${NAABU_RATE_LIMIT:-150}"
  local httpx_rate_limit="${HTTPX_RATE_LIMIT:-50}"
  local httpx_threads="${HTTPX_THREADS:-25}"
  local httpx_retries="${HTTPX_RETRIES:-2}"

  log_step "Port scan"
  log_info "Input live hosts file: ${live_hosts_file}"

  if [[ ! -s "${live_hosts_file}" ]]; then
    log_warn "live_hosts.txt is missing or empty. Writing empty output files."
    : > "${ports_file}"
    : > "${non_standard_ports_file}"
    : > "${active_ports_file}"
    return 0
  fi

  log_info "Stripping URL schemes/paths for naabu input -> ${CLEAN_HOSTS}"
  sed -e 's|^[^/]*//||' -e 's|/.*$||' "${live_hosts_file}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${CLEAN_HOSTS}"

  : > "${ports_file}"
  run_tool "naabu" naabu -silent -list "${CLEAN_HOSTS}" -top-ports 1000 -rate "${naabu_rate_limit}" -o "${ports_file}" || true

  log_info "Extracting host:port pairs and filtering non-standard ports"
  awk -F: 'NF >= 2 { port=$NF; if (port != "80" && port != "443") print $0 }' "${ports_file}" 2>/dev/null \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${non_standard_ports_file}"

  if [[ ! -s "${non_standard_ports_file}" ]]; then
    log_warn "No non-standard open ports found. Writing empty active_ports.txt"
    : > "${active_ports_file}"
    return 0
  fi

  log_step "Verifying web services on non-standard ports (httpx rl=${httpx_rate_limit})"
  : > "${active_ports_file}"
  run_tool "httpx-verify" httpx -silent -threads "${httpx_threads}" -rl "${httpx_rate_limit}" -retries "${httpx_retries}" -l "${non_standard_ports_file}" -o "${active_ports_file}" || true

  log_success "Active web services: $(wc -l < "${active_ports_file}" | tr -d ' ')"
}
