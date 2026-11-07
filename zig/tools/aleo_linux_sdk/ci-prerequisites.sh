#!/usr/bin/env bash
# Future authorized CI only; no invocation in this proposal.
set -euo pipefail
[[ ${ALEO_SDK_AUTHORIZED:-false} == true ]]
# Requires Root-reviewed SDK service profiles and the sealed delegated kernel
# Source successor. No direct/raw owner or old undelegated Lease fallback.
export SDK_NODE=$(command -v node)
export SDK_PNPM=$(command -v pnpm)
export SDK_CODE="$GITHUB_WORKSPACE/zig/tools/aleo_linux_sdk"
export SDK_ROOT="$RUNNER_TEMP/aleo-sdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
[[ ! -e "$SDK_ROOT" ]]
mkdir -m 700 "$SDK_ROOT"
# The reviewed workflow authorizes spec execution, not successful admission.
# Metadata code only: no SDK/package/compiler module is imported here.
prepare() {
  MODE="$1" env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 \
    MODE="$1" SDK_NODE="$SDK_NODE" SDK_PNPM="$SDK_PNPM" SDK_CODE="$SDK_CODE" \
    SDK_ROOT="$SDK_ROOT" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" GITHUB_SHA="$GITHUB_SHA" \
    python3 -I -B - <<'PY'
import hashlib,json,os,secrets,sys
from pathlib import Path
code=Path(os.environ['SDK_CODE']).resolve();sys.path.insert(0,str(code))
from supervisor import pin,write
from receipts import load
import sdk_specs
root=Path(os.environ['SDK_ROOT']).resolve();repo=Path(os.environ['GITHUB_WORKSPACE']).resolve();mode=os.environ['MODE']
tools={name:pin(Path(value).resolve(strict=True))for name,value in {'node':os.environ['SDK_NODE'],'pnpm':os.environ['SDK_PNPM'],'python':'/usr/bin/python3.12','bwrap':'/usr/bin/bwrap'}.items()}
delegation_tools={name:pin(Path('/usr/bin')/name)for name in ('systemd-run','systemctl','sudo')}
if mode in {'kernel-acquire','kernel-build'}:
    spec=sdk_specs.kernel_spec(root/mode,tools,secrets.token_hex(16),delegation_tools)
elif mode=='packages':
    kernel=load(pin(root/'kernel-acquire/result.json'))
    spec=sdk_specs.service_spec('packages',root/'packages',tools,repo,os.environ['GITHUB_SHA'],kernel['spec'],pin(root/'kernel-acquire/result.json'),secrets.token_hex(16),delegation_tools)
elif mode=='build':
    kernel=load(pin(root/'kernel-build/result.json'))
    spec=sdk_specs.service_spec('build',root/'build',tools,repo,os.environ['GITHUB_SHA'],kernel['spec'],pin(root/'kernel-build/result.json'),secrets.token_hex(16),delegation_tools,pin(root/'packages/result.json'),root/'build-control',pin(root/'packages.owner/owner.json'))
else:raise ValueError('unknown fixed CI phase')
spec['root_approved']=True
spec['authorization']='reviewed opt-in locked-SDK CI job; no node/proof or benchmark grant'
record=write(root/(mode+'.spec.json'),spec)
write(root/(mode+'.spec.pin.json'),record)
(root/(mode+'.spec.sha256')).write_text(record['sha256']+'\n')
PY
}
prepare kernel-acquire
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 python3 -I -B "$SDK_CODE/../aleo_linux/kernel_delegate.py" --execute --spec "$SDK_ROOT/kernel-acquire.spec.json" --spec-sha "$(cat "$SDK_ROOT/kernel-acquire.spec.sha256")"
prepare packages
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 python3 -I -B "$SDK_CODE/sdk_delegate.py" --execute --spec "$SDK_ROOT/packages.spec.json" --spec-sha "$(cat "$SDK_ROOT/packages.spec.sha256")"
# A package acquisition may last 30min: an older five-minute kernel receipt is
# intentionally not reusable. Probe again in THIS job/boot immediately before build.
prepare kernel-build
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 python3 -I -B "$SDK_CODE/../aleo_linux/kernel_delegate.py" --execute --spec "$SDK_ROOT/kernel-build.spec.json" --spec-sha "$(cat "$SDK_ROOT/kernel-build.spec.sha256")"
prepare build
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 python3 -I -B "$SDK_CODE/sdk_delegate.py" --execute --spec "$SDK_ROOT/build.spec.json" --spec-sha "$(cat "$SDK_ROOT/build.spec.sha256")"

# Closed regular-file bytes plus data-only link manifest, not a relocated SDK
# launch receipt. A future full case can consume the retained stage in THIS job.
RESULT_SHA=$(sha256sum "$SDK_ROOT/build/result.json" | cut -d' ' -f1)
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 python3 -I -B "$SDK_CODE/sdk_export.py" --spec "$SDK_ROOT/build.owner/payload.spec.json" --spec-sha "$(sha256sum "$SDK_ROOT/build.owner/payload.spec.json" | cut -d' ' -f1)" --result "$SDK_ROOT/build/result.json" --result-sha "$RESULT_SHA" --owner "$SDK_ROOT/build.owner/owner.json" --owner-sha "$(sha256sum "$SDK_ROOT/build.owner/owner.json" | cut -d' ' -f1)" --output "$SDK_ROOT/sdk-inspection.zip"
