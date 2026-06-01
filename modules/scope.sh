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
    '[.[] | select(.domain == $d) | .includeScope // ""] | join("\n")' \
    "${_SCOPE_TARGETS_FILE}" 2>/dev/null || echo "")"
  exc="$(jq -r --arg d "${TARGET_DOMAIN}" \
    '[.[] | select(.domain == $d) | .excludeScope // ""] | join("\n")' \
    "${_SCOPE_TARGETS_FILE}" 2>/dev/null || echo "")"

  # Convert bug-bounty wildcard URLs like "https://x.com/admin/*" into regex
  # fragments. Strip scheme, escape regex metachars (except *), turn * into .*
  _scope_normalize() {
    local raw="$1"
    raw="${raw//$'\r'/}"
    # Split on commas and newlines
    echo "${raw}" | tr ',\n' '\n\n' | while IFS= read -r line; do
      line="${line## }"; line="${line%% }"
      [[ -z "${line}" ]] && continue
      # Strip http(s)://
      line="${line#http://}"; line="${line#https://}"
      # Escape regex metachars except *
      line="$(echo "${line}" | sed -e 's/[][\.^$+?(){}|]/\\&/g')"
      # Convert * → .*
      line="${line//\*/.*}"
      echo "${line}"
    done | grep -v '^$' | paste -sd'|' -
  }

  if [[ -n "${inc}" && "${inc}" != "null" ]]; then
    SCOPE_INCLUDE_REGEX="$(_scope_normalize "${inc}")"
    [[ -n "${SCOPE_INCLUDE_REGEX}" ]] && log_info "Scope include: ${SCOPE_INCLUDE_REGEX}"
  fi
  if [[ -n "${exc}" && "${exc}" != "null" ]]; then
    SCOPE_EXCLUDE_REGEX="$(_scope_normalize "${exc}")"
    [[ -n "${SCOPE_EXCLUDE_REGEX}" ]] && log_info "Scope exclude: ${SCOPE_EXCLUDE_REGEX}"
  fi

  export SCOPE_INCLUDE_REGEX SCOPE_EXCLUDE_REGEX

  # Strict scope (bug-bounty mode): also enforce that subdomains.txt /
  # live_hosts.txt only ever contain in-scope hosts.
  if [[ "${STRICT_SCOPE:-0}" == "1" ]]; then
    log_info "Scope: STRICT mode enabled — all module outputs will be filtered."
    export STRICT_SCOPE
  fi
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
