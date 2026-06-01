#!/usr/bin/env bash
# screenshots.sh — Visual recon via gowitness.
# Generates a screenshot per live host so you can spot default admin panels,
# dev/staging instances, and tech stacks visually from the dashboard.
#
# Memory-safety:
#   Every gowitness "thread" spawns a Chromium process that, on a heavy page,
#   can briefly hit 300-500 MB RSS. With the previous default of --threads 8
#   that meant ~3-4 GB of resident Chrome on top of nuclei/katana/ffuf, which
#   reliably tipped the host into OOM (the Linux kernel killed firefox-esr
#   to free RAM). We now:
#     * cap concurrent Chrome instances (SCREENSHOT_THREADS, default 2)
#     * pass memory-friendly chrome flags (no GPU, no /dev/shm, single-proc)
#     * cap the total number of hosts screenshotted (SCREENSHOT_MAX_HOSTS)
#     * process the host list in small batches so RSS is released between
#       batches and a runaway page can't accumulate indefinitely.

run_screenshots() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }
  if ! command -v gowitness >/dev/null 2>&1; then
    log_warn "gowitness not available; skipping visual recon."
    return 0
  fi

  local live="${OUTPUT_DIR}/live_hosts.txt"
  if [[ ! -s "${live}" ]]; then
    log_warn "No live hosts to screenshot."
    return 0
  fi

  local shots_dir="${OUTPUT_DIR}/screenshots"
  mkdir -p "${shots_dir}"

  # Profile-aware, memory-bounded defaults. Env vars override.
  local sh_threads sh_timeout sh_max_hosts sh_batch
  case "${SCAN_PROFILE:-standard}" in
    quick) sh_threads="${SCREENSHOT_THREADS:-1}"; sh_timeout="${SCREENSHOT_TIMEOUT:-10}"; sh_max_hosts="${SCREENSHOT_MAX_HOSTS:-100}"; sh_batch="${SCREENSHOT_BATCH:-25}" ;;
    deep)  sh_threads="${SCREENSHOT_THREADS:-3}"; sh_timeout="${SCREENSHOT_TIMEOUT:-15}"; sh_max_hosts="${SCREENSHOT_MAX_HOSTS:-500}"; sh_batch="${SCREENSHOT_BATCH:-50}" ;;
    *)     sh_threads="${SCREENSHOT_THREADS:-2}"; sh_timeout="${SCREENSHOT_TIMEOUT:-12}"; sh_max_hosts="${SCREENSHOT_MAX_HOSTS:-250}"; sh_batch="${SCREENSHOT_BATCH:-40}" ;;
  esac

  # Build a chrome args string that drastically reduces per-process RAM.
  # gowitness v3 accepts --chrome-flags as a quoted, space-separated string.
  local chrome_flags="${SCREENSHOT_CHROME_FLAGS:---no-sandbox --disable-gpu --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=TranslateUI,site-per-process --disable-software-rasterizer --no-zygote --memory-pressure-off --js-flags=--max-old-space-size=256}"

  # Cap input list so a sprawling target (10k+ live hosts) cannot OOM us.
  local total
  total="$(wc -l < "${live}" | tr -d ' ')"
  local input_list="${live}"
  if [[ "${sh_max_hosts}" =~ ^[0-9]+$ ]] && (( sh_max_hosts > 0 )) && (( total > sh_max_hosts )); then
    log_warn "Capping screenshot input: ${total} -> ${sh_max_hosts} hosts (set SCREENSHOT_MAX_HOSTS to override)"
    input_list="${OUTPUT_DIR}/.screenshot_input.txt"
    head -n "${sh_max_hosts}" "${live}" > "${input_list}"
    register_tempfile "${input_list}" 2>/dev/null || true
    total="${sh_max_hosts}"
  fi

  log_step "Visual recon (gowitness)"
  log_info "Hosts: ${total} | threads ${sh_threads} | batch ${sh_batch} | timeout ${sh_timeout}s"

  # Split the host list into batches so Chrome processes are recycled and
  # RSS is released between batches. `nice` lowers our CPU priority so the
  # host stays responsive even under heavy load.
  local batch_dir
  batch_dir="$(mktemp -d "${OUTPUT_DIR}/.shots_batch.XXXXXX")"
  register_tempfile "${batch_dir}" 2>/dev/null || true
  ( cd "${batch_dir}" && split -l "${sh_batch}" -d "${input_list}" batch_ )

  local batch
  local b_index=0
  # Probe once whether the installed gowitness build accepts --chrome-flags.
  # gowitness v3.x renamed/removed the flag in some builds; if it's missing
  # the whole batch exits 1 and we lose every screenshot.
  local _has_chrome_flags=0
  if gowitness scan file --help 2>&1 | grep -q -- '--chrome-flags'; then
    _has_chrome_flags=1
  fi

  for batch in "${batch_dir}"/batch_*; do
    [[ -s "${batch}" ]] || continue
    b_index=$((b_index + 1))
    log_info "Screenshot batch ${b_index} ($(wc -l < "${batch}" | tr -d ' ') hosts)"
    if (( _has_chrome_flags == 1 )); then
      run_tool "gowitness:batch${b_index}" nice -n 10 bash -c \
        "cd '${shots_dir}' && gowitness scan file -f '${batch}' \
           --screenshot-path '${shots_dir}' \
           --timeout '${sh_timeout}' --threads '${sh_threads}' \
           --chrome-path '${CHROME_PATH:-/usr/bin/chromium}' \
           --chrome-flags '${chrome_flags}' \
           >/dev/null 2>&1" || true
    else
      run_tool "gowitness:batch${b_index}" nice -n 10 bash -c \
        "cd '${shots_dir}' && gowitness scan file -f '${batch}' \
           --screenshot-path '${shots_dir}' \
           --timeout '${sh_timeout}' --threads '${sh_threads}' \
           --chrome-path '${CHROME_PATH:-/usr/bin/chromium}' \
           >/dev/null 2>&1" || true
    fi
  done

  local n
  n="$(find "${shots_dir}" -maxdepth 1 -type f -name '*.png' 2>/dev/null | wc -l | tr -d ' ')"
  log_success "Captured ${n} screenshots in ${shots_dir}"
}
