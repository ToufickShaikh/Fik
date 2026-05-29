#!/usr/bin/env bash
# notify.sh — Webhook notifier for HIGH/CRITICAL findings.
# Honours NOTIFY_WEBHOOK_URL (Slack-/Discord-compatible JSON payload) and
# NOTIFY_WEBHOOK_TYPE = slack | discord | telegram.
# When `notify` binary (ProjectDiscovery) is present, prefers it.

run_notifications() {
  if [[ -z "${NOTIFY_WEBHOOK_URL:-}" ]]; then
    log_info "NOTIFY_WEBHOOK_URL not set; skipping notifications."
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "jq missing; cannot build notification payload."
    return 0
  fi

  local kind="${NOTIFY_WEBHOOK_TYPE:-slack}"
  # Prefer the diff if produced; otherwise full vulnerabilities.jsonl
  local source_file="${OUTPUT_DIR}/diff_new_vulnerabilities.jsonl"
  [[ -s "${source_file}" ]] || source_file="${OUTPUT_DIR}/vulnerabilities.jsonl"

  if [[ ! -s "${source_file}" ]]; then
    log_info "No vulnerability JSONL to notify on."
    return 0
  fi

  # Filter HIGH/CRITICAL only
  local hi_jsonl="${OUTPUT_DIR}/notify_payload.jsonl"
  jq -c 'select((.info.severity // .severity // "") | ascii_downcase | test("high|critical"))' \
    "${source_file}" > "${hi_jsonl}" 2>/dev/null || : > "${hi_jsonl}"

  local count
  count="$(wc -l < "${hi_jsonl}" | tr -d ' ')"
  if (( count == 0 )); then
    log_info "No HIGH/CRITICAL findings; nothing to notify."
    return 0
  fi

  log_step "Notifying ${count} HIGH/CRITICAL findings via ${kind} webhook"

  # Build a single message (truncated to 25 findings to stay under limits).
  local body
  body="$(jq -rs --arg target "${TARGET_DOMAIN}" --arg out "${OUTPUT_DIR}" '
    "*Fik scan — \($target)*\nNew HIGH/CRITICAL findings: \(length)\nResults: \($out)\n\n" +
    ([.[0:25][] |
      "• [\((.info.severity // .severity // "?") | ascii_upcase)] \((.info.name // .template_id // ."template-id" // "finding")) — \(.host // ."matched-at" // .matched_at // "?")"
    ] | join("\n"))
  ' "${hi_jsonl}")"

  local payload
  case "${kind}" in
    slack|discord)
      payload="$(jq -n --arg text "${body}" '{text:$text}')"
      ;;
    telegram)
      # NOTIFY_WEBHOOK_URL must be: https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
      payload="$(jq -n --arg text "${body}" '{text:$text, parse_mode:"Markdown"}')"
      ;;
    *)
      payload="$(jq -n --arg text "${body}" '{text:$text}')"
      ;;
  esac

  if command -v notify >/dev/null 2>&1 && [[ -n "${PD_NOTIFY_PROVIDER_CONFIG:-}" ]]; then
    echo "${body}" | run_tool "notify" notify -bulk -silent || true
  else
    if command -v curl >/dev/null 2>&1; then
      run_tool "webhook" curl -sk -m 15 -X POST \
        -H "Content-Type: application/json" \
        -d "${payload}" "${NOTIFY_WEBHOOK_URL}" -o /dev/null || true
    else
      log_warn "curl missing; cannot POST webhook."
    fi
  fi

  log_success "Notification dispatched."
}
