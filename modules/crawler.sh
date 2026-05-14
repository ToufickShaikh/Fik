#!/usr/bin/env bash
set -euo pipefail

run_crawler() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v katana >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: katana"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local endpoints_file="${OUTPUT_DIR}/endpoints.txt"
  local js_files_file="${OUTPUT_DIR}/js_files.txt"
  local potential_leaks_file="${OUTPUT_DIR}/potential_leaks.txt"

  echo "======================================================================"
  echo "[CRAWLER] Starting crawler module"
  echo "[CRAWLER] Input live hosts file: ${live_hosts_file}"
  echo "======================================================================"

  if [[ ! -s "${live_hosts_file}" ]]; then
    echo "[WARN] live_hosts.txt is missing or empty. Writing empty crawler outputs."
    : > "${endpoints_file}"
    : > "${js_files_file}"
    : > "${potential_leaks_file}"
    return 0
  fi

  echo "======================================================================"
  echo "[CRAWLER] Running katana with stealth & stability flags"
  echo "======================================================================"
  katana -list "${live_hosts_file}" \
    -headless \
    -no-sandbox \
    -delay 3 \
    -concurrency 2 \
    -crawl-duration 5m \
    -retry 3 \
    -f url \
    -o "${endpoints_file}" || true

  if [[ ! -f "${endpoints_file}" ]]; then
    : > "${endpoints_file}"
  fi

  echo "======================================================================"
  echo "[CRAWLER] Extracting JavaScript file URLs into js_files.txt"
  echo "======================================================================"
  grep -Eo "https?://[^[:space:]\"'<>]+\"?" "${endpoints_file}" \
    | awk '{ gsub(/"$/, "", $0); print $0 }' \
    | awk 'tolower($0) ~ /\.js([?#].*)?$/ { print $0 }' \
    | sort -u > "${js_files_file}"

  echo "======================================================================"
  echo "[CRAWLER] Searching endpoints output for potential API keys and tokens"
  echo "======================================================================"
  grep -Eio "(AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|sk_(live|test)_[0-9A-Za-z]{16,}|(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)[[:space:]\"':=]+[A-Za-z0-9._-]{8,})" "${endpoints_file}" \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | sort -u > "${potential_leaks_file}"

  echo "[CRAWLER] Raw endpoints saved to ${endpoints_file}"
  echo "[CRAWLER] JavaScript file URLs saved to ${js_files_file}"
  echo "[CRAWLER] Potential leaks saved to ${potential_leaks_file}"
  echo "[CRAWLER] JS URL count: $(wc -l < "${js_files_file}" | tr -d ' ')"
  echo "[CRAWLER] Potential leak count: $(wc -l < "${potential_leaks_file}" | tr -d ' ')"
}
