#!/usr/bin/env bash

# Strict mode configuration
set -euo pipefail
IFS=$'\n\t'

# Constants
readonly REPO="hyperlane-xyz/hyperlane-starknet"
readonly GITHUB_RELEASES_API="https://api.github.com/repos/${REPO}/releases"
readonly TARGET_DIR="./release"
readonly VERSION="v0.3.2"

# Color definitions
declare -r COLOR_GREEN='\033[0;32m'
declare -r COLOR_RED='\033[0;31m'
declare -r COLOR_RESET='\033[0m'

log_error() {
    echo -e "${COLOR_RED}Error: $1${COLOR_RESET}" >&2
}

log_success() {
    echo -e "${COLOR_GREEN}$1${COLOR_RESET}"
}

check_dependencies() {
    local -r required_tools=("curl" "jq" "unzip")
    
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "$tool is not installed"
            exit 1
        fi
    done
}

check_if_contracts_exist() {
    if [[ -d "$TARGET_DIR" ]] && [[ "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
        log_success "Contracts already present in $TARGET_DIR, skipping fetch"
        return 0
    fi
    return 1
}

verify_version_exists() {
    local version=$1
    if ! curl --output /dev/null --silent --head --fail "${GITHUB_RELEASES_API}/tags/${version}"; then
        log_error "Version ${version} does not exist"
        exit 1
    fi
}

get_release_info() {
    local version=$1
    local release_info
    
    release_info=$(curl -sf "${GITHUB_RELEASES_API}/tags/${version}") || {
        log_error "Failed to fetch release information for version ${version}"
        exit 1
    }
    echo "$release_info"
}

download_and_extract() {
    local version=$1
    local download_url=$2
    local base_url="${download_url%/*}"
    local filename="${download_url##*/}"
    
    if ! mkdir -p "$TARGET_DIR"; then
        log_error "Failed to create target directory"
        exit 1
    fi

    log_success "Downloading version ${version} from ${download_url}"
    
    if ! curl -L "$download_url" -o "${TARGET_DIR}/release.zip"; then
        log_error "Download failed"
        exit 1
    fi

    if ! verify_checksum "${TARGET_DIR}/release.zip" "$base_url" "$filename"; then
        rm -f "${TARGET_DIR}/release.zip"
        exit 1
    fi
    
    if ! unzip -o "${TARGET_DIR}/release.zip" -d "${TARGET_DIR}"; then
        log_error "Extraction failed"
        exit 1
    fi
}

verify_checksum() {
    local file_path="$1"
    local base_url="$2"
    local filename="$3"
    local checksum_filename
    checksum_filename="${filename%.zip}.CHECKSUM"
    
    local downloaded_checksum
    downloaded_checksum="$(sha256sum "$file_path" | cut -d' ' -f1)"
    log_success "File checksum: ${downloaded_checksum}"
    
    local expected_checksum
    if ! expected_checksum="$(curl -sL "${base_url}/${checksum_filename}")"; then
        log_error "Failed to fetch checksum file"
        return 1
    fi

    if [[ "${downloaded_checksum}" != "$(echo "${expected_checksum}" | awk '{print $1}')" ]]; then
        log_error "Checksum verification failed"
        return 1
    fi
    
    return 0
}

cleanup() {
    rm -f "$TARGET_DIR/release.zip"
    rm -f "$TARGET_DIR"/*.md5
    rm -f "$TARGET_DIR"/*.sha256
}

main() {
    trap cleanup EXIT
    
    check_dependencies
    
    # Skip if contracts already exist
    if check_if_contracts_exist; then
        exit 0
    fi

    log_success "Using version ${VERSION} from package.json"
    verify_version_exists "$VERSION"

    local release_info
    release_info=$(get_release_info "$VERSION")
    
    local download_url
    download_url=$(echo "$release_info" | jq -r '.assets[] | select(.name | startswith("hyperlane-starknet") and endswith(".zip")) | .browser_download_url')
    
    if [[ -z "$download_url" ]]; then
        log_error "Could not find ZIP download URL for release"
        exit 1
    fi
    
    # Process download and file checksum verification and extraction
    download_and_extract "$VERSION" "$download_url"
    
    log_success "Successfully downloaded and extracted version ${VERSION}"
}

main
