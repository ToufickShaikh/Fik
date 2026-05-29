#!/usr/bin/env bash
# scope.sh — Scope enforcement.
# Reads backend/targets.json to find includeScope / excludeScope rules for the
# current TARGET_DOMAIN, exports them as regex env vars, and provides
# `scope_filter` to strip out-of-scope hosts/URLs from any stdin stream.

if [[ -n "${_FIK_SCOPE_SOURCED:-}" ]]; then return 0; fi
_FIK_SCOPE_SOURCED=1

_SCOPE_TARGETS_FILE="${SCRIPT_DIR:-$(pwd)}/backend/targets.json"

load_scope() {
  SCOPE_INCLUDE_REGEX=""
  SCOPE_EXCLUDE_REGEX=""

  if [[ ! -f "${_SCOPE_TARGETS_FILE}" ]] || ! command -v jq >/dev/null 2>&1; then
    log_info "Scope: targets.json or jq unavailable; no in/out filtering."
    return 0
  fi

  local inc exc
  inc="$(jq -r --arg d "${TARGET_DOMAIN}" \
    '[.[] | select(.domain == $d) | .includeScope // ""] | join("\n") | gsub("\\s+";"")' \
    "${_SCOPE_TARGETS_FILE}" 2>/dev/null || echo "")"
  exc="$(jq -r --arg d "${TARGET_DOMAIN}" \
    '[.[] | select(.domain == $d) | .excludeScope // ""] | join("\n") | gsub("\\s+";"")' \
    "${_SCOPE_TARGETS_FILE}" 2>/dev/null || echo "")"

  # Lines in the *Scope fields are comma- or newline-separated regex fragments.
  if [[ -n "${inc}" && "${inc}" != "null" ]]; then
    SCOPE_INCLUDE_REGEX="$(echo "${inc}" | tr ',\n' '||' | sed 's/||$//')"
    log_info "Scope include: ${SCOPE_INCLUDE_REGEX}"
  fi
  if [[ -n "${exc}" && "${exc}" != "null" ]]; then
    SCOPE_EXCLUDE_REGEX="$(echo "${exc}" | tr ',\n' '||' | sed 's/||$//')"
    log_info "Scope exclude: ${SCOPE_EXCLUDE_REGEX}"
  fi

  export SCOPE_INCLUDE_REGEX SCOPE_EXCLUDE_REGEX
}

# scope_filter: stdin → stdout, dropping lines that don't match include and
# do match exclude. Empty rules pass everything.
scope_filter() {
  local inc="${SCOPE_INCLUDE_REGEX:-}"
  local exc="${SCOPE_EXCLUDE_REGEX:-}"
  if [[ -z "${inc}" && -z "${exc}" ]]; then
    cat
    return 0
  fi
  awk -v inc="${inc}" -v exc="${exc}" '
    {
      keep = 1;
      if (length(inc) > 0 && $0 !~ inc) keep = 0;
      if (length(exc) > 0 && $0 ~ exc) keep = 0;
      if (keep) print $0;
    }
  '
}
