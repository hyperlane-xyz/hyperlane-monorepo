#!/usr/bin/env bash
# Apply cleanup policy and disable vulnerability scanning for the gcr.io Artifact Registry repo.
#
# Context: The gcr.io repo has accumulated ~5.76 TB of images (27K+ hyperlane-agent versions alone)
# and has allUsers read access, generating ~$6K/month in internet egress from public pulls.
#
# This script:
# 1. Sets a 30-day cleanup policy (deletes old untagged images and old PR/SHA-tagged images)
# 2. Disables vulnerability scanning (scanning all 27K+ images is wasteful)
#
# Usage: ./apply-gcr-cleanup.sh [--dry-run]

set -euo pipefail

PROJECT="abacus-labs-dev"
REPO="gcr.io"
LOCATION="us"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${SCRIPT_DIR}/gcr-cleanup-policy.json"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] Will show commands without executing"
fi

echo "=== Artifact Registry Cleanup for ${PROJECT}/${LOCATION}/${REPO} ==="
echo ""

# 1. Show current state
echo "--- Current repo size ---"
gcloud artifacts repositories describe "$REPO" \
  --location="$LOCATION" \
  --project="$PROJECT" \
  --format="value(sizeBytes)" 2>/dev/null | awk '{printf "%.2f GB\n", $1/1024/1024/1024}'

echo ""
echo "--- Current cleanup policies ---"
gcloud artifacts repositories list-cleanup-policies "$REPO" \
  --location="$LOCATION" \
  --project="$PROJECT" 2>&1 || echo "(none)"

echo ""
echo "--- Current scanning config ---"
gcloud artifacts repositories describe "$REPO" \
  --location="$LOCATION" \
  --project="$PROJECT" \
  --format="value(vulnerabilityScanningConfig.enablementState)"

# 2. Apply cleanup policy
echo ""
echo "=== Applying cleanup policy from ${POLICY_FILE} ==="
cat "$POLICY_FILE"
echo ""

if [[ "$DRY_RUN" == "false" ]]; then
  gcloud artifacts repositories set-cleanup-policies "$REPO" \
    --location="$LOCATION" \
    --project="$PROJECT" \
    --policy="$POLICY_FILE"
  echo "Cleanup policy applied."
else
  echo "[DRY RUN] Would run: gcloud artifacts repositories set-cleanup-policies $REPO --location=$LOCATION --project=$PROJECT --policy=$POLICY_FILE"
fi

# 3. Disable vulnerability scanning
echo ""
echo "=== Disabling vulnerability scanning ==="
if [[ "$DRY_RUN" == "false" ]]; then
  gcloud artifacts repositories update "$REPO" \
    --location="$LOCATION" \
    --project="$PROJECT" \
    --disable-vulnerability-scanning
  echo "Vulnerability scanning disabled."
else
  echo "[DRY RUN] Would run: gcloud artifacts repositories update $REPO --location=$LOCATION --project=$PROJECT --disable-vulnerability-scanning"
fi

echo ""
echo "=== Done ==="
echo "Note: Cleanup policies run asynchronously. It may take hours/days for old images to be deleted."
echo "Monitor progress: gcloud artifacts docker images list us-docker.pkg.dev/$PROJECT/$REPO/hyperlane-agent --format='value(DIGEST)' | wc -l"
