#!/usr/bin/env bash
# Subdomain enumeration + liveness probing.
# Stealth: httpx rate-limited & retried, root domain always injected to
# guarantee a non-empty target list downstream.

run_subdomain_enumeration() {
  if [[ -z "${TARGET_DOMAIN:-}" ]]; then
    log_error "TARGET_DOMAIN is not set."
    return 1
  fi

  if [[ -z "${OUTPUT_DIR:-}" ]]; then
    log_error "OUTPUT_DIR is not set."
    return 1
  fi

  for required_tool in subfinder assetfinder httpx; do
    if ! command -v "${required_tool}" >/dev/null 2>&1; then
      log_error "Missing required tool: ${required_tool}"
      return 1
    fi
  done

  local subfinder_raw="${OUTPUT_DIR}/subfinder.txt"
  local assetfinder_raw="${OUTPUT_DIR}/assetfinder.txt"
  local subdomains_file="${OUTPUT_DIR}/subdomains.txt"
  local live_hosts_file="${OUTPUT_DIR}/live_hosts.txt"
  local httpx_rate_limit="${HTTPX_RATE_LIMIT:-50}"
  local httpx_threads="${HTTPX_THREADS:-25}"
  local httpx_retries="${HTTPX_RETRIES:-2}"

  log_step "Subdomain enumeration for ${TARGET_DOMAIN}"

  # Pre-create raw output files so missing-output doesn't break the merge step.
  : > "${subfinder_raw}"
  : > "${assetfinder_raw}"

  run_tool "subfinder" subfinder -silent -d "${TARGET_DOMAIN}" -o "${subfinder_raw}" || true
  run_tool "assetfinder" bash -c "assetfinder --subs-only '${TARGET_DOMAIN}' > '${assetfinder_raw}'" || true

  log_info "Combining, injecting root domain, and deduplicating"
  {
    cat "${subfinder_raw}" "${assetfinder_raw}" 2>/dev/null || true
    echo "${TARGET_DOMAIN}"
  } | sed '/^[[:space:]]*$/d' | sort -u > "${subdomains_file}"

  log_info "Subdomain count: $(wc -l < "${subdomains_file}" | tr -d ' ')"

  if [[ ! -s "${subdomains_file}" ]]; then
    log_warn "subdomains.txt is empty even after injecting root domain; writing empty live_hosts.txt"
    : > "${live_hosts_file}"
    return 0
  fi

  log_step "Probing live hosts with httpx (rate-limit ${httpx_rate_limit}/s, retries ${httpx_retries})"
  : > "${live_hosts_file}"
  run_tool "httpx" bash -c \
    "sort -u '${subdomains_file}' | httpx -silent -threads ${httpx_threads} -rl ${httpx_rate_limit} -retries ${httpx_retries} > '${live_hosts_file}'" || true

  log_success "Live hosts: $(wc -l < "${live_hosts_file}" | tr -d ' ')"
}
