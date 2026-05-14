#!/usr/bin/env bash
# Shared library for Fik framework.
# Provides:
#   - Color-coded logging functions: log_info, log_warn, log_error, log_success, log_step
#   - run_tool wrapper that isolates external tool failures from `set -e`
#   - register_tempfile / cleanup_tempfiles helpers for trap-based cleanup

# Guard against double-sourcing.
if [[ -n "${_FIK_LIB_SOURCED:-}" ]]; then
  return 0
fi
_FIK_LIB_SOURCED=1

# Detect whether stdout is a TTY; disable colors otherwise (logs, CI, redirects).
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]; then
  _C_RESET=$'\033[0m'
  _C_DIM=$'\033[2m'
  _C_RED=$'\033[31m'
  _C_GREEN=$'\033[32m'
  _C_YELLOW=$'\033[33m'
  _C_BLUE=$'\033[34m'
  _C_CYAN=$'\033[36m'
  _C_BOLD=$'\033[1m'
else
  _C_RESET=""
  _C_DIM=""
  _C_RED=""
  _C_GREEN=""
  _C_YELLOW=""
  _C_BLUE=""
  _C_CYAN=""
  _C_BOLD=""
fi

_log_timestamp() {
  date +"%Y-%m-%d %H:%M:%S"
}

log_info()    { printf "%s[%s]%s %s[INFO]%s    %s\n"    "${_C_DIM}" "$(_log_timestamp)" "${_C_RESET}" "${_C_BLUE}"   "${_C_RESET}" "$*"; }
log_warn()    { printf "%s[%s]%s %s[WARN]%s    %s\n"    "${_C_DIM}" "$(_log_timestamp)" "${_C_RESET}" "${_C_YELLOW}" "${_C_RESET}" "$*" >&2; }
log_error()   { printf "%s[%s]%s %s[ERROR]%s   %s\n"    "${_C_DIM}" "$(_log_timestamp)" "${_C_RESET}" "${_C_RED}"    "${_C_RESET}" "$*" >&2; }
log_success() { printf "%s[%s]%s %s[OK]%s      %s\n"    "${_C_DIM}" "$(_log_timestamp)" "${_C_RESET}" "${_C_GREEN}"  "${_C_RESET}" "$*"; }
log_step()    { printf "\n%s%s==> %s%s\n" "${_C_BOLD}" "${_C_CYAN}" "$*" "${_C_RESET}"; }

# run_tool <label> <command...>
# Runs the given command with `set -e` temporarily disabled so that a non-zero
# exit (timeout, WAF block, crash) is logged as a warning but does not abort
# the framework. Returns the captured exit code so callers can branch on it.
run_tool() {
  local label="$1"
  shift
  if [[ $# -eq 0 ]]; then
    log_error "run_tool called for '${label}' with no command."
    return 2
  fi

  log_info "Executing: ${label}"
  local prev_e_flag=0
  case $- in *e*) prev_e_flag=1;; esac
  set +e
  "$@"
  local rc=$?
  if (( prev_e_flag == 1 )); then
    set -e
  fi

  if (( rc != 0 )); then
    log_warn "${label} exited with code ${rc}. Continuing pipeline."
  else
    log_success "${label} completed."
  fi
  return ${rc}
}

# Temporary file / dir management with trap-based cleanup.
_FIK_TEMP_PATHS=()

register_tempfile() {
  local path="$1"
  [[ -z "${path}" ]] && return 0
  _FIK_TEMP_PATHS+=("${path}")
}

cleanup_tempfiles() {
  local p
  for p in "${_FIK_TEMP_PATHS[@]:-}"; do
    [[ -z "${p}" ]] && continue
    if [[ -e "${p}" || -L "${p}" ]]; then
      rm -rf -- "${p}" 2>/dev/null || true
    fi
  done
  _FIK_TEMP_PATHS=()
}
