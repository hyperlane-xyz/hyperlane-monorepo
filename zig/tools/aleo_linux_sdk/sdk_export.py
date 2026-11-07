"""Data-only closed SDK inspection bundle. No relocated launch authority."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import zipfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
from receipts import checked,load,need,sdk_receipt
from supervisor import free,pin,write
from sdk_provision import admitted, service_receipt


def export(spec_pin,result_pin,output,owner_pin):
    spec=load(spec_pin,32*1024**2);need(spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-offline-sdk-build-v1','actual authorized SDK spec required')
    value=sdk_receipt(result_pin,spec['node'],pin(Path(spec['sdk_entry_path'])),spec['execution_source_commit'],owner_pin)
    package=admitted(spec['package_receipt'],spec['package_owner_receipt'])
    need(value['package_receipt']==spec['package_receipt'],'actual build/package binding differs')
    rows={}
    for row in value['source_files']+value['outputs']+value['dependency_payloads']+spec['pins']+[spec_pin,result_pin,owner_pin,spec['package_receipt'],spec['package_owner_receipt']]:
        need(row['path']not in rows or rows[row['path']]==row,'conflicting export descriptor')
        rows[row['path']]=row
    need(output.is_absolute()and output.parent.resolve()==output.parent and not output.exists(),'fresh canonical data archive required')
    deadline=time.monotonic_ns()+120*10**9;members=[]
    def guard():need(time.monotonic_ns()<deadline and free(output.parent)>=6*1024**3 and (not output.exists()or output.stat().st_size<=2*1024**3),'bounded120s/2GiB export/free6 gate')
    try:
        with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_STORED,allowZip64=True)as archive:
            for index,row in enumerate(sorted(rows.values(),key=lambda row:row['path'])):
                guard();path=checked(row);member='files/'+str(index).zfill(6);digest=hashlib.sha256();count=0
                with path.open('rb')as source,archive.open(member,'w',force_zip64=True)as target:
                    while raw:=source.read(1024**2):guard();target.write(raw);digest.update(raw);count+=len(raw)
                need(count==row['bytes']and digest.hexdigest()==row['sha256'],'export bytes changed');checked(row);members.append({'member':member,'original':row})
            manifest={'schema':1,'kind':'aleo-linux-sdk-inspection-bundle-v1','result':result_pin,'build_spec':spec_pin,'package_receipt':spec['package_receipt'],'files':members,'original_package_symlinks':package['symlinks'],'symlinks_are_data_only':True,'usable_for_relocated_case_launch':False}
            raw=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode();need(len(raw)<=32*1024**2,'bounded closed index');archive.writestr('manifest.json',raw)
        guard()
    except BaseException:
        # Preserve any failed task-owned archive for diagnosis, never mark it accepted.
        raise
    return {'schema':1,'kind':'aleo-linux-sdk-inspection-export-v1','archive':pin(output),'member_count':len(members)+1,'actual_closed_source_payload_output_bytes':sum(row['original']['bytes']for row in members),'usable_for_relocated_case_launch':False,'SDK_or_proof_execution':False}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--spec');parser.add_argument('--spec-sha');parser.add_argument('--result');parser.add_argument('--result-sha');parser.add_argument('--output');parser.add_argument('--owner');parser.add_argument('--owner-sha');args=parser.parse_args()
    need(all([args.spec,args.spec_sha,args.result,args.result_sha,args.output,args.owner,args.owner_sha]),'inert: exact actual SDK spec/result/data output required')
    spec=pin(Path(args.spec));result=pin(Path(args.result));need(spec['sha256']==args.spec_sha and result['sha256']==args.result_sha,'exact build records changed')
    owner=pin(Path(args.owner));need(owner['sha256']==args.owner_sha,'exact SDK owner record changed')
    out=Path(args.output);write(out.with_suffix('.receipt.json'),export(spec,result,out,owner));return 0

if __name__=='__main__':raise SystemExit(main())
