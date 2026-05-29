#!/usr/bin/env bash
# jsendpoints.sh — JavaScript endpoint mining.
# Pulls hidden API routes / parameters from JS files using subjs + katana's
# JS-crawl mode (-jc). Output feeds gf_triage and nuclei replay.

run_js_endpoints() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR is not set."; return 1; }

  local live="${OUTPUT_DIR}/live_hosts.txt"
  local js_list="${OUTPUT_DIR}/js_files.txt"
  local out_endpoints="${OUTPUT_DIR}/js_endpoints.txt"
  local out_combined="${OUTPUT_DIR}/all_urls.txt"
  : > "${out_endpoints}"

  log_step "JavaScript endpoint extraction"

  if [[ ! -s "${live}" ]] && [[ ! -s "${js_list}" ]]; then
    log_warn "No live hosts or JS files; skipping JS endpoint extraction."
    return 0
  fi

  # 1) subjs — discover additional JS URLs we may have missed.
  if command -v subjs >/dev/null 2>&1 && [[ -s "${live}" ]]; then
    run_tool "subjs" bash -c \
      "cat '${live}' | subjs >> '${js_list}'" || true
    sort -u -o "${js_list}" "${js_list}"
  fi

  # 2) katana -jc to crawl + dump endpoints referenced inside JS.
  if command -v katana >/dev/null 2>&1 && [[ -s "${js_list}" ]]; then
    run_tool "katana-jc" katana -list "${js_list}" -jc -d 2 \
      -silent -no-sandbox -f url -o "${out_endpoints}" || true
  fi

  # 3) Fallback regex extraction for path-like strings inside JS.
  if [[ -s "${js_list}" ]] && command -v curl >/dev/null 2>&1; then
    log_info "Regex-extracting endpoints from JS bundles (cap 50)"
    local count=0
    while IFS= read -r url && (( count < 50 )); do
      [[ -z "${url}" ]] && continue
      curl -fsSL --max-time 10 --max-filesize 3000000 "${url}" 2>/dev/null \
        | grep -Eo '"(\/[a-zA-Z0-9_\-./?=&%:]{3,200})"' \
        | tr -d '"' >> "${out_endpoints}" || true
      count=$((count+1))
    done < "${js_list}"
  fi

  sort -u -o "${out_endpoints}" "${out_endpoints}"

  # 4) Build all_urls.txt = endpoints ∪ js_endpoints ∪ wayback for downstream gf.
  {
    [[ -s "${OUTPUT_DIR}/endpoints.txt" ]]      && cat "${OUTPUT_DIR}/endpoints.txt"
    [[ -s "${out_endpoints}" ]]                 && cat "${out_endpoints}"
    [[ -s "${OUTPUT_DIR}/wayback_urls_raw.txt" ]] && cat "${OUTPUT_DIR}/wayback_urls_raw.txt"
  } 2>/dev/null | sed '/^[[:space:]]*$/d' | sort -u > "${out_combined}"

  log_success "JS endpoints: $(wc -l < "${out_endpoints}" | tr -d ' ') | Combined corpus: $(wc -l < "${out_combined}" | tr -d ' ')"
}
