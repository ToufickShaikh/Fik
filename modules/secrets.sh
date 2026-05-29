#!/usr/bin/env bash
# secrets.sh — Secret/credential scanning on the JS files harvested by the
# crawler and on any exposed .git directories found via wayback/crawler.
# Uses trufflehog (filesystem + git mode) and gitleaks where available.

run_secret_scan() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }

  local js_list="${OUTPUT_DIR}/js_files.txt"
  local stash_dir="${OUTPUT_DIR}/js_stash"
  local findings="${OUTPUT_DIR}/secrets.jsonl"
  local report="${OUTPUT_DIR}/secrets.txt"
  : > "${findings}"; : > "${report}"

  log_step "Secret scan"

  if [[ ! -s "${js_list}" ]]; then
    log_warn "No JS files harvested; skipping secret scan."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl missing; cannot fetch JS bundles."
    return 0
  fi

  mkdir -p "${stash_dir}"
  log_info "Downloading up to 100 JS files for offline scanning"
  local count=0
  while IFS= read -r url && (( count < 100 )); do
    [[ -z "${url}" ]] && continue
    local fname
    fname="$(echo "${url}" | md5sum | awk '{print $1}').js"
    curl -fsSL --max-time 15 --max-filesize 5000000 "${url}" \
      -o "${stash_dir}/${fname}" 2>/dev/null && count=$((count+1))
  done < "${js_list}"
  log_info "Stashed ${count} JS files in ${stash_dir}"

  if command -v trufflehog >/dev/null 2>&1; then
    run_tool "trufflehog-fs" bash -c \
      "trufflehog filesystem --no-update --json '${stash_dir}' >> '${findings}'" || true
  fi
  if command -v gitleaks >/dev/null 2>&1; then
    run_tool "gitleaks-fs" bash -c \
      "gitleaks detect --no-banner --no-git --source '${stash_dir}' \
        --report-format json --report-path '${OUTPUT_DIR}/gitleaks.json' \
        --exit-code 0 >/dev/null 2>&1; \
       [ -s '${OUTPUT_DIR}/gitleaks.json' ] && cat '${OUTPUT_DIR}/gitleaks.json' >> '${findings}' || true" || true
  fi

  if command -v jq >/dev/null 2>&1 && [[ -s "${findings}" ]]; then
    jq -r '. | "\(.DetectorName // .RuleID // .rule // "secret")\t\(.SourceMetadata.Data.Filesystem.file // .File // "?")\t\(.Raw // .Match // .secret // "")"' \
      "${findings}" 2>/dev/null > "${report}" || cp "${findings}" "${report}"
  fi

  log_success "Secrets findings: $(wc -l < "${report}" 2>/dev/null | tr -d ' ' || echo 0)"
}
