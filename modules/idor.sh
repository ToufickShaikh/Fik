#!/usr/bin/env bash
# idor.sh — Insecure Direct Object Reference (IDOR) hunter.
#
# Strategy:
#   1. Collect every parameterised URL from the existing corpora.
#   2. Keep only params that look like object IDs (id, uid, user, account,
#      order, invoice, doc, file, page, item, ref, num, no, key, hash, ...).
#   3. For each URL with such a param, request the original value AND a
#      mutated value (id-1, id+1, 0, 1, 9999). Diff the response sizes and
#      status codes. Any case where the mutated value returns a 200 of
#      comparable size (and the param really *is* a numeric id) is flagged
#      as a candidate IDOR — the operator must confirm by manual review.
#   4. Also run nuclei -tags idor against the same URL list to catch the
#      template-known cases.
#
# Authorisation: gated behind `deep` profile only. (Sending an extra GET
# with a different ID value is not normally considered an attack, but if
# you want to disable it entirely set IDOR_OK=0.)

[[ -n "${_FIK_IDOR_SOURCED:-}" ]] && return 0
_FIK_IDOR_SOURCED=1

run_idor_scan() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }

  if [[ "${SCAN_PROFILE:-standard}" != "deep" ]]; then
    log_info "idor scan only runs in 'deep' profile; skipping."
    return 0
  fi
  if [[ "${IDOR_OK:-1}" != "1" ]]; then
    log_warn "IDOR_OK=0 set; skipping IDOR module."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl missing; IDOR scan disabled."
    return 0
  fi

  local out_dir="${OUTPUT_DIR}/idor"
  mkdir -p "${out_dir}"

  local candidates="${out_dir}/idor_candidates.txt"
  _build_idor_candidates > "${candidates}"
  local n; n="$(wc -l < "${candidates}" | tr -d ' ')"

  log_step "IDOR probe on ${n} candidate URLs"
  if (( n == 0 )); then
    log_warn "No IDOR-style URLs to probe; module done."
    return 0
  fi

  local cap="${IDOR_MAX_URLS:-500}"
  (( n > cap )) && { log_warn "Capping IDOR targets to ${cap} of ${n} (IDOR_MAX_URLS)"; head -n "${cap}" "${candidates}" > "${candidates}.cap"; mv "${candidates}.cap" "${candidates}"; n=${cap}; }

  local hits="${out_dir}/idor_hits.txt"
  : > "${hits}"

  local url
  while IFS= read -r url; do
    [[ -z "${url}" ]] && continue
    _probe_one_idor "${url}" >> "${hits}"
  done < "${candidates}"

  local hit_n; hit_n="$(wc -l < "${hits}" | tr -d ' ')"
  log_info "IDOR candidate responses: ${hit_n} (review ${hits} manually)"

  # nuclei -tags idor on the same candidates.
  if command -v nuclei >/dev/null 2>&1; then
    local nfindings="${out_dir}/nuclei_idor.jsonl"
    run_tool "nuclei-idor" bash -c \
      "nuclei -silent -l '${candidates}' \
              -tags idor,authorization,access-control \
              -severity medium,high,critical \
              -rl ${NUCLEI_RATE_LIMIT:-100} -c ${NUCLEI_CONCURRENCY:-25} \
              -jsonl -o '${nfindings}'" \
      || true
    if [[ -s "${nfindings}" ]]; then
      cat "${nfindings}" >> "${OUTPUT_DIR}/vulnerabilities.jsonl"
      log_success "nuclei IDOR findings appended: $(wc -l < "${nfindings}" | tr -d ' ')"
    fi
  fi

  log_success "IDOR module done."
}

_build_idor_candidates() {
  local sources=(
    "${OUTPUT_DIR}/endpoints.txt"
    "${OUTPUT_DIR}/wayback_urls_raw.txt"
    "${OUTPUT_DIR}/wayback_urls_live.txt"
    "${OUTPUT_DIR}/js_endpoints.txt"
    "${OUTPUT_DIR}/paramspider.txt"
  )
  local f
  {
    for f in "${sources[@]}"; do
      [[ -s "${f}" ]] && cat "${f}"
    done
  } | grep -Ei '[?&](id|uid|userid|user_id|account|account_id|order|order_id|invoice|invoice_id|doc|doc_id|file|file_id|page|page_id|item|item_id|ref|num|no|key|hash|token|profile|profile_id|customer|customer_id|emp|employee_id|record|record_id)=[A-Za-z0-9._%-]+' \
    | grep -vE '\.(png|jpg|jpeg|gif|webp|svg|css|js|woff2?|ttf|eot|ico|mp4|webm|pdf)(\?|$)' \
    | sort -u
}

# ---------------------------------------------------------------------------
# _probe_one_idor <url>
# Find every ?key=value with a numeric value, mutate value by +/-1 and a few
# extremes, compare response. Emit one TSV per anomalous response.
# ---------------------------------------------------------------------------
_probe_one_idor() {
  local url="$1"

  # Snapshot the original.
  local orig_status orig_size
  read -r orig_status orig_size <<<"$(curl -sk --max-time 10 -L -o /dev/null -w '%{http_code} %{size_download}' "${url}" 2>/dev/null || echo '0 0')"
  [[ "${orig_status}" == "0" ]] && return 0
  # Only consider URLs that came back 200/302/401/403 as a useful baseline.
  case "${orig_status}" in 200|302|401|403) ;; *) return 0 ;; esac

  # For each numeric param in the URL, try a handful of mutations.
  local base_url="${url%%\?*}"
  local query="${url#*\?}"
  [[ "${query}" == "${url}" ]] && return 0

  local IFS='&'
  local -a pairs
  read -r -a pairs <<<"${query}"
  unset IFS

  local i
  for ((i = 0; i < ${#pairs[@]}; i++)); do
    local pair="${pairs[i]}"
    local k="${pair%%=*}"
    local v="${pair#*=}"
    # Only mutate numeric IDs.
    [[ ! "${v}" =~ ^[0-9]+$ ]] && continue

    local mutations=( "$(( v - 1 ))" "$(( v + 1 ))" "0" "1" "9999" )
    local m
    for m in "${mutations[@]}"; do
      [[ "${m}" == "${v}" ]] && continue
      [[ "${m}" -lt 0 ]] && continue
      local new_pairs=( "${pairs[@]}" )
      new_pairs[i]="${k}=${m}"
      local new_query
      new_query="$(IFS='&'; printf '%s' "${new_pairs[*]}")"
      local probe_url="${base_url}?${new_query}"

      local p_status p_size
      read -r p_status p_size <<<"$(curl -sk --max-time 10 -L -o /dev/null -w '%{http_code} %{size_download}' "${probe_url}" 2>/dev/null || echo '0 0')"
      [[ "${p_status}" == "200" ]] || continue
      # Heuristic: response size is within 30% of original AND original was 200.
      if [[ "${orig_status}" == "200" ]]; then
        local diff
        diff=$(( p_size > orig_size ? p_size - orig_size : orig_size - p_size ))
        local thresh=$(( orig_size / 3 + 1 ))
        if (( diff <= thresh )); then
          printf '%s\t%s\t%s\torig=%s/%s\tprobe=%s/%s\n' \
            "${probe_url}" "${k}" "${m}" \
            "${orig_status}" "${orig_size}" \
            "${p_status}" "${p_size}"
        fi
      fi
    done
  done
}
