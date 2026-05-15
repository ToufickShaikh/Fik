#!/usr/bin/env bash
# Tech-detection helper.
#
# Standalone:  bash tech_detector.sh <domain>
#   → outputs comma-separated lowercase technology names (or "unknown") to stdout.
#
# Sourced:     source tech_detector.sh
#   → defines detect_technologies() which detects tech for $TARGET_DOMAIN,
#     looks up Nuclei tags from config/tech_to_tags.json, and exports NUCLEI_TAGS.

# ---------------------------------------------------------------------------
# Internal helper: run httpx -tech-detect on one domain and emit one tech-name
# per line (lowercase, stripped of whitespace).
# ---------------------------------------------------------------------------
_tech_run_httpx() {
  local domain="$1"

  httpx -silent -tech-detect -json -u "${domain}" 2>/dev/null \
    | jq -r '.tech[]? // empty' 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[[:space:]]//g' \
    | sort -u
}

# ---------------------------------------------------------------------------
# detect_technologies – called by main.sh (sourced mode).
# Reads TARGET_DOMAIN, MODULES_DIR, SCRIPT_DIR from the calling environment.
# Sets and exports NUCLEI_TAGS.
# ---------------------------------------------------------------------------
detect_technologies() {
  local tech_config="${SCRIPT_DIR}/config/tech_to_tags.json"

  log_step "Technology detection"

  if ! command -v httpx >/dev/null 2>&1; then
    log_warn "httpx not found; skipping tech detection. Using fallback Nuclei tags."
    NUCLEI_TAGS="${NUCLEI_TAGS:-cve,exposure}"
    export NUCLEI_TAGS
    return 0
  fi

  local raw_tech_lines
  raw_tech_lines="$(_tech_run_httpx "${TARGET_DOMAIN}")"

  if [[ -z "${raw_tech_lines}" ]]; then
    log_info "Detected technologies: (none)"
    NUCLEI_TAGS="${NUCLEI_TAGS:-cve,exposure}"
    log_info "No tech detected; using fallback tags: ${NUCLEI_TAGS}"
    export NUCLEI_TAGS
    return 0
  fi

  # Convert newline list back to comma-separated for logging.
  local raw_techs
  raw_techs="$(echo "${raw_tech_lines}" | tr '\n' ',' | sed 's/,$//')"
  log_info "Detected technologies: ${raw_techs}"

  if ! command -v jq >/dev/null 2>&1 || [[ ! -f "${tech_config}" ]]; then
    NUCLEI_TAGS="${NUCLEI_TAGS:-cve,exposure}"
    log_warn "jq or tech_to_tags.json not available; using fallback: ${NUCLEI_TAGS}"
    export NUCLEI_TAGS
    return 0
  fi

  # Map each detected tech to Nuclei tags via config file; deduplicate.
  local all_tags
  all_tags="$(echo "${raw_tech_lines}" | while IFS= read -r tech; do
    jq -r --arg k "${tech}" '.[$k] // [] | .[]' "${tech_config}" 2>/dev/null
  done | sort -u | tr '\n' ',' | sed 's/,$//')"

  if [[ -n "${all_tags}" ]]; then
    NUCLEI_TAGS="${all_tags}"
    log_success "Nuclei tags selected: ${NUCLEI_TAGS}"
  else
    NUCLEI_TAGS="cve,exposure"
    log_warn "No matching tags found in config; using fallback: ${NUCLEI_TAGS}"
  fi

  export NUCLEI_TAGS
}

# ---------------------------------------------------------------------------
# Standalone mode: script executed directly (not sourced).
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ -z "${1:-}" ]]; then
    echo "unknown"
    exit 1
  fi

  if ! command -v httpx >/dev/null 2>&1; then
    echo "unknown"
    exit 0
  fi

  result="$(_tech_run_httpx "$1" | tr '\n' ',' | sed 's/,$//')"
  echo "${result:-unknown}"
fi
