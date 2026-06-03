#!/usr/bin/env bash
# exposed_files.sh — Aggressive hunt for hardcoded credentials, DB connection
# strings, config files, backup files, .git/.svn dirs, .env, dump files, and
# anything else that should never have been served to the public.
#
# Strategy:
#   1. ffuf a high-signal "exposed-files" wordlist against every live host.
#   2. Pattern-grep every body that came back 200/401/403 for cred-like
#      strings (DB URIs, AWS/GCP/Stripe keys, private keys, JWTs).
#   3. Run nuclei -tags exposure,config,token,credential,backup against the
#      live hosts to catch templated leaks (Spring actuator, .env, git/hg
#      configs, swagger leaks, cloud-metadata, etc.).
#   4. Append everything into vulnerabilities.jsonl so it shows up in the
#      regular report.
#
# Gated behind the `deep` profile only — it is intentionally noisy.

# Guard against double-source.
[[ -n "${_FIK_EXPOSED_FILES_SOURCED:-}" ]] && return 0
_FIK_EXPOSED_FILES_SOURCED=1

run_exposed_files_scan() {
  [[ -z "${OUTPUT_DIR:-}" ]] && { log_error "OUTPUT_DIR not set"; return 1; }

  if [[ "${SCAN_PROFILE:-standard}" != "deep" ]]; then
    log_info "exposed_files scan only runs in 'deep' profile; skipping."
    return 0
  fi

  local live="${OUTPUT_DIR}/live_hosts.txt"
  if [[ ! -s "${live}" ]]; then
    log_warn "live_hosts.txt empty; nothing to probe for exposed files."
    return 0
  fi

  local out_dir="${OUTPUT_DIR}/exposed"
  mkdir -p "${out_dir}"

  local wordlist="${OUTPUT_DIR}/exposed_wordlist.txt"
  _build_exposed_wordlist > "${wordlist}"

  local hits="${out_dir}/exposed_hits.txt"
  : > "${hits}"

  log_step "Exposed-file hunt (ffuf)"
  if ! command -v ffuf >/dev/null 2>&1; then
    log_warn "ffuf not installed; skipping ffuf phase of exposed_files."
  else
    local rl threads
    case "${SCAN_PROFILE}" in
      deep) rl="${EXPOSED_FFUF_RL:-80}";  threads="${EXPOSED_FFUF_THREADS:-30}" ;;
      *)    rl="${EXPOSED_FFUF_RL:-40}";  threads="${EXPOSED_FFUF_THREADS:-15}" ;;
    esac

    local host
    local host_index=0
    while IFS= read -r host; do
      [[ -z "${host}" ]] && continue
      host_index=$((host_index + 1))
      local safe_host
      safe_host="$(echo "${host}" | sed 's|^[^/]*//||; s|/.*$||; s|[^A-Za-z0-9._-]|_|g')"
      local jout="${out_dir}/${safe_host}.json"
      run_tool "ffuf:exposed:${safe_host}" ffuf \
        -u "${host}/FUZZ" -w "${wordlist}" \
        -mc 200,401,403 \
        -fs 0 \
        -t "${threads}" -rate "${rl}" -timeout 8 \
        -of json -o "${jout}" \
        -s 2>/dev/null || true

      # Pull URL + status + length out of ffuf json for the human-readable hit log.
      if [[ -s "${jout}" ]] && command -v jq >/dev/null 2>&1; then
        jq -r '.results[]? | "\(.status)\t\(.length)\t\(.url)"' "${jout}" 2>/dev/null >> "${hits}" || true
      fi
    done < "${live}"
  fi

  # ---------------------------------------------------------------------------
  # Body grep — fetch each hit and look for credential patterns.
  # ---------------------------------------------------------------------------
  local creds="${out_dir}/exposed_credentials.txt"
  : > "${creds}"
  if [[ -s "${hits}" ]] && command -v curl >/dev/null 2>&1; then
    log_info "Grepping ${out_dir}/*.json hits for credential patterns"
    local total_hits; total_hits="$(wc -l < "${hits}" | tr -d ' ')"
    local cap="${EXPOSED_GREP_MAX:-200}"
    (( total_hits > cap )) && { log_warn "Capping body grep at ${cap} of ${total_hits} hits"; head -n "${cap}" "${hits}" > "${hits}.cap"; mv "${hits}.cap" "${hits}"; }

    while IFS=$'\t' read -r status length url; do
      [[ -z "${url}" ]] && continue
      local body
      body="$(curl -sk --max-time 10 --max-filesize 1000000 "${url}" 2>/dev/null || true)"
      [[ -z "${body}" ]] && continue
      _grep_credentials "${url}" "${body}" >> "${creds}"
    done < "${hits}"
  fi

  # ---------------------------------------------------------------------------
  # Nuclei sweep — templated exposure / config / token leaks.
  # ---------------------------------------------------------------------------
  if command -v nuclei >/dev/null 2>&1; then
    local nfindings="${out_dir}/nuclei_exposure.jsonl"
    : > "${nfindings}"
    log_info "nuclei -tags exposure,config,token,credential,backup,leak"
    run_tool "nuclei-exposure" bash -c \
      "nuclei -silent -l '${live}' \
              -tags exposure,config,token,credential,backup,leak,disclosure \
              -severity medium,high,critical \
              -rl ${NUCLEI_RATE_LIMIT:-100} -c ${NUCLEI_CONCURRENCY:-25} \
              -jsonl -o '${nfindings}'" \
      || true

    if [[ -s "${nfindings}" ]]; then
      cat "${nfindings}" >> "${OUTPUT_DIR}/vulnerabilities.jsonl"
      log_success "Appended $(wc -l < "${nfindings}" | tr -d ' ') exposure findings to vulnerabilities.jsonl"
    fi
  fi

  local hits_n=0 creds_n=0
  [[ -s "${hits}" ]]  && hits_n="$(wc -l < "${hits}"  | tr -d ' ')"
  [[ -s "${creds}" ]] && creds_n="$(wc -l < "${creds}" | tr -d ' ')"
  log_success "Exposed-file hits: ${hits_n} | credential matches: ${creds_n}"
}

# ---------------------------------------------------------------------------
# _build_exposed_wordlist — emit the high-signal path list to stdout.
# Kept inline so the module is self-contained and never silently empty.
# ---------------------------------------------------------------------------
_build_exposed_wordlist() {
  cat <<'EOF'
.env
.env.bak
.env.old
.env.dev
.env.prod
.env.local
.env.production
.env.development
.git/config
.git/HEAD
.git/index
.gitignore
.svn/entries
.svn/wc.db
.hg/store
.DS_Store
.htaccess
.htpasswd
.bash_history
.zsh_history
.npmrc
.dockerignore
docker-compose.yml
docker-compose.yaml
Dockerfile
config.json
config.js
config.php
config.yml
config.yaml
config.xml
appsettings.json
appsettings.Development.json
web.config
WEB-INF/web.xml
META-INF/MANIFEST.MF
phpinfo.php
info.php
test.php
backup.zip
backup.tar
backup.tar.gz
backup.tgz
backup.sql
db.sql
dump.sql
database.sql
mysql.sql
postgres.sql
backup/
backups/
dump/
dumps/
old/
bak/
tmp/
admin/
admin.php
administrator/
phpmyadmin/
pma/
adminer.php
robots.txt
sitemap.xml
crossdomain.xml
clientaccesspolicy.xml
server-status
server-info
nginx_status
status
metrics
actuator
actuator/env
actuator/health
actuator/heapdump
actuator/info
actuator/mappings
actuator/configprops
actuator/beans
actuator/trace
actuator/auditevents
actuator/loggers
v1/actuator/env
api/v1/actuator/env
console
h2-console
swagger.json
swagger.yaml
swagger-ui.html
swagger-ui/
api-docs
api/v1/api-docs
openapi.json
openapi.yaml
graphql
graphiql
wp-config.php
wp-config.php.bak
wp-config.bak
wp-config.old
configuration.php
local.xml
parameters.yml
parameters.yaml
secrets.json
secrets.yml
credentials.json
credentials.yml
credentials.yaml
id_rsa
id_rsa.pub
id_dsa
authorized_keys
private.key
private.pem
server.key
server.pem
.aws/credentials
.ssh/id_rsa
core
core.dmp
heapdump.bin
hprof
yarn.lock
package-lock.json
composer.lock
.terraform.tfstate
terraform.tfstate
terraform.tfstate.backup
ansible.cfg
inventory.yml
.travis.yml
.circleci/config.yml
.github/workflows
jenkins
ci.yml
EOF
}

# ---------------------------------------------------------------------------
# _grep_credentials <url> <body>
# Emit one TSV line per detected credential: URL \t TYPE \t MATCH
# Pattern set covers common high-value leaks.
# ---------------------------------------------------------------------------
_grep_credentials() {
  local url="$1"
  local body="$2"

  _emit() { printf '%s\t%s\t%s\n' "${url}" "$1" "$2"; }

  # AWS
  echo "${body}" | grep -Eoa 'AKIA[0-9A-Z]{16}'                                  | head -3 | while read -r m; do _emit aws_access_key "${m}"; done
  echo "${body}" | grep -Eoa '(aws_secret_access_key|aws_secret)[[:space:]:=]+["'"'"']?[A-Za-z0-9/+=]{40}' | head -3 | while read -r m; do _emit aws_secret_key "${m}"; done

  # Google
  echo "${body}" | grep -Eoa 'AIza[0-9A-Za-z_\-]{35}'                            | head -3 | while read -r m; do _emit google_api_key "${m}"; done
  echo "${body}" | grep -Eoa 'ya29\.[0-9A-Za-z_\-]+'                             | head -3 | while read -r m; do _emit google_oauth "${m}"; done

  # Slack / GitHub / Stripe / Twilio / Mailgun
  echo "${body}" | grep -Eoa 'xox[abprs]-[A-Za-z0-9-]{10,}'                      | head -3 | while read -r m; do _emit slack_token "${m}"; done
  echo "${body}" | grep -Eoa 'gh[pousr]_[A-Za-z0-9]{36,}'                        | head -3 | while read -r m; do _emit github_token "${m}"; done
  echo "${body}" | grep -Eoa 'sk_live_[0-9a-zA-Z]{24,}'                          | head -3 | while read -r m; do _emit stripe_live "${m}"; done
  echo "${body}" | grep -Eoa 'rk_live_[0-9a-zA-Z]{24,}'                          | head -3 | while read -r m; do _emit stripe_restricted "${m}"; done
  echo "${body}" | grep -Eoa 'SK[0-9a-fA-F]{32}'                                 | head -3 | while read -r m; do _emit twilio_key "${m}"; done
  echo "${body}" | grep -Eoa 'key-[0-9a-zA-Z]{32}'                               | head -3 | while read -r m; do _emit mailgun_key "${m}"; done

  # JWT
  echo "${body}" | grep -Eoa 'eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}' | head -3 | while read -r m; do _emit jwt "${m}"; done

  # Private keys
  echo "${body}" | grep -Eoa '-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----' | head -1 | while read -r m; do _emit private_key "${m}"; done

  # DB connection strings (mysql, postgres, mongodb, redis, mssql, jdbc)
  echo "${body}" | grep -Eoia 'mysql://[A-Za-z0-9._%+-]+:[^@[:space:]"]+@[A-Za-z0-9._-]+(:[0-9]+)?/[A-Za-z0-9_-]+'  | head -3 | while read -r m; do _emit db_mysql "${m}"; done
  echo "${body}" | grep -Eoia 'postgres(ql)?://[A-Za-z0-9._%+-]+:[^@[:space:]"]+@[A-Za-z0-9._-]+(:[0-9]+)?/[A-Za-z0-9_-]+' | head -3 | while read -r m; do _emit db_postgres "${m}"; done
  echo "${body}" | grep -Eoia 'mongodb(\+srv)?://[A-Za-z0-9._%+-]+:[^@[:space:]"]+@[A-Za-z0-9._-]+'                  | head -3 | while read -r m; do _emit db_mongo "${m}"; done
  echo "${body}" | grep -Eoia 'redis://[A-Za-z0-9._%+-]*:[^@[:space:]"]+@[A-Za-z0-9._-]+(:[0-9]+)?'                  | head -3 | while read -r m; do _emit db_redis "${m}"; done
  echo "${body}" | grep -Eoia 'jdbc:[a-z]+://[A-Za-z0-9._-]+(:[0-9]+)?/[A-Za-z0-9_?=&;-]+'                          | head -3 | while read -r m; do _emit db_jdbc "${m}"; done
  echo "${body}" | grep -Eoia 'mssql://[A-Za-z0-9._%+-]+:[^@[:space:]"]+@[A-Za-z0-9._-]+'                            | head -3 | while read -r m; do _emit db_mssql "${m}"; done

  # Generic hardcoded credentials (key=value style, conservative)
  echo "${body}" | grep -Eoia '(password|passwd|pwd|api_?key|access_?token|secret|client_?secret)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"' ]{6,}["'"'"']' | head -3 | while read -r m; do _emit generic_secret "${m}"; done
}
