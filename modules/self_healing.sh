#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Fik :: Universal Self-Healing Command Wrapper
# ----------------------------------------------------------------------------
# Public API:
#   run_resilient <label> <cmd> [args...]
#       Runs an arbitrary external tool with:
#         - unique run-id logging (stdout + stderr captured)
#         - OOM (exit 137) auto-recovery: lowers -c/-t/-concurrency/-threads
#           by 40% per attempt, sleeps 10s, retries up to 3 times, then drops
#           into "safe mode" (concurrency=1, threads=1)
#         - generic non-zero diagnostic: free RAM, disk, FD count, with
#           actionable suggestions written to the log
#         - low-RAM fallback: if free RAM < 500MB, creates a 1G swapfile
#         - resumability: maintains <OUTPUT_DIR>/.state.json keyed by label,
#           recording status, attempts, last_run_id, and (for line-oriented
#           input lists) last_successful_line so a re-run can pick up where
#           the previous one crashed.
#
# This module is intentionally self-contained. It depends only on `_lib.sh`
# for log_* functions; if those are unavailable it falls back to plain echo.
# ----------------------------------------------------------------------------

# Guard against double-source.
if [[ -n "${_FIK_SELF_HEAL_SOURCED:-}" ]]; then
  return 0
fi
_FIK_SELF_HEAL_SOURCED=1

# --- Logging shims (use _lib.sh if loaded, else fall back) ------------------
if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { echo "[INFO]  $*"; }
  log_warn()    { echo "[WARN]  $*" >&2; }
  log_error()   { echo "[ERROR] $*" >&2; }
  log_success() { echo "[OK]    $*"; }
  log_step()    { echo; echo "==> $*"; }
fi

# --- Tunables (env overrides) -----------------------------------------------
SELF_HEAL_MAX_RETRIES="${SELF_HEAL_MAX_RETRIES:-3}"
SELF_HEAL_OOM_SLEEP="${SELF_HEAL_OOM_SLEEP:-10}"
SELF_HEAL_LOW_RAM_MB="${SELF_HEAL_LOW_RAM_MB:-500}"
SELF_HEAL_SWAP_SIZE_MB="${SELF_HEAL_SWAP_SIZE_MB:-1024}"
SELF_HEAL_SWAP_PATH="${SELF_HEAL_SWAP_PATH:-/var/swap.fik}"

# Concurrency-style flags we know how to dial down. Order matters: we look
# for the first one that appears in the command and rewrite it.
_SELF_HEAL_CONC_FLAGS=( "-c" "-t" "-concurrency" "-threads" "-rate" "-rate-limit" "-rl" )

# ----------------------------------------------------------------------------
# Internal helpers
# ----------------------------------------------------------------------------

# Allocate a unique run ID + per-run log paths under $OUTPUT_DIR/logs.
_self_heal_new_run_id() {
  local label="$1"
  local safe_label
  safe_label="$(echo "${label}" | sed 's/[^a-zA-Z0-9._-]/_/g')"
  echo "${safe_label}_$(date +%Y%m%d_%H%M%S)_$$_${RANDOM}"
}

_self_heal_log_dir() {
  local dir="${OUTPUT_DIR:-./results}/logs"
  mkdir -p "${dir}" 2>/dev/null || true
  echo "${dir}"
}

_self_heal_state_path() {
  echo "${OUTPUT_DIR:-./results}/.state.json"
}

# Initialize state file if missing. Pure-bash; no jq dependency required for
# create. We *use* jq for updates if available, else fall back to safe rewrite.
_self_heal_state_init() {
  local f
  f="$(_self_heal_state_path)"
  if [[ ! -f "${f}" ]]; then
    echo '{"runs":{}}' > "${f}"
  fi
}

# Write/update a state entry. Requires jq if you want pretty merging; without
# jq we degrade to a flat-key append (still valid JSON-ish but minimal).
# Args: <label> <status> <attempt> <run_id> [last_successful_line]
_self_heal_state_update() {
  local label="$1" status="$2" attempt="$3" run_id="$4" last_line="${5:-}"
  local f
  f="$(_self_heal_state_path)"
  _self_heal_state_init

  if command -v jq >/dev/null 2>&1; then
    local tmp="${f}.tmp.$$"
    jq --arg label "${label}" \
       --arg status "${status}" \
       --argjson attempt "${attempt}" \
       --arg run_id "${run_id}" \
       --arg last_line "${last_line}" \
       --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.runs[$label] = {
          status: $status,
          attempt: $attempt,
          last_run_id: $run_id,
          last_successful_line: ($last_line | tonumber? // 0),
          updated_at: $ts
        }' "${f}" > "${tmp}" && mv "${tmp}" "${f}"
  else
    # Minimal fallback: rewrite a single-record file.
    cat > "${f}" <<EOF
{"runs":{"${label}":{"status":"${status}","attempt":${attempt},"last_run_id":"${run_id}","last_successful_line":${last_line:-0},"updated_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}}}
EOF
  fi
}

# Look up resume cursor for a label. Echoes an integer (0 if unknown).
self_heal_resume_line() {
  local label="$1"
  local f
  f="$(_self_heal_state_path)"
  if [[ -f "${f}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r --arg l "${label}" '.runs[$l].last_successful_line // 0' "${f}" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Detect whether the command array contains a known concurrency flag.
# Echoes the flag name on stdout, empty string if none found.
_self_heal_find_conc_flag() {
  local arg flag
  for arg in "$@"; do
    for flag in "${_SELF_HEAL_CONC_FLAGS[@]}"; do
      if [[ "${arg}" == "${flag}" ]]; then
        echo "${flag}"
        return 0
      fi
    done
  done
  echo ""
}

# Rewrite the value following <flag> in the argv. Reduces by `factor` percent
# (e.g. 40 means new = old * 0.6), with a hard floor of 1.
# Echoes the new argv on stdout, one arg per NUL-separated token.
_self_heal_rewrite_conc() {
  local flag="$1" factor="$2"
  shift 2
  local out=() i=0 args=("$@") n=${#args[@]} hit=0
  while (( i < n )); do
    out+=("${args[$i]}")
    if [[ "${args[$i]}" == "${flag}" && $((i+1)) -lt $n ]]; then
      local cur="${args[$((i+1))]}"
      if [[ "${cur}" =~ ^[0-9]+$ ]]; then
        local new=$(( cur * (100 - factor) / 100 ))
        (( new < 1 )) && new=1
        out+=("${new}")
        hit=1
        i=$((i+2))
        continue
      fi
    fi
    i=$((i+1))
  done
  if (( hit == 0 )); then
    return 1
  fi
  printf '%s\0' "${out[@]}"
  return 0
}

# Set a flag's value to 1 (safe mode). If the flag isn't present, append it.
_self_heal_set_safe() {
  local flag="$1"
  shift
  local out=() i=0 args=("$@") n=${#args[@]} hit=0
  while (( i < n )); do
    out+=("${args[$i]}")
    if [[ "${args[$i]}" == "${flag}" && $((i+1)) -lt $n ]]; then
      out+=("1")
      hit=1
      i=$((i+2))
      continue
    fi
    i=$((i+1))
  done
  if (( hit == 0 )); then
    out+=("${flag}" "1")
  fi
  printf '%s\0' "${out[@]}"
}

# ----------------------------------------------------------------------------
# Diagnostic + recovery primitives
# ----------------------------------------------------------------------------

# Check available RAM in MB. Echoes integer, or -1 if unknown.
_self_heal_free_ram_mb() {
  if command -v free >/dev/null 2>&1; then
    free -m | awk '/^Mem:/ {print $7}'
  else
    echo -1
  fi
}

# Check free disk on $OUTPUT_DIR's filesystem in MB. -1 if unknown.
_self_heal_free_disk_mb() {
  local target="${OUTPUT_DIR:-.}"
  if command -v df >/dev/null 2>&1; then
    df -Pm "${target}" 2>/dev/null | awk 'NR==2 {print $4}'
  else
    echo -1
  fi
}

# Approximate FD usage for current shell.
_self_heal_fd_count() {
  if [[ -d /proc/$$/fd ]]; then
    ls /proc/$$/fd 2>/dev/null | wc -l | tr -d ' '
  else
    echo -1
  fi
}

# Create a swapfile if free RAM is below threshold. Idempotent: if the swap
# path already exists or sudo is unavailable, becomes a no-op with a warning.
_self_heal_try_create_swap() {
  local size_mb="${SELF_HEAL_SWAP_SIZE_MB}"
  local path="${SELF_HEAL_SWAP_PATH}"

  if [[ "$(uname -s)" != "Linux" ]]; then
    log_warn "Swap creation skipped: not running on Linux."
    return 1
  fi

  if [[ -e "${path}" ]]; then
    log_warn "Swap path ${path} already exists; skipping creation."
    return 1
  fi

  local sudo=""
  if [[ $EUID -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo="sudo"
    else
      log_warn "Swap creation skipped: not root and sudo unavailable."
      return 1
    fi
  fi

  log_warn "Low RAM detected. Creating ${size_mb}MB swap at ${path}."
  ${sudo} fallocate -l "${size_mb}M" "${path}" 2>/dev/null \
    || ${sudo} dd if=/dev/zero of="${path}" bs=1M count="${size_mb}" status=none \
    || { log_error "Failed to allocate swapfile."; return 1; }
  ${sudo} chmod 600 "${path}" || true
  ${sudo} mkswap "${path}"  >/dev/null 2>&1 || { log_error "mkswap failed."; return 1; }
  ${sudo} swapon "${path}"  >/dev/null 2>&1 || { log_error "swapon failed."; return 1; }
  log_success "Swap activated at ${path} (${size_mb}MB)."
  return 0
}

# Run diagnostics + write suggestions to the run log. $1 = log path, $2 = rc.
_self_heal_diagnose() {
  local log_path="$1" rc="$2"
  local ram disk fds
  ram="$(_self_heal_free_ram_mb)"
  disk="$(_self_heal_free_disk_mb)"
  fds="$(_self_heal_fd_count)"

  {
    echo
    echo "======================================================================"
    echo "[DIAGNOSTIC] exit_code=${rc}  ram_mb=${ram}  disk_mb=${disk}  fds=${fds}"
    echo "======================================================================"
    if [[ "${ram}" =~ ^-?[0-9]+$ ]] && (( ram >= 0 )) && (( ram < SELF_HEAL_LOW_RAM_MB )); then
      echo "[SUGGEST] RAM is low (${ram}MB < ${SELF_HEAL_LOW_RAM_MB}MB). Consider:"
      echo "          sudo fallocate -l ${SELF_HEAL_SWAP_SIZE_MB}M ${SELF_HEAL_SWAP_PATH} && \\"
      echo "            sudo chmod 600 ${SELF_HEAL_SWAP_PATH} && sudo mkswap ${SELF_HEAL_SWAP_PATH} && \\"
      echo "            sudo swapon ${SELF_HEAL_SWAP_PATH}"
    fi
    if [[ "${disk}" =~ ^-?[0-9]+$ ]] && (( disk >= 0 )) && (( disk < 200 )); then
      echo "[SUGGEST] Disk space critically low (<200MB free). Free space or relocate OUTPUT_DIR."
    fi
    if [[ "${fds}" =~ ^[0-9]+$ ]] && (( fds > 800 )); then
      echo "[SUGGEST] High FD count (${fds}). Consider 'ulimit -n 4096' before re-running."
    fi
    case "${rc}" in
      124) echo "[SUGGEST] Exit 124 = 'timeout' utility killed the process. Increase the timeout budget." ;;
      126) echo "[SUGGEST] Exit 126 = command found but not executable. Check 'chmod +x'." ;;
      127) echo "[SUGGEST] Exit 127 = command not found. Verify PATH and that the tool is installed." ;;
      130) echo "[SUGGEST] Exit 130 = SIGINT (user Ctrl-C)." ;;
      137) echo "[SUGGEST] Exit 137 = SIGKILL (likely OOM). Lower concurrency or add swap." ;;
      139) echo "[SUGGEST] Exit 139 = SIGSEGV. Update the tool; report upstream if reproducible." ;;
      143) echo "[SUGGEST] Exit 143 = SIGTERM. Something asked the process to stop." ;;
    esac
    echo "======================================================================"
  } >> "${log_path}"
}

# Read the last numeric line cursor a tool wrote to its log, if it follows the
# convention "[STATE] line=<n>". This lets long-running, line-oriented tools
# surface progress to the wrapper without us having to parse arbitrary output.
_self_heal_extract_last_line() {
  local log_path="$1"
  if [[ -f "${log_path}" ]]; then
    grep -Eo '\[STATE\] line=[0-9]+' "${log_path}" 2>/dev/null \
      | tail -n1 \
      | sed -E 's/.*=([0-9]+).*/\1/'
  fi
}

# ----------------------------------------------------------------------------
# Public entrypoint
# ----------------------------------------------------------------------------
# Usage: run_resilient <label> <cmd> [args...]
# Returns: 0 on eventual success, last non-zero rc on terminal failure.
run_resilient() {
  if [[ $# -lt 2 ]]; then
    log_error "run_resilient: usage: run_resilient <label> <cmd> [args...]"
    return 2
  fi

  local label="$1"; shift
  local -a cmd=("$@")

  local log_dir; log_dir="$(_self_heal_log_dir)"
  local run_id;  run_id="$(_self_heal_new_run_id "${label}")"
  local log_path="${log_dir}/${run_id}.log"

  _self_heal_state_init
  _self_heal_state_update "${label}" "starting" 0 "${run_id}" 0

  local conc_flag
  conc_flag="$(_self_heal_find_conc_flag "${cmd[@]}")"

  local attempt=0 rc=0
  while (( attempt <= SELF_HEAL_MAX_RETRIES )); do
    attempt=$(( attempt + 1 ))
    log_info "[${label}] attempt ${attempt}/${SELF_HEAL_MAX_RETRIES} (run_id=${run_id})"
    log_info "[${label}] log: ${log_path}"

    {
      echo "===== ATTEMPT ${attempt} @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
      printf 'CMD:'; printf ' %q' "${cmd[@]}"; echo
      echo "================================================================"
    } >> "${log_path}"

    # Run the command, capturing both streams. set +e so the pipeline survives.
    set +e
    "${cmd[@]}" >> "${log_path}" 2>&1
    rc=$?
    set -e

    if (( rc == 0 )); then
      local last_line
      last_line="$(_self_heal_extract_last_line "${log_path}")"
      _self_heal_state_update "${label}" "success" "${attempt}" "${run_id}" "${last_line:-0}"
      log_success "[${label}] succeeded on attempt ${attempt}."
      return 0
    fi

    log_warn "[${label}] attempt ${attempt} failed (rc=${rc})."

    # Persist progress cursor even on failure so the next run can resume.
    local last_line
    last_line="$(_self_heal_extract_last_line "${log_path}")"
    _self_heal_state_update "${label}" "failed" "${attempt}" "${run_id}" "${last_line:-0}"

    # Diagnostic block goes into the log every failure.
    _self_heal_diagnose "${log_path}" "${rc}"

    # OOM path (137) — dial concurrency down by 40% and retry.
    if (( rc == 137 )); then
      log_warn "[${label}] OOM detected (exit 137). Lowering concurrency by 40%, sleeping ${SELF_HEAL_OOM_SLEEP}s."
      local ram; ram="$(_self_heal_free_ram_mb)"
      if [[ "${ram}" =~ ^[0-9]+$ ]] && (( ram < SELF_HEAL_LOW_RAM_MB )); then
        _self_heal_try_create_swap || true
      fi
      if [[ -n "${conc_flag}" ]]; then
        local rewritten
        if rewritten="$(_self_heal_rewrite_conc "${conc_flag}" 40 "${cmd[@]}")"; then
          mapfile -d '' -t cmd < <(printf '%s' "${rewritten}")
          log_info "[${label}] new command: ${cmd[*]}"
        else
          log_warn "[${label}] could not rewrite ${conc_flag}; continuing with same command."
        fi
      else
        log_warn "[${label}] no known concurrency flag in command; cannot lower it dynamically."
      fi

      if (( attempt >= SELF_HEAL_MAX_RETRIES )); then
        # Final attempt: drop into safe mode and try once more.
        log_warn "[${label}] retries exhausted; entering SAFE MODE (concurrency=1)."
        local target_flag="${conc_flag:--c}"
        local safe
        safe="$(_self_heal_set_safe "${target_flag}" "${cmd[@]}")"
        mapfile -d '' -t cmd < <(printf '%s' "${safe}")
        log_info "[${label}] safe-mode command: ${cmd[*]}"
        run_id="$(_self_heal_new_run_id "${label}_safe")"
        log_path="${log_dir}/${run_id}.log"
        sleep "${SELF_HEAL_OOM_SLEEP}"
        set +e
        "${cmd[@]}" >> "${log_path}" 2>&1
        rc=$?
        set -e
        if (( rc == 0 )); then
          _self_heal_state_update "${label}" "success_safe_mode" "${attempt}" "${run_id}" 0
          log_success "[${label}] succeeded in safe mode."
          return 0
        fi
        _self_heal_state_update "${label}" "failed_safe_mode" "${attempt}" "${run_id}" 0
        _self_heal_diagnose "${log_path}" "${rc}"
        log_error "[${label}] safe mode also failed (rc=${rc}). Giving up."
        return ${rc}
      fi

      sleep "${SELF_HEAL_OOM_SLEEP}"
      continue
    fi

    # Non-OOM failure — try to recover from low RAM if that's the cause, then
    # retry with the same command (no concurrency change) up to the limit.
    local ram; ram="$(_self_heal_free_ram_mb)"
    if [[ "${ram}" =~ ^[0-9]+$ ]] && (( ram < SELF_HEAL_LOW_RAM_MB )); then
      _self_heal_try_create_swap || true
    fi

    if (( attempt >= SELF_HEAL_MAX_RETRIES )); then
      log_error "[${label}] exhausted ${SELF_HEAL_MAX_RETRIES} attempts. Final rc=${rc}."
      return ${rc}
    fi

    sleep 2
  done

  return ${rc}
}
