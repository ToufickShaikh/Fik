#!/usr/bin/env bash
# cleanup.sh — Post-scan disk-footprint optimizer.
#
# Runs AFTER export_to_json + run_diff_against_previous and BEFORE upload.
# Goals (in order of priority):
#   1. Slim scan_results.json so the backend / frontend never see multi-MB
#      nuclei objects (templates, request/response bodies, base64 dumps).
#   2. Delete one-shot intermediate dirs (js_stash/, ffuf_json/) once their
#      data has been folded into text artefacts.
#   3. Gzip every text/JSONL artefact larger than COMPRESS_MIN_BYTES so they
#      remain forensically available without occupying GBs.
#   4. Generate a tiny, human-readable summary.txt + machine-readable
#      summary.json (used for triage and as the canonical small artefact).
#   5. Apply a retention policy so historical scans don't grow unbounded.
#
# All steps are best-effort; any individual failure is logged but never
# aborts the pipeline (run_tool / set +e patterns).
#
# Tunables (env vars; sensible defaults):
#   COMPRESS_MIN_BYTES   bytes; only gzip files larger than this   (default 65536)
#   RETENTION_KEEP       per-target dirs to keep in $RESULTS_DIR   (default 10)
#   KEEP_RAW_VULNS       1 = keep gzipped vulnerabilities.jsonl.gz (default 1)
#   KEEP_RAW_WAYBACK     1 = keep gzipped wayback_urls_raw.txt.gz  (default 1)
#   SLIM_VULN_FIELDS     1 = rewrite scan_results.json with slim   (default 1)
#                            vulnerability_objects projection
#
# Required vulnerability_objects fields (consumed by report_generator.js):
#   - template-id / template_id
#   - info.severity / severity
#   - info.name / template_name
#   - matched-at / matched_at / host
# Everything else (template body, request, response, extracted-results,
# template-encoded, curl-command, ip, ...) is dropped.

run_cleanup() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }

  local compress_min="${COMPRESS_MIN_BYTES:-65536}"
  local retention_keep="${RETENTION_KEEP:-10}"
  local slim_fields="${SLIM_VULN_FIELDS:-1}"
  local keep_vulns="${KEEP_RAW_VULNS:-1}"
  local keep_wb="${KEEP_RAW_WAYBACK:-1}"

  log_step "Post-scan cleanup & compaction"

  local before_kb=0 after_kb=0
  if command -v du >/dev/null 2>&1; then
    before_kb="$(du -sk "${OUTPUT_DIR}" 2>/dev/null | awk '{print $1}')"
    log_info "Pre-cleanup size: $((before_kb / 1024)) MB"
  fi

  # ---------------------------------------------------------------------------
  # 1. Slim scan_results.json — drop heavy nuclei fields per finding.
  # ---------------------------------------------------------------------------
  local sr_json="${OUTPUT_DIR}/scan_results.json"
  if [[ "${slim_fields}" == "1" ]] && [[ -s "${sr_json}" ]] && command -v jq >/dev/null 2>&1; then
    log_info "Slimming vulnerability_objects in scan_results.json"
    local tmp="${sr_json}.slim"
    # Every per-field accessor uses `try ... catch null` so a single malformed
    # nuclei record (missing .info, non-string severity, etc.) cannot abort
    # the whole transform and leave the user with a multi-MB scan_results.json.
    if jq '
      to_entries
      | map(
          .value.vulnerability_objects = (
            (.value.vulnerability_objects // [])
            | map(
                . as $f
                | {
                    "template-id": ((try $f."template-id" catch null) // (try $f.template_id catch null) // (try $f.template catch null) // "unknown"),
                    type:          ((try $f.type catch null) // "http"),
                    host:          ((try $f.host catch null) // (try $f."matched-at" catch null) // (try $f.matched_at catch null) // ""),
                    "matched-at":  ((try $f."matched-at" catch null) // (try $f.matched_at catch null) // (try $f.host catch null) // ""),
                    url:           ((try $f.url catch null) // (try $f."matched-at" catch null) // (try $f.matched_at catch null) // ""),
                    info: {
                      name:     ((try $f.info.name catch null) // (try $f.template_name catch null) // (try $f."template-id" catch null) // (try $f.template_id catch null) // "Unnamed"),
                      severity: ((try ($f.info.severity | tostring) catch null) // (try ($f.severity | tostring) catch null) // "info") | ascii_downcase,
                      tags:     ((try $f.info.tags catch null) // [])
                    }
                  }
              )
          )
        )
      | from_entries
    ' "${sr_json}" > "${tmp}" 2>/dev/null && [[ -s "${tmp}" ]]; then
      mv "${tmp}" "${sr_json}"
      log_success "Slimmed scan_results.json: $(wc -c < "${sr_json}" | tr -d ' ') bytes"
    else
      rm -f "${tmp}"
      log_warn "Slim transform failed; keeping original scan_results.json"
    fi
  fi

  # ---------------------------------------------------------------------------
  # 2. Drop heavy intermediate dirs whose data has been extracted.
  # ---------------------------------------------------------------------------
  local stash="${OUTPUT_DIR}/js_stash"
  if [[ -d "${stash}" ]]; then
    local n; n="$(find "${stash}" -type f 2>/dev/null | wc -l | tr -d ' ')"
    rm -rf -- "${stash}" 2>/dev/null || true
    log_info "Removed js_stash/ (${n} files)"
  fi

  local ffuf_dir="${OUTPUT_DIR}/ffuf_json"
  if [[ -d "${ffuf_dir}" ]]; then
    local n; n="$(find "${ffuf_dir}" -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')"
    # URLs already extracted into discovered_directories.txt by fuzzer.sh.
    rm -rf -- "${ffuf_dir}" 2>/dev/null || true
    log_info "Removed ffuf_json/ (${n} per-host JSON files)"
  fi

  # gowitness sqlite DB is huge and unused by exporter — drop if screenshots dir kept the PNGs.
  local shots_db="${OUTPUT_DIR}/screenshots/gowitness.sqlite3"
  [[ -f "${shots_db}" ]] && { rm -f -- "${shots_db}"; log_info "Removed gowitness.sqlite3"; }

  # ---------------------------------------------------------------------------
  # 3. Compress raw text / jsonl artefacts above the threshold.
  #     Whitelist of files that stay uncompressed (consumed by upload + GUI).
  # ---------------------------------------------------------------------------
  local keep_open=(
    "scan_results.json"
    "summary.json"
    "summary.txt"
  )
  local f rel skip
  while IFS= read -r -d '' f; do
    rel="${f##${OUTPUT_DIR}/}"
    skip=0
    for k in "${keep_open[@]}"; do
      [[ "${rel}" == "${k}" ]] && skip=1 && break
    done
    (( skip == 1 )) && continue
    # skip already-compressed
    case "${f}" in *.gz|*.zip|*.tar|*.png|*.jpg|*.jpeg|*.webp|*.sqlite3) continue ;; esac
    # apply size threshold
    local sz; sz="$(wc -c < "${f}" 2>/dev/null | tr -d ' ')"
    [[ -z "${sz}" || "${sz}" -lt "${compress_min}" ]] && continue
    if command -v gzip >/dev/null 2>&1; then
      gzip -9 -- "${f}" 2>/dev/null && log_info "gzipped ${rel} (${sz} → $(wc -c < "${f}.gz" 2>/dev/null | tr -d ' ') bytes)"
    fi
  done < <(find "${OUTPUT_DIR}" -maxdepth 2 -type f -print0 2>/dev/null)

  # Honour KEEP_RAW_* flags by deleting the gzip if user opts out.
  [[ "${keep_vulns}" != "1" ]] && rm -f -- "${OUTPUT_DIR}/vulnerabilities.jsonl.gz" 2>/dev/null || true
  [[ "${keep_wb}"    != "1" ]] && rm -f -- "${OUTPUT_DIR}/wayback_urls_raw.txt.gz"   2>/dev/null || true

  # ---------------------------------------------------------------------------
  # 4. Build a small, human-readable summary + machine-readable digest.
  # ---------------------------------------------------------------------------
  _build_summary "${OUTPUT_DIR}"

  # ---------------------------------------------------------------------------
  # 5. Retention — keep only the newest RETENTION_KEEP dirs per target prefix.
  # ---------------------------------------------------------------------------
  local results_root; results_root="$(dirname "${OUTPUT_DIR}")"
  local current_dir;  current_dir="$(basename "${OUTPUT_DIR}")"
  local prefix="${current_dir%_*_*}"   # strip _YYYYMMDD_HHMMSS suffix

  if [[ -n "${prefix}" && -d "${results_root}" && "${retention_keep}" =~ ^[0-9]+$ ]]; then
    local total
    total="$(find "${results_root}" -maxdepth 1 -type d -name "${prefix}_*" 2>/dev/null | wc -l | tr -d ' ')"
    if (( total > retention_keep )); then
      local prune=$(( total - retention_keep ))
      log_info "Retention: keeping last ${retention_keep} of ${total} ${prefix} scans (pruning ${prune})"
      find "${results_root}" -maxdepth 1 -type d -name "${prefix}_*" -printf '%T@ %p\n' 2>/dev/null \
        | sort -n | head -n "${prune}" | awk '{ $1=""; sub(/^ /,""); print }' \
        | while IFS= read -r old; do
            [[ -n "${old}" && "${old}" != "${OUTPUT_DIR}" ]] && rm -rf -- "${old}" 2>/dev/null && log_info "Pruned ${old}"
          done
    fi
  fi

  if command -v du >/dev/null 2>&1; then
    after_kb="$(du -sk "${OUTPUT_DIR}" 2>/dev/null | awk '{print $1}')"
    local saved_kb=$(( before_kb - after_kb ))
    (( saved_kb < 0 )) && saved_kb=0
    log_success "Cleanup done: $((after_kb / 1024)) MB (saved $((saved_kb / 1024)) MB)"
  fi
}

# ---------------------------------------------------------------------------
# _build_summary <output_dir>
# Emits ${OUTPUT_DIR}/summary.txt and summary.json — the canonical small
# artefact for fast review on disk-constrained boxes.
# ---------------------------------------------------------------------------
_build_summary() {
  local d="$1"
  local sr="${d}/scan_results.json"
  local txt="${d}/summary.txt"
  local js="${d}/summary.json"

  if ! command -v jq >/dev/null 2>&1 || [[ ! -s "${sr}" ]]; then
    return 0
  fi

  # Counts
  local subs live svc_total vuln_total
  subs="$(jq -r '[.[] | .subdomains // [] | length] | add // 0' "${sr}" 2>/dev/null || echo 0)"
  live="$(jq -r '[.[] | .live_services // [] | length] | add // 0' "${sr}" 2>/dev/null || echo 0)"
  vuln_total="$(jq -r '[.[] | .vulnerability_objects // [] | length] | add // 0' "${sr}" 2>/dev/null || echo 0)"
  svc_total="${live}"

  # Severity histogram
  local sev_json
  sev_json="$(jq -c '
    [.[] | .vulnerability_objects // [] | .[] | (.info.severity // .severity // "info" | ascii_downcase)]
    | reduce .[] as $s ({}; .[$s] = ((.[$s] // 0) + 1))
  ' "${sr}" 2>/dev/null || echo '{}')"

  # Top 10 templates by frequency
  local top_json
  top_json="$(jq -c '
    [.[] | .vulnerability_objects // [] | .[] | (."template-id" // .template_id // "unknown")]
    | reduce .[] as $t ({}; .[$t] = ((.[$t] // 0) + 1))
    | to_entries | sort_by(-.value) | .[0:10]
  ' "${sr}" 2>/dev/null || echo '[]')"

  # Optional artefact counts (graceful if file missing)
  local _count
  _count() { [[ -s "$1" ]] && wc -l < "$1" | tr -d ' ' || echo 0; }
  local secrets_n endpoints_n discovered_n cors_n takeover_n wayback_n
  secrets_n="$(_count "${d}/secrets.txt")"
  endpoints_n="$(_count "${d}/endpoints.txt")"
  discovered_n="$(_count "${d}/discovered_directories.txt")"
  cors_n="$(_count "${d}/cors_findings.txt")"
  takeover_n="$(_count "${d}/takeover_findings.txt")"
  wayback_n="$(_count "${d}/wayback_urls_live.txt")"

  # Machine-readable summary
  jq -n \
    --arg target  "${TARGET_DOMAIN:-unknown}" \
    --arg profile "${SCAN_PROFILE:-standard}" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson subs "${subs}" --argjson live "${live}" \
    --argjson vulns "${vuln_total}" \
    --argjson severity "${sev_json}" \
    --argjson top_templates "${top_json}" \
    --argjson secrets "${secrets_n}" --argjson endpoints "${endpoints_n}" \
    --argjson discovered "${discovered_n}" --argjson cors "${cors_n}" \
    --argjson takeover "${takeover_n}" --argjson wayback_live "${wayback_n}" \
    '{
      target: $target,
      profile: $profile,
      generated_at: $generated_at,
      counts: {
        subdomains: $subs,
        live_services: $live,
        vulnerabilities: $vulns,
        secrets: $secrets,
        endpoints: $endpoints,
        discovered_paths: $discovered,
        cors_findings: $cors,
        takeover_findings: $takeover,
        wayback_live_urls: $wayback_live
      },
      severity: $severity,
      top_templates: $top_templates
    }' > "${js}" 2>/dev/null || return 0

  # Human-readable summary
  {
    echo "Fik scan summary"
    echo "================"
    echo "Target  : ${TARGET_DOMAIN:-unknown}"
    echo "Profile : ${SCAN_PROFILE:-standard}"
    echo "Time    : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    echo "Counts"
    echo "------"
    printf "  subdomains       : %s\n" "${subs}"
    printf "  live services    : %s\n" "${live}"
    printf "  vulnerabilities  : %s\n" "${vuln_total}"
    printf "  secrets          : %s\n" "${secrets_n}"
    printf "  endpoints        : %s\n" "${endpoints_n}"
    printf "  discovered paths : %s\n" "${discovered_n}"
    printf "  cors findings    : %s\n" "${cors_n}"
    printf "  takeover findings: %s\n" "${takeover_n}"
    printf "  wayback live URLs: %s\n" "${wayback_n}"
    echo
    echo "Severity histogram"
    echo "------------------"
    echo "${sev_json}" | jq -r 'to_entries | sort_by(-.value) | .[] | "  \(.key): \(.value)"' 2>/dev/null
    echo
    echo "Top templates"
    echo "-------------"
    echo "${top_json}" | jq -r '.[] | "  \(.value)\t\(.key)"' 2>/dev/null
  } > "${txt}" 2>/dev/null || true

  log_success "summary.json + summary.txt written"
}
