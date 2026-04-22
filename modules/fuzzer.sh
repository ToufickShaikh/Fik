#!/usr/bin/env bash
set -euo pipefail

run_fuzzer() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    echo "[ERROR] OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v ffuf >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: ffuf"
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "[ERROR] Missing required tool: jq"
    return 1
  fi

  local wordlist="/usr/share/wordlists/dirb/common.txt"
  if [[ ! -f "${wordlist}" ]]; then
    echo "[ERROR] Wordlist not found at ${wordlist}"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local ffuf_output_dir="${OUTPUT_DIR}/ffuf_json"
  local discovered_directories_file="${OUTPUT_DIR}/discovered_directories.txt"

  mkdir -p "${ffuf_output_dir}"
  : > "${discovered_directories_file}"

  echo "======================================================================"
  echo "[FUZZER] Starting directory fuzzing module"
  echo "[FUZZER] Input file: ${live_hosts_file}"
  echo "[FUZZER] Wordlist: ${wordlist}"
  echo "======================================================================"

  if [[ ! -s "${live_hosts_file}" ]]; then
    echo "[WARN] live_hosts.txt is missing or empty. Writing empty discovered_directories.txt"
    return 0
  fi

  local host
  local host_index=0

  while IFS= read -r host || [[ -n "${host}" ]]; do
    host="$(echo "${host}" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -z "${host}" ]] && continue

    host_index=$((host_index + 1))

    local scan_host="${host}"
    if [[ "${scan_host}" != http://* && "${scan_host}" != https://* ]]; then
      scan_host="http://${scan_host}"
    fi

    local safe_host
    safe_host="$(echo "${scan_host}" | sed -E 's#^[a-zA-Z]+://##; s#[^a-zA-Z0-9._-]#_#g')"
    local host_json_file="${ffuf_output_dir}/${host_index}_${safe_host}.json"

    echo "======================================================================"
    echo "[FUZZER] Fuzzing host ${host_index}: ${scan_host}"
    echo "[FUZZER] Output JSON: ${host_json_file}"
    echo "======================================================================"

    if ! ffuf -s -r -fc 404 -of json -o "${host_json_file}" -w "${wordlist}" -u "${scan_host%/}/FUZZ"; then
      echo "[WARN] ffuf failed for host ${scan_host}; continuing with next host."
      continue
    fi

    if [[ -s "${host_json_file}" ]]; then
      jq -r '.results[]? | .url // empty' "${host_json_file}" >> "${discovered_directories_file}"
    fi
  done < "${live_hosts_file}"

  if [[ -s "${discovered_directories_file}" ]]; then
    sort -u "${discovered_directories_file}" -o "${discovered_directories_file}"
  fi

  echo "[FUZZER] Discovered directories saved to ${discovered_directories_file}"
  echo "[FUZZER] Total discovered paths: $(wc -l < "${discovered_directories_file}" | tr -d ' ')"
}
