#!/usr/bin/env bash
# cors.sh — CORS misconfiguration + clickjacking probe.
# No external tool: pure curl + header inspection.
# Detects:
#   - Access-Control-Allow-Origin: * with credentials
#   - Origin reflection (attacker-controlled Origin echoed back)
#   - Null origin accepted
#   - Missing X-Frame-Options / CSP frame-ancestors (clickjacking)

run_cors_check() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl missing; skipping CORS check."
    return 0
  fi

  local live="${OUTPUT_DIR}/live_hosts.txt"
  local report="${OUTPUT_DIR}/cors_clickjacking.txt"
  local jsonl="${OUTPUT_DIR}/cors_clickjacking.jsonl"
  : > "${report}"; : > "${jsonl}"

  if [[ ! -s "${live}" ]]; then
    log_warn "No live hosts; skipping CORS check."
    return 0
  fi

  log_step "CORS + clickjacking probe"

  local evil_origin="https://evil.attacker.test"
  local host
  while IFS= read -r host; do
    [[ -z "${host}" ]] && continue
    local headers
    headers="$(curl -sk -m 10 -I -H "Origin: ${evil_origin}" "${host}" 2>/dev/null || true)"
    [[ -z "${headers}" ]] && continue

    local aco acc xfo csp issues=()
    aco="$(echo "${headers}" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | tr -d '\r')"
    acc="$(echo "${headers}" | awk -F': ' 'tolower($1)=="access-control-allow-credentials"{print $2}' | tr -d '\r')"
    xfo="$(echo "${headers}" | awk -F': ' 'tolower($1)=="x-frame-options"{print $2}' | tr -d '\r')"
    csp="$(echo "${headers}" | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}' | tr -d '\r')"

    if [[ "${aco}" == "*" && "${acc,,}" == "true" ]]; then
      issues+=("CORS_WILDCARD_WITH_CREDS")
    fi
    if [[ "${aco}" == "${evil_origin}" ]]; then
      issues+=("CORS_ORIGIN_REFLECTION")
    fi
    # Null origin test
    local null_h
    null_h="$(curl -sk -m 10 -I -H "Origin: null" "${host}" 2>/dev/null \
      | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | tr -d '\r')"
    if [[ "${null_h}" == "null" ]]; then
      issues+=("CORS_NULL_ORIGIN_ALLOWED")
    fi
    if [[ -z "${xfo}" ]] && ! echo "${csp}" | grep -qi 'frame-ancestors'; then
      issues+=("CLICKJACKING_NO_XFO_NO_CSP")
    fi

    if (( ${#issues[@]} > 0 )); then
      local issues_csv
      issues_csv="$(IFS=,; echo "${issues[*]}")"
      echo "${host} | ${issues_csv}" >> "${report}"
      printf '{"host":"%s","issues":"%s","aco":"%s","acc":"%s","xfo":"%s"}\n' \
        "${host}" "${issues_csv}" "${aco}" "${acc}" "${xfo}" >> "${jsonl}"
    fi
  done < "${live}"

  # Surface in the unified vulnerability stream.
  if [[ -s "${jsonl}" ]]; then
    awk '{printf "{\"template-id\":\"cors-clickjacking-check\",\"info\":{\"severity\":\"medium\",\"name\":\"CORS / Clickjacking misconfiguration\"},\"matched-at\":\"%s\",\"extracted-results\":[%s]}\n", $0, $0}' \
      "${jsonl}" >> "${OUTPUT_DIR}/vulnerabilities.jsonl" 2>/dev/null || true
  fi

  log_success "CORS/clickjacking findings: $(wc -l < "${report}" | tr -d ' ')"
}
