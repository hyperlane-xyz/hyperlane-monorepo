#!/usr/bin/env bash
# Reviewed future CI path AFTER same-job SDK/Docker/cohort/interop acquisition.
# No actual authorization or execution is supplied by this proposal.
set -euo pipefail
[[ ${ALEO_CASE_AUTHORIZED:-false} == true ]]
[[ $# == 2 ]]
CASE_BINDING="$1"
CASE_BINDING_SHA="$2"
CASE_CODE="$GITHUB_WORKSPACE/zig/tools/aleo_linux_case"
PYTHON=/usr/bin/python3.12
# Binding is Root-approved and filled from actual same-job receipts. prepare()
# recomputes their source/product/CPU/DB/SDK/custody gates before any case output.
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 "$PYTHON" -I -B "$CASE_CODE/case_specs.py" \
  --prepare --binding "$CASE_BINDING" --binding-sha "$CASE_BINDING_SHA"
CONTROL=$(env -i PATH=/usr/bin:/bin "$PYTHON" -I -B -c 'import json,sys;print(json.load(open(sys.argv[1]))["control"])' "$CASE_BINDING")
# This fixed metadata command imports only pure TS parser functions; no SDK,
# Node main, worker, native client or proof is started.
CASE_CODE="$CASE_CODE" CONTROL="$CONTROL" env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 \
  CASE_CODE="$CASE_CODE" CONTROL="$CONTROL" "$PYTHON" -I -B - <<'PY'
import os,sys,time
from pathlib import Path
code=Path(os.environ['CASE_CODE']);sys.path.insert(0,str(code))
from case_specs import load,pin,write,need
control=Path(os.environ['CONTROL']);spec=load(pin(control/'case.PENDING.json'),32*1024**2)
root=Path(spec['output']);need(not root.exists(),'exclusive actual case root required')
def free(path):v=os.statvfs(path);return v.f_bavail*v.f_frsize
memory={r.split(':')[0]:int(r.split()[1])*1024 for r in Path('/proc/meminfo').read_text().splitlines()if r.startswith(('MemTotal:','MemAvailable:'))}
need(memory['MemTotal']>=32*1024**3 and memory['MemAvailable']>=41*1024**3//2,'actual20.5GiB combined capacity unavailable')
capacity={'reviewed':True,'minimum_free_bytes':6*1024**3,'host_free_bytes':free(root.parent),'docker_free_bytes':free(spec['docker_filesystem']),'memory_available_bytes':memory['MemAvailable'],'observed_unix_ms':time.time_ns()//10**6,'scope':'fixed reviewed case recipe actual preflight, no performance credit'}
need(min(capacity['host_free_bytes'],capacity['docker_free_bytes'])>=12*1024**3,'actual growth headroom plus free6GiB floor required')
import socket
for port in (23030,23031,25432):
 with socket.socket()as listener:listener.bind(('127.0.0.1',port))
write(control/'authorization.json',{'root_approved':True,'purpose':'aleo-linux-fullcase-authorization-v1','pending_spec':pin(control/'case.PENDING.json'),'manifest_input':pin(control/'manifest-input.json'),'capacity':capacity})
(control/'node.path').write_text(spec['node']['path']+'\n')
PY
NODE=$(cat "$CONTROL/node.path")
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 "$NODE" --experimental-strip-types --no-warnings \
  "$CASE_CODE/prepare_manifest.mjs" --finalize "$CONTROL/authorization.json" "$(sha256sum "$CONTROL/authorization.json" | cut -d' ' -f1)"
env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 "$PYTHON" -I -B "$CASE_CODE/case_specs.py" \
  --bind-namespace --binding "$CONTROL/case.json" --binding-sha "$(sha256sum "$CONTROL/case.json" | cut -d' ' -f1)"
# The reviewed recipe authorizes the exact service; it does not claim success.
CASE_CODE="$CASE_CODE" CONTROL="$CONTROL" env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 \
  CASE_CODE="$CASE_CODE" CONTROL="$CONTROL" "$PYTHON" -I -B - <<'PY'
import os,sys
from pathlib import Path
sys.path.insert(0,os.environ['CASE_CODE'])
from case_specs import pin,write,service_spec
control=Path(os.environ['CONTROL']);tools={name:pin(Path('/usr/bin')/name)for name in ('systemd-run','systemctl','sudo')}
spec=service_spec(pin(control/'case-approved.json'),tools);spec['root_approved']=True
write(control/'service.json',spec)
PY
exec env -i PATH=/usr/bin:/bin LC_ALL=C.UTF-8 "$PYTHON" -I -B "$CASE_CODE/case_delegate.py" \
  --execute --spec "$CONTROL/service.json" --spec-sha "$(sha256sum "$CONTROL/service.json" | cut -d' ' -f1)"
