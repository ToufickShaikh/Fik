#!/usr/bin/env bash
# Directory fuzzing module backed by ffuf.
# Stealth: per-host rate-limiting, retries via -maxtime per host.
# Failures on individual hosts never abort the loop.

run_fuzzer() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v ffuf >/dev/null 2>&1; then
    log_error "Missing required tool: ffuf"
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    log_error "Missing required tool: jq"
    return 1
  fi

  # Resolve wordlist: deep profile tries the larger dirbuster list first.
  local wordlist
  if [[ "${SCAN_PROFILE:-standard}" == "deep" ]]; then
    local _deep_wl="${FFUF_DEEP_WORDLIST:-/usr/share/wordlists/dirbuster/directory-list-2.3-medium.txt}"
    if [[ -f "${_deep_wl}" ]]; then
      wordlist="${_deep_wl}"
    else
      wordlist="${FFUF_WORDLIST:-/usr/share/wordlists/dirb/common.txt}"
    fi
  else
    wordlist="${FFUF_WORDLIST:-/usr/share/wordlists/dirb/common.txt}"
  fi
  if [[ ! -f "${wordlist}" ]]; then
    log_error "Wordlist not found at ${wordlist}"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local ffuf_output_dir="${OUTPUT_DIR}/ffuf_json"
  local discovered_directories_file="${OUTPUT_DIR}/discovered_directories.txt"
  # Profile-aware defaults.
  local ffuf_rate ffuf_threads ffuf_maxtime
  case "${SCAN_PROFILE:-standard}" in
    deep) ffuf_rate="${FFUF_RATE:-50}"; ffuf_threads="${FFUF_THREADS:-20}"; ffuf_maxtime="${FFUF_MAXTIME:-300}" ;;
    *)    ffuf_rate="${FFUF_RATE:-30}"; ffuf_threads="${FFUF_THREADS:-10}"; ffuf_maxtime="${FFUF_MAXTIME:-180}" ;;
  esac
  mkdir -p "${ffuf_output_dir}"
  : > "${discovered_directories_file}"

  log_step "Directory fuzzing"
  log_info "Input file : ${live_hosts_file}"
  log_info "Wordlist   : ${wordlist}"
  log_info "Rate-limit : ${ffuf_rate} req/s, threads ${ffuf_threads}, max ${ffuf_maxtime}s/host"

  if [[ ! -s "${live_hosts_file}" ]]; then
    log_warn "live_hosts.txt is missing or empty. Skipping fuzzing."
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

    log_info "[${host_index}] Fuzzing ${scan_host}"

    run_tool "ffuf:${safe_host}" ffuf -s -r -fc 404 \
      -rate "${ffuf_rate}" \
      -t "${ffuf_threads}" \
      -maxtime "${ffuf_maxtime}" \
      -of json -o "${host_json_file}" \
      -w "${wordlist}" \
      -u "${scan_host%/}/FUZZ" || true

    if [[ -s "${host_json_file}" ]]; then
      jq -r '.results[]? | .url // empty' "${host_json_file}" 2>/dev/null >> "${discovered_directories_file}" || true
    fi
  done < "${live_hosts_file}"

  if [[ -s "${discovered_directories_file}" ]]; then
    sort -u "${discovered_directories_file}" -o "${discovered_directories_file}"
  fi

  log_success "Discovered paths: $(wc -l < "${discovered_directories_file}" | tr -d ' ')"
}
