#!/usr/bin/env bash
# dnsbrute.sh — DNS bruteforce with puredns (preferred) or shuffledns
# fallback. Results are merged into subdomains.txt and re-probed by httpx.

run_dns_brute() {
  [[ -z "${TARGET_DOMAIN:-}" ]] && { log_error "TARGET_DOMAIN not set"; return 1; }
  [[ -z "${OUTPUT_DIR:-}" ]]     && { log_error "OUTPUT_DIR not set"; return 1; }

  local wordlist="${DNS_BRUTE_WORDLIST:-/opt/wordlists/subdomains.txt}"
  local resolvers="${DNS_BRUTE_RESOLVERS:-/opt/resolvers/resolvers.txt}"
  local out="${OUTPUT_DIR}/dnsbrute.txt"
  : > "${out}"

  if [[ ! -s "${wordlist}" ]]; then
    log_warn "DNS brute wordlist missing (${wordlist}); skipping."
    return 0
  fi
  if [[ ! -s "${resolvers}" ]]; then
    log_warn "Resolvers file missing (${resolvers}); skipping."
    return 0
  fi

  log_step "DNS bruteforce against ${TARGET_DOMAIN}"

  if command -v puredns >/dev/null 2>&1; then
    run_tool "puredns" puredns bruteforce "${wordlist}" "${TARGET_DOMAIN}" \
      -r "${resolvers}" --quiet -w "${out}" || true
  elif command -v shuffledns >/dev/null 2>&1 && command -v massdns >/dev/null 2>&1; then
    run_tool "shuffledns" shuffledns -d "${TARGET_DOMAIN}" -w "${wordlist}" \
      -r "${resolvers}" -silent -o "${out}" || true
  else
    log_warn "Neither puredns nor shuffledns+massdns available; skipping brute."
    return 0
  fi

  local cnt
  cnt="$(wc -l < "${out}" | tr -d ' ')"
  log_info "DNS-brute discovered ${cnt} hosts."

  if (( cnt > 0 )); then
    local subs="${OUTPUT_DIR}/subdomains.txt"
    cat "${out}" "${subs}" 2>/dev/null | sed '/^[[:space:]]*$/d' \
      | sort -u > "${subs}.merged" && mv "${subs}.merged" "${subs}"
    log_success "Merged brute results into ${subs}"
  fi
}
