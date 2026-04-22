#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES_DIR="${SCRIPT_DIR}/modules"
RESULTS_DIR="${SCRIPT_DIR}/results"

TARGET_DOMAIN=""
OUTPUT_DIR=""

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
		echo "[WARN] Module not found, skipping source: ${module_file}"
		return 0
	fi

	echo "[MODULE] Sourcing ${module_file}"
	# shellcheck source=/dev/null
	source "${module_path}"
}

run_module_function() {
	local function_name="$1"

	if declare -F "${function_name}" >/dev/null 2>&1; then
		echo "[RUN] Executing ${function_name}"
		"${function_name}"
	else
		echo "[WARN] Function not found, skipping: ${function_name}"
	fi
}

while getopts ":d:h" opt; do
	case "${opt}" in
		d)
			TARGET_DOMAIN="${OPTARG}"
			;;
		h)
			print_help
			exit 0
			;;
		:)
			echo "[ERROR] Option -${OPTARG} requires an argument."
			print_help
			exit 1
			;;
		\?)
			echo "[ERROR] Invalid option: -${OPTARG}"
			print_help
			exit 1
			;;
	esac
done

if [[ -z "${TARGET_DOMAIN}" ]]; then
	echo "[ERROR] Domain is required. Use -d <domain>."
	print_help
	exit 1
fi

timestamp="$(date +%Y%m%d_%H%M%S)"
safe_domain="${TARGET_DOMAIN//[^a-zA-Z0-9._-]/_}"
OUTPUT_DIR="${RESULTS_DIR}/${safe_domain}_${timestamp}"
mkdir -p "${OUTPUT_DIR}"

export TARGET_DOMAIN OUTPUT_DIR

echo "=============================================================="
echo "[START] Bug bounty automation starting"
echo "[INFO] Target domain : ${TARGET_DOMAIN}"
echo "[INFO] Output folder : ${OUTPUT_DIR}"
echo "=============================================================="

MODULE_FILES=(
	"subdomains.sh"
	"portscan.sh"
	"crawler.sh"
	"fuzzer.sh"
	"vulnscan.sh"
	"exporter.sh"
)

MODULE_FUNCTIONS=(
	"run_subdomain_enumeration"
	"run_port_scan"
	"run_crawler"
	"run_fuzzer"
	"run_vulnerability_scan"
	"export_to_json"
)

for module_file in "${MODULE_FILES[@]}"; do
	source_module "${module_file}"
done

for module_function in "${MODULE_FUNCTIONS[@]}"; do
	run_module_function "${module_function}"
done

echo "=============================================================="
echo "[DONE] All enabled modules completed"
echo "[INFO] Results available in ${OUTPUT_DIR}"
echo "=============================================================="
