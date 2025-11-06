#!/usr/bin/env bash
# Get the latest stable agents-v* tag (excluding prereleases)
#
# Usage:
#   get-latest-agents-tag.sh
#
# Returns:
#   The latest agents-v* tag (e.g., "agents-v1.4.0"), or empty string if none found
#
set -euo pipefail

git tag -l "agents-v*" --sort=-version:refname | grep -E "^agents-v[0-9]+\.[0-9]+\.[0-9]+$" | head -1 || true
