#!/usr/bin/env bash
set -euo pipefail

run_port_scan() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  for required_tool in naabu httpx; do
    if ! command -v "${required_tool}" >/dev/null 2>&1; then
      echo "[ERROR] Missing required tool: ${required_tool}"
      return 1
    fi
  done

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local CLEAN_HOSTS="${OUTPUT_DIR}/hosts_stripped.txt"
  local ports_file="${OUTPUT_DIR}/ports.txt"
  local non_standard_ports_file="${OUTPUT_DIR}/non_standard_ports.txt"
  local active_ports_file="${OUTPUT_DIR}/active_ports.txt"

  echo "======================================================================"
  echo "[PORTSCAN] Starting port scan module"
  echo "[PORTSCAN] Input live hosts file: ${live_hosts_file}"
  echo "======================================================================"

  if [[ ! -s "${live_hosts_file}" ]]; then
    echo "[WARN] live_hosts.txt is missing or empty. Writing empty output files."
    : > "${ports_file}"
    : > "${non_standard_ports_file}"
    : > "${active_ports_file}"
    return 0
  fi

  echo "======================================================================"
  echo "[PORTSCAN] Stripping URL schemes and trailing slashes for naabu input"
  echo "[PORTSCAN] Clean hosts file: ${CLEAN_HOSTS}"
  echo "======================================================================"
  sed -E 's#^[[:space:]]*https?://##; s#/.*$##; s#[[:space:]]+$##' "${live_hosts_file}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${CLEAN_HOSTS}"

  echo "======================================================================"
  echo "[PORTSCAN] Running naabu silently on top 1000 ports"
  echo "======================================================================"
  naabu -silent -top-ports 1000 -list "${CLEAN_HOSTS}" -o "${ports_file}"

  echo "======================================================================"
  echo "[PORTSCAN] Extracting host:port pairs and filtering non-standard ports"
  echo "======================================================================"
  awk -F: 'NF >= 2 { port=$NF; if (port != "80" && port != "443") print $0 }' "${ports_file}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${non_standard_ports_file}"

  if [[ ! -s "${non_standard_ports_file}" ]]; then
    echo "[WARN] No non-standard open ports found. Writing empty active_ports.txt"
    : > "${active_ports_file}"
    return 0
  fi

  echo "======================================================================"
  echo "[PORTSCAN] Verifying web services on discovered non-standard ports"
  echo "======================================================================"
  httpx -silent -threads 50 -l "${non_standard_ports_file}" -o "${active_ports_file}"

  echo "[PORTSCAN] Port scan output saved to ${ports_file}"
  echo "[PORTSCAN] Verified active web services saved to ${active_ports_file}"
  echo "[PORTSCAN] Active web service count: $(wc -l < "${active_ports_file}" | tr -d ' ')"
}
