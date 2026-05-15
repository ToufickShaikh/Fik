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
    deep)  katana_delay="${KATANA_DELAY:-1}"; katana_concurrency="${KATANA_CONCURRENCY:-5}"; katana_retry="${KATANA_RETRY:-3}"; katana_duration="${KATANA_DURATION:-15m}" ;;
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

  : > "${endpoints_file}"
  run_tool "katana" katana -list "${live_hosts_file}" \
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

  log_info "Extracting JavaScript file URLs into js_files.txt"
  grep -Eo "https?://[^[:space:]\"'<>]+\"?" "${endpoints_file}" 2>/dev/null \
    | awk '{ gsub(/"$/, "", $0); print $0 }' \
    | awk 'tolower($0) ~ /\.js([?#].*)?$/ { print $0 }' \
    | sort -u > "${js_files_file}" || true

  log_info "Searching endpoints output for potential API keys and tokens"
  grep -Eio "(AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|sk_(live|test)_[0-9A-Za-z]{16,}|(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)[[:space:]\"':=]+[A-Za-z0-9._-]{8,})" "${endpoints_file}" 2>/dev/null \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | sort -u > "${potential_leaks_file}" || true

  log_success "Endpoints: $(wc -l < "${endpoints_file}" | tr -d ' ') | JS: $(wc -l < "${js_files_file}" | tr -d ' ') | Leaks: $(wc -l < "${potential_leaks_file}" | tr -d ' ')"
}
