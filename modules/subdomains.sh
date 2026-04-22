#!/usr/bin/env bash
set -euo pipefail

run_subdomain_enumeration() {
  if [[ -z "${TARGET_DOMAIN:-}" ]]; then
    echo "[ERROR] TARGET_DOMAIN is not set."
    return 1
  fi

  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  for required_tool in subfinder assetfinder httpx; do
    if ! command -v "${required_tool}" >/dev/null 2>&1; then
      echo "[ERROR] Missing required tool: ${required_tool}"
      return 1
    fi
  done

  local subfinder_raw="${OUTPUT_DIR}/subfinder.txt"
  local assetfinder_raw="${OUTPUT_DIR}/assetfinder.txt"
  local subdomains_file="${OUTPUT_DIR}/subdomains.txt"
  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"

  echo "=============================================================="
  echo "[SUBDOMAINS] Starting subdomain enumeration"
  echo "[SUBDOMAINS] Running subfinder on ${TARGET_DOMAIN}"
  echo "=============================================================="
  subfinder -silent -d "${TARGET_DOMAIN}" -o "${subfinder_raw}"

  echo "=============================================================="
  echo "[SUBDOMAINS] Running assetfinder on ${TARGET_DOMAIN}"
  echo "=============================================================="
  assetfinder --subs-only "${TARGET_DOMAIN}" > "${assetfinder_raw}"

  echo "=============================================================="
  echo "[SUBDOMAINS] Combining and deduplicating results"
  echo "=============================================================="
  cat "${subfinder_raw}" "${assetfinder_raw}" \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "${subdomains_file}"

  echo "[SUBDOMAINS] Saved consolidated subdomains to ${subdomains_file}"

  if [[ ! -s "${subdomains_file}" ]]; then
    echo "[WARN] No subdomains found. Writing empty live_hosts.txt"
    : > "${live_hosts_file}"
    return 0
  fi

  echo "=============================================================="
  echo "[LIVENESS] Probing live hosts with httpx (threads: 50)"
  echo "=============================================================="
  httpx -silent -threads 50 -l "${subdomains_file}" -o "${live_hosts_file}"

  echo "[LIVENESS] Saved live hosts to ${live_hosts_file}"
  echo "[LIVENESS] Live host count: $(wc -l < "${live_hosts_file}" | tr -d ' ')"
}
