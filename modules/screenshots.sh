#!/usr/bin/env bash
# screenshots.sh — Visual recon via gowitness.
# Generates a screenshot per live host so you can spot default admin panels,
# dev/staging instances, and tech stacks visually from the dashboard.

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

  log_step "Visual recon (gowitness)"

  # gowitness v3 syntax: `scan file -f <list>` writes a SQLite DB + PNGs.
  run_tool "gowitness" bash -c \
    "cd '${shots_dir}' && gowitness scan file -f '${live}' \
       --screenshot-path '${shots_dir}' \
       --timeout 15 --threads 8 \
       --chrome-path '${CHROME_PATH:-/usr/bin/chromium}' \
       >/dev/null 2>&1" || true

  local n
  n="$(find "${shots_dir}" -maxdepth 1 -type f -name '*.png' 2>/dev/null | wc -l | tr -d ' ')"
  log_success "Captured ${n} screenshots in ${shots_dir}"
}
