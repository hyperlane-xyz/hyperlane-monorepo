#!/usr/bin/env bash
# Script to generate workspace-grouped changelog for rust agents
#
# Usage:
#   generate-workspace-changelog.sh [COMMIT_RANGE] [WORKSPACE_FILTER] [FLAGS]
#
# Arguments:
#   COMMIT_RANGE      - Git commit range (e.g., "v1.4.0..HEAD"). Defaults to latest tag..HEAD
#   WORKSPACE_FILTER  - Optional comma-separated list of workspaces to include (e.g., "agents/relayer,agents/validator")
#                       If omitted, all workspaces are included
#
# Flags:
#   --no-header                      - Omit the "## What's Changed" header (useful for composing changelogs)
#   --write-to-workspace VERSION - Update CHANGELOG.md files in each workspace directory
#
# Examples:
#   ./generate-workspace-changelog.sh                           # All workspaces, latest tag..HEAD
#   ./generate-workspace-changelog.sh "v1.4.0..v1.5.0"          # All workspaces, specific range
#   ./generate-workspace-changelog.sh "v1.4.0..v1.5.0" "agents/relayer"   # Single workspace
#   ./generate-workspace-changelog.sh "v1.4.0..v1.5.0" "agents/relayer,agents/validator"   # Multiple workspaces
#   ./generate-workspace-changelog.sh "v1.4.0..v1.5.0" "agents/relayer" --no-header  # No header
#   ./generate-workspace-changelog.sh "v1.4.0..v1.5.0" "" --write-to-workspace "1.5.0"  # Update workspace CHANGELOGs
#
set -euo pipefail

# Determine script directory and repo structure
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_MAIN_DIR="$SCRIPT_DIR/../main"

# Parse arguments
COMMIT_RANGE=""
WORKSPACE_FILTER=""
SHOW_HEADER=true
UPDATE_CHANGELOGS=false
VERSION=""

# Parse all arguments
i=1
while [ $i -le $# ]; do
    arg="${!i}"

    if [ "$arg" = "--no-header" ]; then
        SHOW_HEADER=false
    elif [ "$arg" = "--write-to-workspace" ]; then
        UPDATE_CHANGELOGS=true
        # Get next argument as version
        i=$((i + 1))
        if [ $i -le $# ]; then
            VERSION="${!i}"
        else
            echo "Error: --write-to-workspace requires a VERSION argument" >&2
            exit 1
        fi
    elif [ -z "$COMMIT_RANGE" ]; then
        COMMIT_RANGE="$arg"
    elif [ -z "$WORKSPACE_FILTER" ]; then
        WORKSPACE_FILTER="$arg"
    fi

    i=$((i + 1))
done

# Get the commit range
if [ -z "$COMMIT_RANGE" ]; then
    # No commit range specified - use unreleased commits
    LATEST_TAG=$(git tag -l "agents-v*" --sort=-version:refname | grep -E "^agents-v[0-9]+\.[0-9]+\.[0-9]+$" | head -1 || echo "")
    if [ -z "$LATEST_TAG" ]; then
        COMMIT_RANGE="HEAD"
    else
        COMMIT_RANGE="${LATEST_TAG}..HEAD"
    fi
fi

# Parse workspace filter into array
if [ -n "$WORKSPACE_FILTER" ]; then
    IFS=',' read -ra FILTER_ARRAY <<< "$WORKSPACE_FILTER"
else
    FILTER_ARRAY=()
fi

# Temporary directory for categorization
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Extract workspace members from rust/main/Cargo.toml
WORKSPACE_MEMBERS=$(grep -A 100 '^\[workspace\]' "$RUST_MAIN_DIR/Cargo.toml" | sed -n '/^members = \[/,/^\]/p' | grep '"' | sed 's/[", ]//g')

# Helper function to check if a workspace should be included
should_include_workspace() {
    local workspace="$1"

    # If no filter specified, include all
    if [ ${#FILTER_ARRAY[@]} -eq 0 ]; then
        return 0
    fi

    # Check if workspace is in filter list
    for filter in "${FILTER_ARRAY[@]}"; do
        if [ "$workspace" = "$filter" ]; then
            return 0
        fi
    done

    return 1
}

# Get all commits in the range (filter to rust/main directory)
git log --no-merges --format="%H" $COMMIT_RANGE -- rust/main | while read -r commit_hash; do
    # Get commit message
    commit_msg=$(git log -1 --format="%s" "$commit_hash")

    # Get files changed in this commit (within rust/main)
    files=$(git diff-tree --no-commit-id --name-only -r "$commit_hash" -- rust/main)

    # Categorize based on workspace membership
    workspace=""
    for file in $files; do
        # Strip rust/main/ prefix if present
        file=$(echo "$file" | sed 's|^rust/main/||')

        # Check which workspace this file belongs to
        for member in $WORKSPACE_MEMBERS; do
            if [[ "$file" =~ ^"$member"(/|$) ]]; then
                workspace="$member"
                break 2  # Break both loops
            fi
        done
    done

    # Default to "other" if no workspace found
    if [ -z "$workspace" ]; then
        workspace="other"
    fi

    # Sanitize workspace name for file system (replace / with __)
    workspace_file=$(echo "$workspace" | tr '/' '_')

    # Store commit in workspace category file (just message, PR# already in message)
    echo "$commit_msg" >> "$TEMP_DIR/$workspace_file"
done

# Function to generate changelog for a specific workspace
generate_workspace_changelog() {
    local workspace="$1"
    local include_header="${2:-true}"  # Default to including header
    local workspace_file=$(echo "$workspace" | tr '/' '_')

    if [ -f "$TEMP_DIR/$workspace_file" ]; then
        if [ "$include_header" = "true" ]; then
            echo "### $workspace"
            echo ""
        fi
        sort -u "$TEMP_DIR/$workspace_file" | while read -r msg; do
            echo "* $msg"
        done
    fi
}

# If updating workspace changelogs, update files and exit
if [ "$UPDATE_CHANGELOGS" = true ]; then
    if [ -z "$VERSION" ]; then
        echo "Error: VERSION is required for --write-to-workspace" >&2
        exit 1
    fi

    echo "Updating workspace CHANGELOG.md files for version $VERSION..."
    UPDATED_COUNT=0

    for workspace in $WORKSPACE_MEMBERS; do
        # Skip if workspace is filtered out
        if ! should_include_workspace "$workspace"; then
            continue
        fi

        workspace_file=$(echo "$workspace" | tr '/' '_')

        # Skip if no changes for this workspace
        if [ ! -f "$TEMP_DIR/$workspace_file" ]; then
            continue
        fi

        # Generate changelog content for this workspace (no header)
        WORKSPACE_CHANGELOG=$(generate_workspace_changelog "$workspace" false)

        if [ -z "$WORKSPACE_CHANGELOG" ]; then
            continue
        fi

        WORKSPACE_CHANGELOG_FILE="$RUST_MAIN_DIR/$workspace/CHANGELOG.md"
        WORKSPACE_DIR=$(dirname "$WORKSPACE_CHANGELOG_FILE")

        # Ensure directory exists
        mkdir -p "$WORKSPACE_DIR"

        # Read existing changelog if it exists
        if [ -f "$WORKSPACE_CHANGELOG_FILE" ]; then
            CURRENT_WORKSPACE_CHANGELOG=$(cat "$WORKSPACE_CHANGELOG_FILE")
        else
            CURRENT_WORKSPACE_CHANGELOG=""
        fi

        # Prepend new version to workspace changelog
        {
            echo "## [$VERSION] - $(date +%Y-%m-%d)"
            echo ""
            echo "$WORKSPACE_CHANGELOG"
            if [ -n "$CURRENT_WORKSPACE_CHANGELOG" ]; then
                echo ""
                echo "$CURRENT_WORKSPACE_CHANGELOG"
            fi
        } > "$WORKSPACE_CHANGELOG_FILE"

        echo "Updated $workspace/CHANGELOG.md"
        UPDATED_COUNT=$((UPDATED_COUNT + 1))
    done

    echo "Updated $UPDATED_COUNT workspace changelog(s)"
    exit 0
fi

# Generate output (for display/PR body)
if [ "$SHOW_HEADER" = true ]; then
    echo "## What's Changed"
    echo ""
fi

# Process workspace members in the order they appear in Cargo.toml, then "other"
FIRST_WORKSPACE=true
for workspace in $WORKSPACE_MEMBERS "other"; do
    # Skip if workspace is filtered out
    if ! should_include_workspace "$workspace"; then
        continue
    fi

    workspace_file=$(echo "$workspace" | tr '/' '_')

    if [ -f "$TEMP_DIR/$workspace_file" ]; then
        # Add separator between workspaces (except before first one)
        if [ "$FIRST_WORKSPACE" = false ]; then
            echo ""
        fi
        FIRST_WORKSPACE=false

        generate_workspace_changelog "$workspace"
    fi
done

if [ "$SHOW_HEADER" = true ]; then
    echo ""
    echo "<!-- generated by workspace changelog script -->"
fi
