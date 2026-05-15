#!/usr/bin/env bash
# Fik — automated bug bounty framework.
# Strict mode: -e aborts on uncaught errors, -o pipefail propagates pipe failures.
# Note: -u is intentionally omitted so optional env-vars (e.g. NUCLEI_RATE_LIMIT) can be left unset.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES_DIR="${SCRIPT_DIR}/modules"
RESULTS_DIR="${SCRIPT_DIR}/results"

# Source the shared library FIRST so logging/run_tool are available everywhere.
# shellcheck source=modules/_lib.sh
source "${MODULES_DIR}/_lib.sh"

TARGET_DOMAIN=""
OUTPUT_DIR=""
# SCAN_PROFILE can be set via env (from the GUI/backend) or overridden with -p.
# Valid values: quick | standard | deep  (Step 3 wires these to tool flags).
SCAN_PROFILE="${SCAN_PROFILE:-standard}"

# Cleanup trap: removes registered temp paths on any exit (success, error, or
# manual abort via Ctrl-C). cleanup_tempfiles is defined in modules/_lib.sh.
_fik_on_exit() {
  local rc=$?
  cleanup_tempfiles
  if (( rc != 0 )); then
    log_error "Fik exited with code ${rc}."
  fi
  exit ${rc}
}
trap _fik_on_exit EXIT
trap 'log_warn "Interrupted by user."; exit 130' INT TERM

print_help() {
  cat <<'EOF'
Usage: ./main.sh -d <domain>

Options:
  -d <domain>   Target domain for reconnaissance (required)
  -h            Show this help message
EOF
}

source_module() {
  local module_file="$1"
  local module_path="${MODULES_DIR}/${module_file}"

  if [[ ! -f "${module_path}" ]]; then
    log_warn "Module not found, skipping source: ${module_file}"
    return 0
  fi

  log_info "Sourcing module: ${module_file}"
  # shellcheck source=/dev/null
  source "${module_path}"
}

run_module_function() {
  local function_name="$1"

  if declare -F "${function_name}" >/dev/null 2>&1; then
    log_step "Running ${function_name}"
    # Module functions may legitimately return non-zero on partial failure;
    # we never want one module to abort the whole pipeline.
    set +e
    "${function_name}"
    local rc=$?
    set -e
    if (( rc != 0 )); then
      log_warn "${function_name} returned ${rc}. Continuing with next module."
    fi
  else
    log_warn "Function not found, skipping: ${function_name}"
  fi
}

while getopts ":d:p:h" opt; do
  case "${opt}" in
    d)
      TARGET_DOMAIN="${OPTARG}"
      ;;
    p)
      SCAN_PROFILE="${OPTARG}"
      ;;
      ;;
    h)
      print_help
      exit 0
      ;;
    :)
      log_error "Option -${OPTARG} requires an argument."
      print_help
      exit 1
      ;;
    \?)
      log_error "Invalid option: -${OPTARG}"
      print_help
      exit 1
      ;;
  esac
done

if [[ -z "${TARGET_DOMAIN}" ]]; then
  log_error "Domain is required. Use -d <domain>."
  print_help
  exit 1
fi

timestamp="$(date +%Y%m%d_%H%M%S)"
safe_domain="${TARGET_DOMAIN//[^a-zA-Z0-9._-]/_}"
OUTPUT_DIR="${RESULTS_DIR}/${safe_domain}_${timestamp}"
mkdir -p "${OUTPUT_DIR}"

export TARGET_DOMAIN OUTPUT_DIR SCAN_PROFILE

log_step "Fik bug-bounty framework starting"
log_info "Target domain : ${TARGET_DOMAIN}"
log_info "Scan profile  : ${SCAN_PROFILE}"
log_info "Output folder : ${OUTPUT_DIR}"

MODULE_FILES=(
  "self_healing.sh"
  "install_tools.sh"
  "subdomains.sh"
  "portscan.sh"
  "crawler.sh"
  "fuzzer.sh"
  "tech_detector.sh"
  "vulnscan.sh"
  "exporter.sh"
)

MODULE_FUNCTIONS=(
  "run_subdomain_enumeration"
  "run_port_scan"
  "run_crawler"
  "run_fuzzer"
  "detect_technologies"
  "run_vulnerability_scan"
  "export_to_json"
)

for module_file in "${MODULE_FILES[@]}"; do
  source_module "${module_file}"
done

if declare -F ensure_required_tools >/dev/null 2>&1; then
  log_step "Verifying required tools (self-healing dependency check)"
  if ! ensure_required_tools; then
    log_error "One or more required tools are missing and could not be installed. Aborting."
    exit 1
  fi
else
  log_warn "ensure_required_tools function not available; continuing without dependency check."
fi

for module_function in "${MODULE_FUNCTIONS[@]}"; do
  run_module_function "${module_function}"
done

SCAN_RESULTS_JSON="${OUTPUT_DIR}/scan_results.json"
INGEST_URL="${INGEST_URL:-http://localhost:3000/api/ingest}"

if [[ -f "${SCAN_RESULTS_JSON}" ]]; then
  if declare -F upload_results >/dev/null 2>&1; then
    log_step "Uploading scan results to backend"
    log_info "File   : ${SCAN_RESULTS_JSON}"
    log_info "Target : ${INGEST_URL}"
    set +e
    upload_results "${SCAN_RESULTS_JSON}" "${INGEST_URL}"
    upload_rc=$?
    set -e
    if (( upload_rc != 0 )); then
      log_warn "Upload to backend failed (rc=${upload_rc}). Local results preserved at ${SCAN_RESULTS_JSON}"
    fi
  else
    log_warn "upload_results function not available; skipping backend upload."
  fi
else
  log_warn "scan_results.json not found at ${SCAN_RESULTS_JSON}; skipping upload."
fi

log_step "All enabled modules completed"
log_success "Results available in ${OUTPUT_DIR}"
