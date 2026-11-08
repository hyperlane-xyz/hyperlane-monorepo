#!/usr/bin/env python3
"""Source SVM case composition. Static data gates only; never native acceptance."""
from pathlib import Path
import importlib.util
import json
import os

PAYER='E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty'
SCENARIO='sealevel'
SCENARIOS={'sealevel','sealevel-composite'}


def require(value,message):
    if not value:raise ValueError(message)


def assets():
    spec=importlib.util.spec_from_file_location('case_svm_assets',Path(__file__).with_name('native_svm_assets.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def validate_policy(request):
    require(request['scenario']in SCENARIOS and (request['postgres']is None if request['scenario']=='sealevel-composite'else isinstance(request['postgres'],dict)and request['postgres']['architecture']=='amd64'),'SVM basic requires Linux x86_64 PG; composite must have no PG')
    require(set(request['prerequisites'])=={'local_checkout_build','hpack','registry_commit','svm_offline'} and request['prerequisites']['local_checkout_build'] is True and request['prerequisites']['registry_commit'] is None,'SVM consumes neither TS registry nor a downloaded Cosmos CLI')
    require(isinstance(request['prerequisites']['svm_offline'],dict)and request['prerequisites']['svm_offline'].get('require_same_producer_source')is True,'SVM same-producer policy must be literal true')
    require(request['prerequisites']['svm_offline']=={'schema':2,'platform':'linux-x86_64','agave_version':'3.0.14','platform_tools_version':'v1.51','spl_release':'2024-08-23','spl_token_revision':'e101cca','programs':13,'agave_files':85,'source_environment_files':25,'require_same_producer_source':True},'Exact Source SVM dataset/publisher policy required')


def inspect_receipt(receipt,request,repo):
    """Caller must first validate all remote ZIP descriptors and closed extraction."""
    validate_policy(request);api=assets();entry=receipt['artifacts']['svm']
    directory=Path(entry['directory']);producer=request['producer_source_commit']
    inspected=api.inspect_export(directory,producer)
    before=api.member(directory,'source-before.json');require(before.stat().st_size<=32*1024**2,'SVM Source map bound')
    source=json.loads(before.read_text())
    environment=api.source_environment(repo,source)
    # Full helper/tools scopes already cover rust/main and rust/sealevel. The
    # Source map additionally binds each actual public environment input.
    return {'schema':1,'source_commit':producer,'inspected':inspected,'environment':environment,'source_before':api.pin(before),'same_source_cohort_required':True,'native_case_acceptance':False}


def check_inspection(value,request,repo):
    api=assets();require(value['source_commit']==request['producer_source_commit'] and value['same_source_cohort_required'] is True and value['native_case_acceptance'] is False,'SVM producer cohort differs')
    result=Path(value['inspected']['producer_result']['path']);api.pin(result)
    actual=api.inspect_export(result.parent,value['source_commit'])
    require(actual==value['inspected'],'SVM actual dataset changed since inspection')
    path=Path(value['source_before']['path']);require(api.pin(path)==value['source_before'],'SVM Source map changed')
    require(api.source_environment(repo,json.loads(path.read_text()))==value['environment'],'SVM public environment Source changed')
    return value


def materialize(value,request,repo,root,request_pin,producer_receipt):
    """Review-authorized offline assets only; component credit is never VM credit."""
    require(request.get('root_approved')is True,'Reviewed SVM execution request required before materializing component gate')
    check_inspection(value,request,repo);api=assets();root=Path(root)
    needed=sum(row['bytes'] for row in value['inspected']['files'].values())+sum(row['bytes']for row in value['environment'].values())
    import shutil
    require(shutil.disk_usage(root).free>=request['limits']['minimum_host_free_bytes']+needed,'SVM copy must preserve6GiB floor')
    records=api.stage_files(value['inspected'],root);environment=api.stage_environment(value['environment'],root)
    accepted={'schema':2,'platform':api.PLATFORM,'agave_version':'3.0.14','platform_tools_version':'v1.51','spl_release':'2024-08-23','spl_token_revision':'e101cca','root':str(root/'tools/svm'),'agave_files':{n:records['agave/'+n]for n in api.AGAVE},'programs':{n:records['programs/'+n]for n in api.PROGRAMS},'client':records['client/hyperlane-sealevel-client'],'spl_token':records['home/.cargo/bin/spl-token'],'environment_inputs':environment}
    gate={'schema':1,'root_approved':request['root_approved'],'accepted_svm_offline_prerequisites':True,'runtime_source_commit':request['producer_source_commit'],'accepted_assets':accepted,'reviewed_policy':request_pin,'producer_receipt':producer_receipt,'source_before':value['source_before'],'producer_result':value['inspected']['producer_result'],'product_manifest':value['inspected']['product_manifest'],'spl_publisher_digest':None,'spl_integrity_scope':'official_TLS_acquisition_and_computed_SHA_not_publisher_checksum','native_VM_acceptance':False,'performance_credit':False,'nonfatal_stack_warnings_require_actual_VM_execution':True}
    gate_path=root/'evidence/accepted-svm-offline-prerequisites.json';require(not gate_path.exists()and not gate_path.is_symlink(),'Preserve existing SVM component gate')
    with gate_path.open('x')as stream:json.dump(gate,stream,sort_keys=True);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    bundle=api.bundle(records,environment,root,api.pin(gate_path))
    require({k:v for k,v in bundle.items()if k!='component_gate'}==accepted,'SVM schema2 helper bundle differs')
    workspace=root/'svm-workspace';require(not workspace.exists()and not workspace.is_symlink(),'Exclusive owned SVM workspace');workspace.mkdir(mode=0o700)
    return bundle,[*records.values(),*environment.values(),api.pin(gate_path),value['source_before'],value['inspected']['producer_result'],value['inspected']['product_manifest']]


def profile(scenario=SCENARIO):return assets().public_profile(scenario,PAYER)


def listener_proof(manifest,case_inputs,case,lsof,observations,owner,subprocess):
    """Actual stable Linux PID, Source argv/ledger, TCP+UDP endpoint proof."""
    import ipaddress
    api=assets();bundle=case_inputs['svm_assets'];executable=Path(bundle['agave_files']['bin/solana-test-validator']['path']);require(api.pin(executable)==bundle['agave_files']['bin/solana-test-validator']and os.access(executable,os.X_OK),'SVM executable changed')
    for pid,row in owner.proc_fallback().items():
        if row['state']=='Z':continue
        try:
            try:actual=Path(os.readlink(f'/proc/{pid}/exe'))
            except PermissionError:continue # Unmatched unrelated host candidate only.
            if actual!=executable:continue
            argv=[os.fsdecode(v)for v in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')if v]
            ledger=api.node_arguments(argv,case);observed={}
            for kind,query in [('tcp',['-iTCP','-sTCP:LISTEN']),('udp',['-iUDP'])]:
                call=subprocess.run([str(lsof),'-nP','-a','-p',str(pid),*query,'-F','pfn'],env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},capture_output=True,timeout=2,check=False)
                require(call.returncode in (0,1)and len(call.stdout)<=65536 and len(call.stderr)<=65536,'SVM bounded listener observation failed')
                live=owner._linux_row(pid);require(live is not None and owner.same_process(row,live),'SVM PID changed during observation')
                observed[kind]=api.listener_rows(pid,call.stdout.decode(),udp=kind=='udp')
            ports={port for _,port in observed['tcp']}
            if not api.required_listener_rows(observed['tcp'],observed['udp'],allow_pending='8899,8900'not in observations):
                continue # No readiness proof until this same owned PID has every exact socket.
            observations['8899,8900']={'pid':pid,'start':row['start'],'executable':str(executable),'owned_tcp_ports':sorted(ports),'owned_loopback_tcp_ports':sorted({port for host,port in observed['tcp'] if ipaddress.ip_address(host).is_loopback}),'source_tcp_wildcard_ports':sorted({port for host,port in observed['tcp'] if host=='0.0.0.0'}),'source_tcp_wildcard_roles':{'rpc':8899,'pubsub':8900,'faucet':9900},'source_udp_unconnected_wildcard_client_ports':sorted({port for host,port in observed['udp'] if host=='0.0.0.0'}),'source_udp_client_port_range':{'minimum':api.AGAVE_RELEASE_CLIENT_UDP_RANGE[0],'exclusive_maximum':api.AGAVE_RELEASE_CLIENT_UDP_RANGE[1]},'source_udp_client_scope':'Agave3.0.14 release-default unconnected IPv4 client binds; no socket subsystem attribution','client_endpoint_scope':'localhost','ledger':ledger,'tcp':observed['tcp'],'udp':observed['udp'],'faucet_wildcard_exception':'Source9900/caps0only','scope':'owned canonical Source IPv4 wildcard RPC/PubSub/faucet and unconnected UDP clients; required loopback gossip; localhost RPC clients; no loopback-only node claim'}
        except(FileNotFoundError,ProcessLookupError):continue
    return [{8899,8900}]
