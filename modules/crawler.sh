#!/usr/bin/env bash
# Web crawler module backed by katana.
# Stealth profile: headless, -no-sandbox, low concurrency, delay, retries,
# crawl-duration cap. Failures are non-fatal (run_tool absorbs them).

run_crawler() {
  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  if ! command -v katana >/dev/null 2>&1; then
    log_error "Missing required tool: katana"
    return 1
  fi

  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local endpoints_file="${OUTPUT_DIR}/endpoints.txt"
  local js_files_file="${OUTPUT_DIR}/js_files.txt"
  local potential_leaks_file="${OUTPUT_DIR}/potential_leaks.txt"
  # Profile-aware defaults.
  local katana_delay katana_concurrency katana_retry katana_duration
  case "${SCAN_PROFILE:-standard}" in
    quick) katana_delay="${KATANA_DELAY:-3}"; katana_concurrency="${KATANA_CONCURRENCY:-2}"; katana_retry="${KATANA_RETRY:-2}"; katana_duration="${KATANA_DURATION:-3m}"  ;;
    deep)  katana_delay="${KATANA_DELAY:-1}"; katana_concurrency="${KATANA_CONCURRENCY:-3}"; katana_retry="${KATANA_RETRY:-3}"; katana_duration="${KATANA_DURATION:-15m}" ;;
    *)     katana_delay="${KATANA_DELAY:-3}"; katana_concurrency="${KATANA_CONCURRENCY:-2}"; katana_retry="${KATANA_RETRY:-3}"; katana_duration="${KATANA_DURATION:-5m}"  ;;
  esac

  log_step "Crawler"
  log_info "Input live hosts file: ${live_hosts_file}"

  if [[ ! -s "${live_hosts_file}" ]]; then
    log_warn "live_hosts.txt is missing or empty. Writing empty crawler outputs."
    : > "${endpoints_file}"
    : > "${js_files_file}"
    : > "${potential_leaks_file}"
    return 0
  fi

  # Cap the input list — feeding 10k+ live hosts to a headless-chrome crawler
  # is a guaranteed OOM. Override via KATANA_MAX_HOSTS.
  local _kmax="${KATANA_MAX_HOSTS:-500}"
  local katana_input="${live_hosts_file}"
  if [[ "${_kmax}" =~ ^[0-9]+$ ]] && (( _kmax > 0 )); then
    local _kt; _kt="$(wc -l < "${live_hosts_file}" | tr -d ' ')"
    if (( _kt > _kmax )); then
      log_warn "Capping katana input: ${_kt} -> ${_kmax} hosts (set KATANA_MAX_HOSTS to override)"
      katana_input="${OUTPUT_DIR}/.katana_input.txt"
      head -n "${_kmax}" "${live_hosts_file}" > "${katana_input}"
      register_tempfile "${katana_input}" 2>/dev/null || true
    fi
  fi

  # NOTE: katana 1.1+ removed the per-process -chrome-arg flag. Memory is now
  # tamed via -headless -no-sandbox + the host's chromium flags (we already
  # set --disable-dev-shm-usage in docker-compose's shm_size and CHROME_PATH).
  : > "${endpoints_file}"
  run_tool "katana" nice -n 10 katana -list "${katana_input}" \
    -headless \
    -no-sandbox \
    -delay "${katana_delay}" \
    -concurrency "${katana_concurrency}" \
    -retry "${katana_retry}" \
    -crawl-duration "${katana_duration}" \
    -f url \
    -o "${endpoints_file}" || true

  if [[ ! -f "${endpoints_file}" ]]; then
    : > "${endpoints_file}"
  fi

  # Validate collected endpoints — drop anything returning 404 or dead.
  # After a 6+ hour scan the researcher shouldn't see stale/dead links.
  if command -v httpx >/dev/null 2>&1 && [[ -s "${endpoints_file}" ]]; then
    local _validated="${OUTPUT_DIR}/.endpoints_validated.txt"
    local _rl _thr
    case "${SCAN_PROFILE:-standard}" in
      quick) _rl="${HTTPX_RATE_LIMIT:-30}";  _thr="${HTTPX_THREADS:-10}" ;;
      deep)  _rl="${HTTPX_RATE_LIMIT:-100}"; _thr="${HTTPX_THREADS:-40}" ;;
      *)     _rl="${HTTPX_RATE_LIMIT:-50}";  _thr="${HTTPX_THREADS:-20}" ;;
    esac
    log_info "Validating endpoints with httpx (dropping 404s and dead links)"
    run_tool "httpx-validate-endpoints" bash -c \
      "httpx -silent -mc 200,201,204,301,302,307,401,403 \
             -threads ${_thr} -rl ${_rl} \
             -l '${endpoints_file}' > '${_validated}'" || true
    if [[ -s "${_validated}" ]]; then
      mv "${_validated}" "${endpoints_file}"
      log_info "Valid endpoints after 404-filter: $(wc -l < "${endpoints_file}" | tr -d ' ')"
    else
      log_warn "httpx validation returned no results; keeping original endpoints list"
      rm -f "${_validated}"
    fi
  fi

  # Cap endpoints.txt — katana on a sprawling app can emit hundreds of
  # thousands of URLs, almost all duplicates of templated routes. Override
  # via MAX_ENDPOINTS env var.
  local _cap="${MAX_ENDPOINTS:-50000}"
  if [[ "${_cap}" =~ ^[0-9]+$ ]] && (( _cap > 0 )) && [[ -s "${endpoints_file}" ]]; then
    local _total; _total="$(wc -l < "${endpoints_file}" | tr -d ' ')"
    if (( _total > _cap )); then
      log_warn "Capping endpoints.txt: ${_total} -> ${_cap} (set MAX_ENDPOINTS to override)"
      sort -u "${endpoints_file}" | head -n "${_cap}" > "${endpoints_file}.cap" \
        && mv "${endpoints_file}.cap" "${endpoints_file}"
    fi
  fi

  log_info "Extracting JavaScript file URLs into js_files.txt"
  LC_ALL=C grep -Eo 'https?://[^[:space:]"'"'"'<>]+"?' "${endpoints_file}" 2>/dev/null \
    | awk '{ gsub(/"$/, "", $0); print $0 }' \
    | awk 'tolower($0) ~ /\.js([?#].*)?$/ { print $0 }' \
    | sort -u > "${js_files_file}" || true

  log_info "Searching endpoints output for potential API keys and tokens"
  LC_ALL=C grep -Eio "(AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|sk_(live|test)_[0-9A-Za-z]{16,}|(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)[[:space:]\"':=]+[A-Za-z0-9._-]{8,})" "${endpoints_file}" 2>/dev/null \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | sort -u > "${potential_leaks_file}" || true

  log_success "Endpoints: $(wc -l < "${endpoints_file}" | tr -d ' ') | JS: $(wc -l < "${js_files_file}" | tr -d ' ') | Leaks: $(wc -l < "${potential_leaks_file}" | tr -d ' ')"
}
