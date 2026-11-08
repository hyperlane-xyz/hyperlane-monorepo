#!/usr/bin/env python3
"""Pure synthetic/actual-schema controls; no network, product or SDK execution."""
from pathlib import Path
import re
from types import SimpleNamespace as N
import ast,copy,hashlib,importlib.util,io,json,os,selectors,stat,struct,sys,tempfile,unittest,zipfile
from unittest import mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('tested_cohort_readback',HERE/'cohort_readback.py')
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
def deny_effect(event,args):
    if event in {'subprocess.Popen','socket.__new__','socket.connect','socket.bind','os.system','os.fork','os.posix_spawn'}:raise AssertionError('Unexpected effect: '+event)
sys.addaudithook(deny_effect)

class Meter:
    def __init__(self):self.bytes=0;self.members=0;self.deadline=1800;self.cleanup_deadline=1860;self.clock=lambda:0
    def __call__(self,n=0):self.bytes+=n
    def add_members(self,n):self.members+=n

def archive_bytes(rows):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED)as z:
        for name,body in rows:z.writestr(name,body)
    return out.getvalue()

def elf_bytes(machine=62,kind=2,library=False,interpreter=True):
    data=bytearray(512);data[:8]=b'\x7fELF\x02\x01\x01\x00'
    struct.pack_into('<HHIQQQIHHHHHH',data,16,kind,machine,1,0 if library else 0x400180,64,0,0,64,56,1 if library or not interpreter else 2,0,0,0)
    struct.pack_into('<IIQQQQQQ',data,64,1,5,0,0x400000,0,512,512,4096)
    if not library and interpreter:
        value=b'/lib64/ld-linux-x86-64.so.2\0';struct.pack_into('<IIQQQQQQ',data,120,3,4,256,0,0,len(value),len(value),1);data[256:256+len(value)]=value
    return bytes(data)

def sdk_fixture(mode='ReleaseSafe'):
    files={};artifacts={};digests={}
    def add_json(name,value):
        body=json.dumps(value,sort_keys=True).encode();files[name]=body;return {'path':name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
    for name in api.SDK_NAMES:
        path='payload/'+('lib/'if name.startswith('lib')else'bin/')+name;body=elf_bytes(kind=3,library=True)if name.startswith('lib')else elf_bytes()
        files[path]=body;digests[name]=hashlib.sha256(body).hexdigest();artifacts[name]={'path':path,'bytes':len(body),'sha256':digests[name]}
    required=['readonly signed recovery allocation failure on every read path leaves Manual signed accounting and canonical bytes unchanged','readonly signed recovery every grouped allocation failure preserves journal nonce current owner member and signed rows','native group guards committed creation followed by load OOM remains durably owned and recoverable']
    tests={'total':3,'per_test':[{'ordinal':i,'total':3,'name':'synthetic.test.'+name,'status':'OK'}for i,name in enumerate(required,1)],'skipped':{}}
    native=add_json('receipts/native.json',{'passed':True,'mode':mode,'exit_code':0,'artifact_sha256':digests,'tests':tests});runtime=add_json('receipts/runtime.json',{'passed':True,'artifact_sha256':digests})
    cpu={}
    for scope,names in api.CPU_SCOPES.items():cpu[scope]=add_json('build-cpu/'+scope+'.json',{'schema':1,'scope':scope,'mode':mode,'source_commit':api.PRODUCER,'architecture':'amd64','flags':['sse2'],'artifacts':{name:{'bytes':artifacts[name]['bytes'],'sha256':digests[name]}for name in names}})
    manifest={'passed':True,'source_commit':api.PRODUCER,'mode':mode,'platform':'linux/amd64','native_case_acceptance':False,'image_started_by_exporter':False,'exact_created_CID_removed':True,'calls':[{'actual_parent_wait':True,'error':None,'exit_code':0},{'actual_parent_wait':True,'error':None,'exit_code':1}],'artifacts':artifacts,'inputs':{'native':native,'runtime':runtime},'build_provenance':cpu,'required_cpu_flags':['sse2'],'consumer_cpu_superset_required':True}
    add_json('manifest.json',manifest);return files

class SyntheticGit:
    def __init__(self):self.rows={}
    def bytes(self,name):return self.rows[name]
    def digest(self,name):
        body=self.rows[name];return {'bytes':len(body),'sha256':api.sha(body)}

def family_fixture(family):
    # Deliberately small SYNTHETIC producer records. Actual C43 archives remain
    # uninspected until the reviewed CI route; this exercises parser contracts.
    files={};git=SyntheticGit()
    def body(name,data):
        files[name]=data;return {'path':name,'bytes':len(data),'sha256':api.sha(data)}
    def data(name,value):return body(name,json.dumps(value,sort_keys=True).encode())
    def source(name,content=b'synthetic public Source'):
        git.rows[name]=content;return git.digest(name)
    def clean(name):
        return {'name':name,'pid':100,'passed':True,'actual_parent_wait':True,'exit_code':0,'error':None,'cleanup':{'clean':True,'signals':[],'owned_present_before_stop':[{'pid':100}]},'log':body(name+'.log',b'public successful command')}
    def executable(name):
        row=body(name,elf_bytes());observed={'class':64,'endianness':'little','machine':62,'type':2,'interpreter':'/lib64/ld-linux-x86-64.so.2'}
        return {**row,'relative_path':name,'elf':observed,'producer':dict(row)}
    if family=='helper':
        required={'synthetic':['fixture.checker_deadline_'+str(i)for i in range(5)],'starknet::cli::tests::':['starknet::cli::tests::invoke_and_send_tx_reject_failed_cli_status','starknet::cli::tests::invoke_and_send_tx_accept_successful_cli_status']}
        source('zig/bench/native_harness_controls.py',('REQUIRED_TESTS = '+repr(required)).encode())
        origin={'rust/main/fixture.rs':source('rust/main/fixture.rs')};data('authoritative-source.json',origin);data('job-status.json',{'primary_job_status':'success'})
        checks=[clean(name)for name in api.HELPER_PHASES]
        names=required['synthetic'];checks[1]['actual_tests_passed']=5;checks[1]['required_new_tests_observed']=names;checks[1]['log']=body(checks[1]['name']+'.log',('\n'.join('test '+n+' ... ok'for n in names)+'\ntest result: ok. 5 passed; 0 failed; 0 ignored;').encode())
        stark=next(row for row in checks if row['name']=='starknet-cli-tests');names=required['starknet::cli::tests::'];stark['actual_tests_passed']=2;stark['required_new_tests_observed']=names;stark['log']=body(stark['name']+'.log',('\n'.join('test '+n+' ... ok'for n in names)+'\ntest result: ok. 2 passed; 0 failed; 0 ignored;').encode())
        products={}
        for name in ['normal','construction']:
            row=executable('products/'+name);products[name]={'published':{k:row[k]for k in ['bytes','sha256']},'artifact_relative_path':'products/'+name,'producer':{k:row[k]for k in ['bytes','sha256']}}
        data('result.json',{'passed':True,'source_commit':api.PRODUCER,'source_unchanged':True,'all_owned_jobs_joined':True,'error':None,'native_case_acceptance':False,'checks':checks,'products':products})
        for nested,prefix in [('tools','native-case-tools/'),('radix_reference','native-radix-reference/')]:
            members,origin=family_fixture(nested);files.update({prefix+n:v for n,v in members.items()});git.rows.update(origin.rows)
        for name in ['partial.json','generated-compiler-inputs.json','radix-reference-stage/fetch.log','radix-reference-stage/producer-cpuinfo.txt','radix-reference-stage/partial.json','radix-reference-stage/source-gate.json','setup/tools-platform.txt']:body(name,b'{}')
    elif family=='writer':
        rows=[]
        for name in ['zig/src/native_rows_interop_fixture.zig','zig/tools/zig.py']:
            rows.append({'path':'/producer/'+name,**source(name)})
        rows.extend({'path':'/producer/input'+str(i),'bytes':1,'sha256':api.sha(b'x')}for i in range(8))
        row=body('bin/native-rows-writer-ReleaseSafe',elf_bytes())
        cleanup={'actual_parent_wait':True,'exit_code':0,'clean':True,'cleanup_confirmed_absent':True,'signals':[],'errors':[]}
        data('diagnostics/result.json',{'exit_code':0,'primary_error':None,'cleanup_error':None,'native_or_timing_acceptance':False,'cleanup':cleanup});data('diagnostics/monitor-parent.json',{'primary_error':None,'cleanup':cleanup});body('diagnostics/progress.jsonl',b'{}\n')
        data('manifest.json',{'passed':True,'source_commit':api.PRODUCER,'mode':'ReleaseSafe','writer_executed':False,'native_case_acceptance':False,'component_interoperability_acceptance':False,'input_before':rows,'input_after':rows,'writer':row,'cpu':{'architecture':'amd64','flags':['sse2']}})
    elif family=='tools':
        required=['zig/reference/src/main.rs','zig/reference/Cargo.toml','zig/reference/native-rows/src/main.rs','zig/reference/native-rows/Cargo.toml','rust/main/hyperlane-core/src/lib.rs','rust/main/agents/scraper/migration/bin/init_db.rs','zig/bench/native_case_tools.py']
        canonical={'rust/main/Cargo.lock':api.sha(b'lock')};git.rows['zig/bench/native_case_tools.py']=('CANONICAL = '+repr(canonical)+'\nLOCKS = '+repr(['rust/main/Cargo.lock'])).encode()
        origin={n:git.digest(n)if n in git.rows else source(n)for n in required};locks={'rust/main/Cargo.lock':source('rust/main/Cargo.lock',b'lock')}
        checks=[clean(n)for n in ['build-'+n for n in api.TOOLS]+['test-ziggy-rocks-oracle','test-ziggy-native-rows']]
        for row in checks:
            if row['name'].startswith('test-'):row['actual_tests_passed']=3 if row['name'].endswith('oracle')else 13
        gate={'passed':True,'source_commit':api.PRODUCER,'source_before':origin,'source_after':origin,'actual_all_parent_waits':True,'canonical_compatibility_source':canonical,'locks':locks,'checks':checks}
        gatepin=data('source-gate.json',gate);data('partial.json',{});data('plan.json',{})
        data('manifest.json',{'schema':1,'kind':'source-built-linux-native-case-tools','source_commit':api.PRODUCER,'platform':{'os':'linux','elf_machine':62,'architecture':'x86_64','byte_order':'little'},'native_chain_acceptance':False,'storage_interoperability_acceptance':False,'elapsed600_acceptance':False,'timing_acceptance':False,'canonical_compatibility_source':canonical,'tools':{n:executable('bin/'+n)for n in api.TOOLS},'source_gate':gatepin})
    elif family=='radix_reference':
        reference='zig/reference/radix';scopes=[reference,'zig/bench/native_radix_reference.py'];tests=['fixture_'+str(i)for i in range(5)];checks=['build','test','clippy','rustc','cargo'];binary='ziggy-radix-reference'
        code='\n'.join(name+' = '+repr(value)for name,value in [('REFERENCE',reference),('SCOPES',scopes),('TESTS',tests),('CHECKS',checks),('BIN',binary)])
        source('zig/bench/native_radix_reference.py',code.encode());origin={'zig/bench/native_radix_reference.py':git.digest('zig/bench/native_radix_reference.py')}
        for n in ['Cargo.toml','Cargo.lock.gz','src/main.rs']:origin[reference+'/'+n]=source(reference+'/'+n)
        rows=[clean(n)for n in checks];rows[1]['required_tests_observed']=tests;rows[1]['log']=body('test.log',('\n'.join('test evidence_tests::'+n+' ... ok'for n in tests)+'\ntest result: ok. 5 passed; 0 failed; 0 ignored;').encode())
        cpu=body('producer-cpuinfo.txt',b'processor : 0\nflags : sse2 sse4\n\nprocessor : 1\nflags : sse2\n')
        gate={'passed':True,'source_commit':api.PRODUCER,'source_before':origin,'source_after':origin,'all_owned_jobs_joined':True,'source_scopes':scopes,'locks':{'working_lock_restored_to_original_absence':True,'canonical':{'packed':origin[reference+'/Cargo.lock.gz']}},'checks':rows,'cpu':{'cpuinfo':cpu,'required_flags':['sse2'],'processor_rows':2}}
        gatepin=data('source-gate.json',gate);data('partial.json',{})
        data('manifest.json',{'schema':1,'kind':'source-built-linux-radix-reference','source_commit':api.PRODUCER,'native_case_acceptance':False,'accepted_reference_component':False,'timing_acceptance':False,'platform':{'os':'linux','byte_order':'little','elf_machine':62,'architecture':'x86_64'},'source_gate':gatepin,'tool':executable('bin/'+binary)})
    elif family=='svm':
        agave={};programs={};environment=['chain-'+str(i)+'.json'for i in range(25)]
        for n in ['bin/solana','bin/solana-test-validator']:
            row=body('published/agave/'+n,elf_bytes());agave[n]=(row['bytes'],row['sha256'])
        products={'programs':{}}
        def product(path,machine):
            code=elf_bytes(machine=machine,kind=3)if machine!=62 else elf_bytes();pin=body(path,code)
            return {'path':'/producer/'+path,'bytes':pin['bytes'],'sha256':pin['sha256'],'elf_class':64,'elf_machine':machine}
        for i in range(13):
            n='program-'+str(i)+'.so';machine=247 if i<4 else 263;row=product('published/programs/'+n,machine);products['programs'][n]=row;programs[n]=(row['bytes'],row['sha256'],machine)
        products['client']=product('published/hyperlane-sealevel-client',62);products['spl']=product('published/spl-token',62)
        for i in range(9):
            n='program-'+str(i+4)+'.so';data('published/sbf-header-'+str(i)+'.json',{'program':n,'observed_machine':263,'public_ELF_header_bytes':list(files['published/programs/'+n][:64])})
        source('zig/bench/native_svm_assets.py','\n'.join(n+' = '+repr(v)for n,v in [('AGAVE',agave),('AGAVE_BYTES',sum(r[0]for r in agave.values())),('PROGRAMS',programs),('ENVIRONMENT',environment)]).encode())
        assets={k:{'bytes':10,'sha256':api.sha(k.encode()),'url':'https://private.invalid/?SECRETQUERY','asset_id':i,'publisher_digest':i<=2}for i,k in enumerate(['agave','platform','spl','criterion'],1)}
        source('zig/tools/svm_prerequisites.py',('ASSETS = '+repr(assets)).encode());origin={'rust/sealevel/environments/local-e2e/'+n:source('rust/sealevel/environments/local-e2e/'+n)for n in environment};data('source-before.json',origin)
        commands=[]
        for i in range(31):
            n='command-'+str(i);commands.append({'name':n,'exit_code':0,'actual_wait_observed':True,**{kind:body('logs/'+n+'.'+kind,b'public command output')for kind in ['stdout','stderr']}})
        result={'checkout_commit':api.PRODUCER,'passed':True,'Source_unchanged':True,'error':None,'owned_absent':True,'actual_owner_signals':[],'forced_cleanup':False,'component_only':True,'native_case_credit':False,'linux_profile_admitted':False,'performance_credit':False,'commands':commands,'actual_orphan_waits':[{'actual_wait_observed':True,'exit_code':0,'preceded_by_owner_signal':False}],'products':products,**{k+'_archive':v for k,v in assets.items()}}
        metadata={'agave-linux-runtime-members.json','agave-publisher-members.json','client-cargo-artifact.json','compiler-inputs-before.json','criterion-publisher-members.json','custom-spl-commit.json','custom-spl-lock-overlay.json','custom-spl-source-map.json','custom-spl-upstream-source-map.json','custom-spl-upstream.Cargo.lock.gz','linux-profile.CANDIDATE.json','locks-before.json','platform-debugger-link-omissions.json','platform-linkage.json','platform-publisher-members.json','products.json','sbf-tool-authority.json','sdk-dependency-stage.json','spl-cargo-artifact.json','spl-publisher-members.json'}
        for name in metadata:data('published/'+name,products if name=='products.json'else{})
        body('observations.jsonl',b'{}\n');data('result.json',result)
    else:raise AssertionError(family)
    return files,git

class Controls(unittest.TestCase):
    def setUp(self):
        self.policy=api.decode_policy((HERE/'cohort_readback_request.json').read_bytes());self.policy['root_approved']=False;self.policy['scope']='fresh-eight-product-data-inspection'
        # Synthetic controls only; runtime module stays unbound/inert.
        binding=mock.patch.object(api,'PRODUCER',self.policy['producer']['source_commit']);binding.start();self.addCleanup(binding.stop)
    def test_unbound_fresh_reader_cannot_enable_or_reuse_old_identity(self):
        self.policy['root_approved']=True
        with mock.patch.object(api,'PRODUCER',None),self.assertRaisesRegex(api.Refused,'FRESH_PRODUCER_NOT_BOUND'):api.validate_policy(self.policy)
        self.policy['root_approved']=False
        with mock.patch.object(api,'PRODUCER',None):self.assertFalse(api.validate_policy(self.policy))

    def test_new_helper_namespace_is_required_before_actual_test_credit(self):
        files,source=family_fixture('helper')
        def inspect(rows):
            return self.zip(list(rows.items()),lambda archive,*_:api.validate_helper(archive,source))
        self.assertEqual(inspect(files)['actual_test_counts']['starknet-cli-tests'],2)
        result=json.loads(files['result.json']);result['checks']=[row for row in result['checks']if row['name']!='starknet-cli-tests'];missing=dict(files);missing['result.json']=json.dumps(result).encode()
        with self.assertRaisesRegex(api.Refused,'HELPER_PHASES'):inspect(missing)
        result=json.loads(files['result.json']);row=next(x for x in result['checks']if x['name']=='starknet-cli-tests');row['actual_tests_passed']=None;row['required_new_tests_observed']=[];wrong=dict(files);wrong['result.json']=json.dumps(result).encode()
        with self.assertRaises(api.Refused):inspect(wrong)

    def test_actual_e745_census_includes_later_Stark_and_Radix_additions(self):
        # Actual committed exporter Source; never import or execute its main.
        raw=(HERE/'native_harness_controls.py').read_bytes()
        self.assertEqual(api.sha(raw),'0a2075d0162dc24a9dbe41224ac667db2e'+'518fc2fecff45cb2268a5d4650c453')
        required=api.literal_constants(raw.decode(),{'REQUIRED_TESTS'})['REQUIRED_TESTS']
        self.assertEqual(len(required['starknet::cli::tests::']),2)
        self.assertEqual(len(required['external_agents::radix_contracts::tests::']),6)
        self.assertIn('starknet::cli::tests::invoke_and_send_tx_reject_failed_cli_status',required['starknet::cli::tests::'])
        self.assertIn('external_agents::radix_contracts::tests::approved_pair_is_owned_data_and_default_path_remains_none',required['external_agents::radix_contracts::tests::'])

    def remote(self):
        p=self.policy['producer'];run={'id':p['run_id'],'run_attempt':p['run_attempt'],'head_sha':api.PRODUCER,'repository':{'full_name':api.REPOSITORY},'head_repository':{'full_name':api.REPOSITORY},'head_branch':api.BRANCH,'event':'push','path':'.github/workflows/zig-agents.yml','status':'completed','conclusion':'success'}
        jobs=[{'id':v,'name':k,'run_id':p['run_id'],'status':'completed','conclusion':'success'}for k,v in self.policy['jobs'].items()]
        artifacts=[{**r,'digest':'sha256:'+r['sha256'],'expired':False,'workflow_run':{'id':p['run_id'],'head_sha':api.PRODUCER,'head_branch':api.BRANCH}}for r in self.policy['artifacts'].values()]
        return run,jobs,artifacts
    def zip(self,rows,callback):
        with tempfile.TemporaryDirectory()as d:
            path=Path(d)/'a.zip';path.write_bytes(archive_bytes(rows));meter=Meter();archive=api.Archive(path,meter)
            try:return callback(archive,meter,path)
            finally:archive.close()
    def workflow(self):
        return (HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
    def conditions(self):
        rows={};name=None;started=False
        for line in self.workflow().splitlines():
            if line=='jobs:':started=True
            if not started:continue
            if line.startswith('  ')and not line.startswith('   ')and line.endswith(':'):name=line.strip()[:-1]
            if line.startswith('    if: '):rows[name]=line[8:]
        self.assertEqual(set(rows),{'unit','vm-images','native-linux','native-http','svm-prerequisites','full-sdk-native','native-harness-controls','evm','container','aleo-linux-prerequisite','aleo-linux-sdk-prerequisite','aleo-native-docker-prerequisite','native-case-producer-inputs','aleo-full-case','cold-full-feature','paired-linux-inputs','paired-linux-functional','paired-linux-runtime'});return rows
    def evaluate(self,expression,message,event='push',ref='refs/heads/feat/zig-agent-rewrite',**flags):
        expression=expression.removeprefix('${{ ').removesuffix(' }}')
        expression=re.sub(r'!(?!=)',' not ',expression).replace('&&',' and ').replace('||',' or ').strip()
        scope={'github':N(event_name=event,ref=ref,event=N(head_commit=N(message=message))),'inputs':N(**{name:flags.get(name,False)for name in ['svm_prerequisites','cold_full_feature','aleo_linux_prerequisite','aleo_linux_sdk_prerequisite','aleo_native_docker_prerequisite','aleo_full_case','paired_linux']}),'contains':lambda text,needle:needle in text,'always':lambda:True}
        return bool(eval(compile(expression,'<actual-workflow-condition>','eval'),{'__builtins__':{}},scope))
    def test_actual_workflow_both_markers_route_only_existing_native_case_job(self):
        rows=self.conditions();message='[zig-native-case] [zig-cohort-readback]'
        self.assertEqual({k for k,v in rows.items()if self.evaluate(v,message)},{'native-case-producer-inputs'})
        for other in ['[zig-svm-prerequisites]','[zig-cold-full-feature]','[zig-aleo-kernel-only]','[zig-aleo-sdk-only]','[zig-aleo-docker-probe-only]','[zig-aleo-full-case]']:
            selected={k for k,v in rows.items()if self.evaluate(v,message+' '+other)}
            if other=='[zig-cold-full-feature]':
                self.assertEqual(selected,{'native-case-producer-inputs','cold-full-feature'})
            else:
                self.assertLessEqual(selected,{'native-case-producer-inputs','aleo-linux-prerequisite','aleo-linux-sdk-prerequisite','aleo-native-docker-prerequisite','aleo-full-case'})
    def test_actual_added_step_conditions_require_exact_branch_push_and_both_markers(self):
        text=self.workflow();names=['Inspect an exact producer cohort without granting native execution','Retain only the closed cohort inspection report']
        for name in names:
            block=text.split('      - name: '+name+'\n',1)[1].split('      - ',1)[0]
            expression=next(line.strip()[4:]for line in block.splitlines()if line.strip().startswith('if: '))
            self.assertTrue(self.evaluate(expression,'[zig-native-case] [zig-cohort-readback]'))
            for message,event,ref in [('[zig-cohort-readback]','push','refs/heads/feat/zig-agent-rewrite'),('[zig-native-case]','push','refs/heads/feat/zig-agent-rewrite'),('[zig-native-case] [zig-cohort-readback]','pull_request','refs/heads/feat/zig-agent-rewrite'),('[zig-native-case] [zig-cohort-readback]','workflow_dispatch','refs/heads/feat/zig-agent-rewrite'),('[zig-native-case] [zig-cohort-readback]','push','refs/heads/main')]:
                self.assertFalse(self.evaluate(expression,message,event,ref))
        upload=text.split('      - name: '+names[1]+'\n',1)[1].split('      - ',1)[0]
        self.assertIn('always()',upload);self.assertIn('/public/report.json',upload);self.assertIn('/public/report.sha256',upload)
        self.assertNotIn('**',upload);self.assertNotIn('.stdout',upload);self.assertNotIn('.stderr',upload)
    def test_corrupt_zip_crc_is_refused_before_catalog_credit(self):
        with tempfile.TemporaryDirectory()as d:
            path=Path(d)/'a.zip';out=io.BytesIO()
            with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED)as z:z.writestr('data',b'public fixture data')
            wire=bytearray(out.getvalue());offset=wire.index(b'public fixture data');wire[offset]^=1;path.write_bytes(wire)
            archive=api.Archive(path,Meter())
            try:
                with self.assertRaises(zipfile.BadZipFile):archive.finish()
                self.assertEqual(archive.catalog,{})
            finally:archive.close()
    def test_all_remaining_family_semantic_paths_on_explicit_synthetic_data(self):
        for family in ['helper','writer','tools','radix_reference','svm']:
            with self.subTest(family=family):
                files,git=family_fixture(family)
                def check(a,m,p):
                    result=api.inspect_archive('writer_safe'if family=='writer'else family,a,git);a.finish()
                    public=json.dumps(api.public_facts(result));self.assertNotIn('SECRETQUERY',public)
                    self.assertFalse(result.get('product_execution',result.get('writer_executed_by_reader',False)))
                self.zip(list(files.items()),check)
    def test_each_family_rejects_corrupted_actual_wait_or_source_fence(self):
        for family in ['helper','writer','tools','radix_reference','svm']:
            files,git=family_fixture(family)
            if family=='helper':name='result.json';row=json.loads(files[name]);row['checks'][0]['actual_parent_wait']=False
            elif family=='writer':name='diagnostics/result.json';row=json.loads(files[name]);row['cleanup']['actual_parent_wait']=False
            elif family=='svm':name='result.json';row=json.loads(files[name]);row['commands'][0]['actual_wait_observed']=False
            else:
                name='source-gate.json';row=json.loads(files[name]);row['checks'][0]['actual_parent_wait']=False
            files[name]=json.dumps(row).encode()
            # Rebind its manifest digest to distinguish semantic refusal from
            # the independent outer/member hash refusal already covered.
            if family in {'tools','radix_reference'}:
                manifest=json.loads(files['manifest.json']);manifest['source_gate'].update(bytes=len(files[name]),sha256=api.sha(files[name]));files['manifest.json']=json.dumps(manifest).encode()
            with self.subTest(family=family):
                with self.assertRaises(api.Refused):self.zip(list(files.items()),lambda a,m,p:api.inspect_archive('writer_safe'if family=='writer'else family,a,git))
    def test_source_symlink_is_exact_producer_Git_target_and_never_dereferenced(self):
        git=SyntheticGit();git.rows['.claude/skills']=b'../.agents/skills'
        row={'path':'/old/producer/.claude/skills','type':'symlink','target':'../.agents/skills'}
        self.assertEqual(api.origin_rows({'.claude/skills':row},git)['symlink_count'],1)
        for target in ['../../escape','/foreign','../other','../.agents/skills\n']:
            with self.assertRaises(api.Refused):api.origin_rows({'.claude/skills':{**row,'target':target}},git)
    def test_fixed_recursive_gitlink_origin_uses_pinned_commit_without_fetch(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);calls=[];commit='a'*40
            def runner(args,**kw):
                calls.append((args,kw));path=root/str(len(calls))
                if args==['ls-tree',api.PRODUCER,'--','solidity/lib/forge-std']:body='160000 commit '+commit+'\tsolidity/lib/forge-std\n'
                elif args==['rev-parse','HEAD']:self.assertTrue(kw['submodule']);body=commit+'\n'
                else:self.assertEqual(args,['show',commit+':src/Test.sol']);self.assertTrue(kw['submodule']);body='public submodule Source'
                path.write_text(body);return path,0
            reader=api.GitSource(N(git=runner,guard=Meter()),api.PRODUCER)
            self.assertEqual(reader.bytes('solidity/lib/forge-std/src/Test.sol'),b'public submodule Source');self.assertEqual(len(calls),3)
            self.assertFalse(list(root.iterdir()))
            def wrong(args,**kw):
                path=root/'wrong';path.write_text('160000 commit '+commit+'\tsolidity/lib/forge-std\n'if args[0]=='ls-tree'else'b'*40+'\n');return path,0
            with self.assertRaisesRegex(api.Refused,'SUBMODULE_CHECKOUT_DIFFERS'):api.GitSource(N(git=wrong,guard=Meter()),api.PRODUCER).bytes('solidity/lib/forge-std/src/Test.sol')
    def test_signal_failure_still_attempts_direct_child_wait_and_preserves_primary(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);child=mock.Mock(pid=123);child.kill.side_effect=OSError('private cleanup error');child.wait.return_value=0
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}):runner=api.Runner(root,root,Path('/usr/bin/gh'),Meter(),'PRIVATE_TOKEN')
            with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',side_effect=[RuntimeError('primary bookkeeping'),None]):
                with self.assertRaisesRegex(RuntimeError,'primary bookkeeping'):runner.call(['/usr/bin/gh','api'],'API_JSON')
            child.kill.assert_called_once();child.wait.assert_called_once();self.assertEqual(runner.waited,1);self.assertEqual(runner.failed,1)
    def test_helper_complete_closure_and_embedded_independent_catalog_equality(self):
        components={}
        for family in ['helper','tools','radix_reference']:
            files,git=family_fixture(family)
            def check(a,m,p):
                row=api.inspect_archive(family,a,git);row['catalog']=a.finish();components[family]=row
            self.zip(list(files.items()),check)
        api.validate_embedded_components(components)
        self.assertTrue(components['helper']['embedded_duplicate_catalogs_match_separate_artifacts'])
        components['tools']['catalog']['catalog_sha256']='0'*64
        with self.assertRaisesRegex(api.Refused,'EMBEDDED_COMPONENT_DIFFERS'):api.validate_embedded_components(components)
        files,git=family_fixture('helper')
        for mutate in [lambda f:f.pop('radix-reference-stage/source-gate.json'),lambda f:f.__setitem__('unexpected',b'foreign')]:
            changed=copy.deepcopy(files);mutate(changed)
            with self.assertRaisesRegex(api.Refused,'HELPER_CLOSED_MEMBERS'):self.zip(list(changed.items()),lambda a,m,p:api.validate_helper(a,git))
    def test_fast_SDK_and_writer_dispatch_match_mode_and_exact_product(self):
        files=sdk_fixture('ReleaseFast')
        self.zip(list(files.items()),lambda a,m,p:self.assertEqual(api.inspect_archive('sdk_fast',a,None)['mode'],'ReleaseFast'))
        files,git=family_fixture('writer');manifest=json.loads(files['manifest.json']);manifest['mode']='ReleaseFast';manifest['writer']['path']='bin/native-rows-writer-ReleaseFast';files[manifest['writer']['path']]=files.pop('bin/native-rows-writer-ReleaseSafe');files['manifest.json']=json.dumps(manifest).encode()
        self.zip(list(files.items()),lambda a,m,p:self.assertEqual(api.inspect_archive('writer_fast',a,git)['mode'],'ReleaseFast'))
    def test_real_private_policy_disabled_but_complete_pins_validate_when_explicitly_enabled_in_memory(self):
        self.assertFalse(api.validate_policy(self.policy));enabled=copy.deepcopy(self.policy);enabled['root_approved']=True
        self.assertTrue(api.validate_policy(enabled));self.assertEqual(len(enabled['core607']),607);self.assertEqual(set(enabled['artifacts']),set(api.PRODUCT_KEYS));self.assertEqual(sum(r['size_in_bytes']for r in enabled['artifacts'].values()),sum(r['size_in_bytes']for r in api.decode_policy((HERE/'cohort_readback_request.json').read_bytes())['artifacts'].values()))
    def test_missing_future_or_malformed_policy_never_authorizes(self):
        self.policy['root_approved']=True
        for mutate in [lambda p:p['producer'].__setitem__('source_commit','0'*40),lambda p:p['artifacts']['helper'].__setitem__('id',None),lambda p:p.__setitem__('root_approved',1),lambda p:p['limits'].__setitem__('host_free_bytes',0)]:
            p=copy.deepcopy(self.policy);mutate(p)
            with self.assertRaises(api.Refused):api.validate_policy(p)
    def test_top_level_native_false_handles_existing_prefix_hash_wire_without_decoding_it(self):
        api.require_disabled_case(json.dumps({'schema':1,'root_approved':False,'pg':{'prefix':'sha256:','sha256_hex_chunks':['a'*32,'b'*32]}}).encode())
        for value in [True,1,None,'false']:
            with self.assertRaises(api.Refused):api.require_disabled_case(json.dumps({'schema':1,'root_approved':value}).encode())
    def test_duplicate_request_and_nonfinite_values_refused(self):
        for value in [b'{"root_approved":false,"root_approved":true}',b'{"x":NaN}',b'{"x":1e999}']:
            with self.assertRaises(api.Refused):api.unique_json(value)
    def test_actual_all_four_remote_jobs_and_eight_publisher_identity(self):
        run,jobs,artifacts=self.remote();result=api.validate_remote(self.policy,run,jobs,artifacts)
        self.assertEqual(len(result['required_jobs']),4);self.assertEqual(len(result['artifacts']),8);self.assertFalse(result['whole_workflow_success_claim'])
    def test_wrong_run_head_attempt_or_job_refused(self):
        run,jobs,artifacts=self.remote()
        for key,value in [('id',run['id']+1),('head_sha','0'*40),('run_attempt',2),('head_branch','main')]:
            changed=copy.deepcopy(run);changed[key]=value
            with self.assertRaises(api.Refused):api.validate_remote(self.policy,changed,jobs,artifacts)
        changed=copy.deepcopy(jobs);changed[0]['conclusion']='failure'
        with self.assertRaises(api.Refused):api.validate_remote(self.policy,run,changed,artifacts)
    def test_duplicate_missing_wrong_digest_and_expired_artifacts_refused(self):
        run,jobs,artifacts=self.remote()
        cases=[artifacts[:-1],artifacts+[copy.deepcopy(artifacts[0])]]
        for key,value in [('digest','sha256:'+'0'*64),('expired',True),('size_in_bytes',1)]:
            changed=copy.deepcopy(artifacts);changed[0][key]=value;cases.append(changed)
        duplicate=copy.deepcopy(artifacts[0]);duplicate['id']+=1;cases.append(artifacts+[duplicate])
        for changed in cases:
            with self.assertRaises(api.Refused):api.validate_remote(self.policy,run,jobs,changed)
    def test_zip_stream_hash_and_replayed_bytes_are_charged(self):
        def check(a,m,p):
            self.assertEqual(a.read_at('p',128,64),b'x'*64);self.assertEqual(m.bytes,192)
            self.assertEqual(a.pin('p')['sha256'],hashlib.sha256(b'x'*512).hexdigest());self.assertEqual(m.bytes,704)
            result=a.finish();self.assertEqual(result['files'],1);self.assertEqual(result['expanded_bytes'],512);self.assertEqual(list(p.parent.iterdir()),[p])
        self.zip([('p',b'x'*512)],check)
    def test_whole_zip_validation_refuses_traversal_duplicate_and_parent_conflict(self):
        for rows in [[('../x',b'x')],[('/x',b'x')],[('a\\b',b'x')],[('a',b'x'),('a/b',b'x')]]:
            with tempfile.TemporaryDirectory()as d:
                p=Path(d)/'a.zip';p.write_bytes(archive_bytes(rows))
                with self.assertRaises(api.Refused):api.Archive(p,Meter())
                self.assertEqual(list(Path(d).iterdir()),[p])
        with tempfile.TemporaryDirectory()as d:
            p=Path(d)/'a.zip'
            with zipfile.ZipFile(p,'w')as z:
                z.writestr('a',b'a')
                with self.assertWarns(UserWarning):z.writestr('a',b'b')
            with self.assertRaises(api.Refused):api.Archive(p,Meter())
    def test_zip_symlink_and_noncanonical_nul_name_refused(self):
        with tempfile.TemporaryDirectory()as d:
            p=Path(d)/'a.zip';link=zipfile.ZipInfo('x');link.external_attr=(stat.S_IFLNK|0o777)<<16
            with zipfile.ZipFile(p,'w')as z:z.writestr(link,b'target')
            with self.assertRaises(api.Refused):api.Archive(p,Meter())
            wire=archive_bytes([('aXb',b'x')]).replace(b'aXb',b'a\0b');p.write_bytes(wire)
            with self.assertRaises(api.Refused):api.Archive(p,Meter())
    def test_archive_mutation_is_refused(self):
        def check(a,m,p):
            p.write_bytes(p.read_bytes()+b'x')
            with self.assertRaises(api.Refused):a.stable()
        self.zip([('p',b'x')],check)
    def test_wrong_elf_machine_type_missing_interpreter_and_entry_refused(self):
        for wire in [elf_bytes(machine=183),elf_bytes(kind=3,interpreter=False),elf_bytes(kind=1),elf_bytes(library=True)]:
            self.zip([('p',wire)],lambda a,m,p:self.assertRaises(api.Refused,api.elf,a,'p'))
        self.zip([('p',elf_bytes())],lambda a,m,p:self.assertEqual(api.elf(a,'p')['machine'],62))
        self.zip([('p',elf_bytes(kind=3,library=True))],lambda a,m,p:self.assertEqual(api.elf(a,'p',kind='library')['type'],3))
    def test_sbf_header_machine_is_explicit(self):
        self.zip([('p',elf_bytes(machine=263,kind=3,library=True))],lambda a,m,p:self.assertEqual(api.elf(a,'p',263,kind='program')['machine'],263))
    def test_synthetic_nine_payload_semantic_contract_includes_accepted_absence_exit1(self):
        # Synthetic3-row test suite verifies parser relationships only. It is
        # explicitly not an actual C43 native suite or product inspection.
        files=sdk_fixture();self.zip(list(files.items()),lambda a,m,p:self.assertEqual(api.validate_sdk(a,'ReleaseSafe',None)['export_actual_waits'],2))
    def test_sdk_receipt_corruption_wrong_mode_missing_CPU_and_payload_mismatch_refuse(self):
        def change_json(files,name,edit):
            row=json.loads(files[name]);edit(row);files[name]=json.dumps(row,sort_keys=True).encode()
        for modify in [lambda f:change_json(f,'manifest.json',lambda r:r.__setitem__('mode','ReleaseFast')),lambda f:change_json(f,'manifest.json',lambda r:r['build_provenance'].pop('aleo')),lambda f:f.__setitem__('payload/bin/relayer',b'corrupt'),lambda f:change_json(f,'manifest.json',lambda r:r.__setitem__('required_cpu_flags',['other']))]:
            files=sdk_fixture();modify(files)
            self.zip(list(files.items()),lambda a,m,p:self.assertRaises(api.Refused,api.validate_sdk,a,'ReleaseSafe',None))
    def test_literal_source_catalog_is_data_only_and_rejects_missing_required_names(self):
        source="REFERENCE='x'\nSCOPES=[REFERENCE,'y']\nASSETS={'a':{'bytes':1}}\nASSETS['b']={'bytes':2}\nraise AssertionError('must never execute')\n"
        result=api.literal_constants(source,{'SCOPES','ASSETS'});self.assertEqual(result['SCOPES'],['x','y']);self.assertEqual(result['ASSETS']['b']['bytes'],2)
        with self.assertRaises(api.Refused):api.literal_constants('X=unknown()\n',{'X'})
    def test_native_suite_failure_duplicate_rows_or_missing_recovery_controls_refuse(self):
        files=sdk_fixture();native=json.loads(files['receipts/native.json']);self.assertEqual(api.suite_counts(native)['total'],3)
        for mutate in [lambda r:r['tests']['per_test'][0].__setitem__('status','FAIL'),lambda r:r['tests']['per_test'][0].__setitem__('ordinal',True),lambda r:r['tests']['per_test'][0].__setitem__('name','other')]:
            changed=copy.deepcopy(native);mutate(changed)
            with self.assertRaises(api.Refused):api.suite_counts(changed)
    def test_null_cleanup_and_false_wait_cannot_be_producer_success(self):
        row={'actual_parent_wait':True,'exit_code':0,'error':None,'pid':1,'cleanup':{'clean':True,'signals':[],'owned_present_before_stop':[]}}
        api.clean_wait(row)
        for mutate in [lambda r:r.__setitem__('cleanup',None),lambda r:r.__setitem__('actual_parent_wait',False),lambda r:r.__setitem__('exit_code',False),lambda r:r['cleanup'].__setitem__('owned_present_before_stop',[{'pid':2}])]:
            changed=copy.deepcopy(row);mutate(changed)
            with self.assertRaises(api.Refused):api.clean_wait(changed)
    def test_guard_original_deadline_disk_floor_stream_and_member_caps(self):
        now=[0];limits=dict(api.LIMITS);g=api.Guard(Path('/unused'),limits,clock=lambda:now[0],free=lambda p:7*api.GIB)
        now[0]=limits['wall_seconds']
        with self.assertRaisesRegex(api.Refused,'ORIGINAL_DEADLINE'):g()
        now[0]=limits['wall_seconds']+limits['cleanup_seconds']
        with self.assertRaisesRegex(api.Refused,'ORIGINAL_CLEANUP_DEADLINE'):g.cleanup()
        now[0]=0;g.free=lambda p:limits['host_free_bytes']-1
        with self.assertRaisesRegex(api.Refused,'DISK_GUARD'):g()
        g.free=lambda p:7*api.GIB;g.streamed=limits['streamed_total_bytes']
        with self.assertRaisesRegex(api.Refused,'STREAM_BYTE_CAP'):g(1)
        g.streamed=0;g.members=limits['member_count']
        with self.assertRaisesRegex(api.Refused,'AGGREGATE_MEMBER_CAP'):g.add_members(1)
    def test_public_projection_drops_redirect_header_stderr_and_private_nested_source_objects_on_pass_and_failure(self):
        sentinel='PRIVATE_SENTINEL_NOT_PUBLIC'
        malicious={'helper':{'Source_origin':{'count':1,'headers':{'Authorization':sentinel},'actual_response_url':'https://example.invalid/?sig='+sentinel,'rawstderr':sentinel,'source_before':{'x':sentinel}},'products':{'normal':{'bytes':1,'sha256':'a'*64}}}}
        pin={'bytes':1,'sha256':'a'*64}
        for status in ['PASSED','FAILED']:
            value=api.closed_report(status,'b'*40,pin,pin,malicious,'SOURCE_ORIGIN'if status=='FAILED'else None);wire=json.dumps(value)
            for text in [sentinel,'example.invalid','"headers":','"rawstderr":','actual_response_url','Authorization','"source_before":']:self.assertNotIn(text,wire)
            self.assertEqual(value['components']['helper']['Source_origin'],{'count':1})
    def test_nonpublic_value_under_public_key_refuses_instead_of_leaking(self):
        with self.assertRaisesRegex(api.Refused,'REPORT_STRING'):api.closed_report('FAILED','b'*40,{}, {},{'helper':{'source_commit':'PRIVATE_SENTINEL'}})
    def test_runtimeerror_cancellation_propagates_through_actual_stdlib_selector(self):
        s=selectors.SelectSelector()
        try:
            with mock.patch.object(s,'_select',side_effect=api.TaskInterrupted()):
                with self.assertRaises(api.TaskInterrupted):s.select(0)
            with mock.patch.object(s,'_select',side_effect=InterruptedError()):self.assertEqual(s.select(0),[])
        finally:s.close()
    def test_command_late_zero_wait_and_postspawn_unwind_are_not_lost(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);meter=Meter();calls=[0]
            def late(n=0):
                calls[0]+=1
                if calls[0]==2:raise api.Refused('ORIGINAL_DEADLINE')
            meter.__call__=late
            class Late(Meter):
                def __call__(self,n=0):late(n)
            child=mock.Mock(pid=123);child.wait.return_value=0
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}):r=api.Runner(root,root,Path('/usr/bin/gh'),Late(),'PRIVATE_TOKEN')
            with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',return_value=object()):
                with self.assertRaisesRegex(api.Refused,'ORIGINAL_DEADLINE'):r.call(['/usr/bin/gh','api'],'API_JSON')
            child.wait.assert_called_once();self.assertEqual(r.waited,1);self.assertEqual(r.failed,1)
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);child=mock.Mock(pid=123);child.wait.return_value=0
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}):r=api.Runner(root,root,Path('/usr/bin/gh'),Meter(),'PRIVATE_TOKEN')
            with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',side_effect=[OSError('bookkeeping'),object()]):
                with self.assertRaises(OSError):r.call(['/usr/bin/gh','api'],'API_JSON')
            child.wait.assert_called_once();self.assertEqual(r.waited,1)
    def test_disabled_actual_main_performs_no_external_call_and_creates_only_closed_report(self):
        with tempfile.TemporaryDirectory()as d:
            parent=Path(d).resolve();repo=parent/'repo';bench=repo/'zig/bench';bench.mkdir(parents=True);policy=bench/'cohort_readback_request.json';policy.write_text(json.dumps(self.policy));case=bench/'native_case_request.json';case.write_text('{"schema":1,"root_approved":false}');output=parent/'out'
            argv=['cohort','--policy',str(policy),'--policy-sha256',hashlib.sha256(policy.read_bytes()).hexdigest(),'--native-request',str(case),'--native-request-sha256',hashlib.sha256(case.read_bytes()).hexdigest(),'--repo',str(repo),'--execution-source-commit','a'*40,'--gh','/absent','--output',str(output)]
            with mock.patch.object(sys,'argv',argv),mock.patch.object(sys,'platform','linux'),mock.patch.object(api.subprocess,'Popen',side_effect=AssertionError('no command')):api.main()
            self.assertEqual({p.relative_to(output).as_posix()for p in output.rglob('*')if p.is_file()},{'public/report.json','public/report.sha256'})
            report=json.loads((output/'public/report.json').read_text());self.assertEqual(report['status'],'DISABLED');self.assertFalse(report['inspection_passed']);self.assertFalse(report['native_case_acceptance'])
    def test_native_true_refuses_before_output_or_external_call_even_if_readback_policy_false(self):
        with tempfile.TemporaryDirectory()as d:
            parent=Path(d).resolve();repo=parent/'repo';bench=repo/'zig/bench';bench.mkdir(parents=True);policy=bench/'cohort_readback_request.json';policy.write_text(json.dumps(self.policy));case=bench/'native_case_request.json';case.write_text('{"schema":1,"root_approved":true}');output=parent/'out'
            argv=['cohort','--policy',str(policy),'--policy-sha256',hashlib.sha256(policy.read_bytes()).hexdigest(),'--native-request',str(case),'--native-request-sha256',hashlib.sha256(case.read_bytes()).hexdigest(),'--repo',str(repo),'--execution-source-commit','a'*40,'--gh','/absent','--output',str(output)]
            with mock.patch.object(sys,'argv',argv),mock.patch.object(sys,'platform','linux'),mock.patch.object(api.subprocess,'Popen',side_effect=AssertionError('no command')):
                with self.assertRaisesRegex(api.Refused,'NATIVE_SELECTOR_MUST_BE_FALSE'):api.main()
            self.assertFalse(output.exists())

class GhStartupDiagnostics(unittest.TestCase):
    def runner(self,root,meter=None):
        with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}):return api.Runner(root,root,Path('/usr/bin/gh'),meter or Meter(),'PRIVATE_TOKEN_MARKER')
    def popen(self,code,stderr=b'',seen=None):
        def spawn(argv,**kw):
            if seen is not None:seen.append((list(argv),dict(kw['env']),kw['preexec_fn']))
            kw['stderr'].write(stderr);kw['stderr'].flush()
            child=mock.Mock(pid=123);child.wait.return_value=code
            return child
        return spawn
    def test_actual_AB_uses_exact_version_and_no_token_and_retains_nonzero(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);r=self.runner(root);seen=[];spawns=iter([self.popen(2,b'fatal error: failed to reserve page summary memory\nPRIVATE_STACK',seen),self.popen(0,b'',seen)])
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}),mock.patch.object(api.subprocess,'Popen',side_effect=lambda *a,**kw:next(spawns)(*a,**kw)),mock.patch.object(api.os,'waitid',return_value=object()):result=r.startup_diagnostics()
            self.assertEqual([x[0]for x in seen],[['/usr/bin/gh','--version']]*2)
            self.assertTrue(all('GH_TOKEN'not in x[1]for x in seen));self.assertEqual(r.waited,2)
            self.assertEqual(result['probes']['AS512']['exit_code'],2);self.assertEqual(result['probes']['AS512']['error_class'],'GO_VIRTUAL_RESERVATION')
            self.assertEqual(result['probes']['INHERITED_AS1G']['exit_code'],0)
            self.assertFalse(list(root.glob('call-*')));self.assertIsNone(r.last_failed_command)
            self.assertNotIn('PRIVATE',json.dumps(api.public_facts({'gh_startup_diagnostics':result})))
    def test_actual_limits_GIT_stays_AS512_and_inherited_GH_keeps_AS1G(self):
        with tempfile.TemporaryDirectory()as d:
            r=self.runner(Path(d))
            with mock.patch.object(api.resource,'setrlimit')as sets,mock.patch.object(api.resource,'getrlimit',return_value=(api.GIB,api.GIB)):
                r._limits(65536);self.assertIn(mock.call(api.resource.RLIMIT_AS,(512*1024**2,512*1024**2)),sets.call_args_list)
                sets.reset_mock();r._limits(65536,inherited_address_space=True);self.assertFalse(any(x.args[0]==api.resource.RLIMIT_AS for x in sets.call_args_list));self.assertEqual(len(sets.call_args_list),2)
            with mock.patch.object(api.resource,'getrlimit',return_value=(-1,-1)),self.assertRaisesRegex(api.Refused,'CHILD_INHERITED_AS'):r._limits(65536,inherited_address_space=True)
    def test_actual_call_preexec_couples_API_ZIP_to_hard1G_and_GIT_to512(self):
        cases=[(['/usr/bin/gh','api'],'API_JSON',True),(['/usr/bin/gh','api'],'ARTIFACT_ZIP',True),(['/usr/bin/git','rev-parse','HEAD'],'GIT_READ',False),(['/usr/bin/git','rev-parse','HEAD'],'API_JSON',False),(['/usr/bin/gh','--version'],'GH_VERSION_AS512',False),(['/usr/bin/gh','--version'],'GH_VERSION_INHERITED',True)]
        with tempfile.TemporaryDirectory()as d:
            r=self.runner(Path(d))
            for argv,kind,inherited in cases:
                seen=[]
                def spawn(*a,**kw):
                    kw['preexec_fn']();seen.append(kw['env']);child=mock.Mock(pid=123);child.wait.return_value=0;return child
                with self.subTest(kind=kind,exe=argv[0]),mock.patch.object(api.resource,'setrlimit')as sets,mock.patch.object(api.resource,'getrlimit',return_value=(api.GIB,api.GIB))as gets,mock.patch.object(api.subprocess,'Popen',side_effect=spawn),mock.patch.object(api.os,'waitid',return_value=object()):
                    output,_=r.call(argv,kind,65536);output.unlink()
                    actual=[c for c in sets.call_args_list if c.args[0]==api.resource.RLIMIT_AS]
                    if inherited:self.assertEqual(actual,[]);gets.assert_called_once_with(api.resource.RLIMIT_AS)
                    else:self.assertEqual(actual,[mock.call(api.resource.RLIMIT_AS,(512*1024**2,512*1024**2))]);gets.assert_not_called()
                    self.assertEqual('GH_TOKEN'in seen[0],argv[0]=='/usr/bin/gh'and kind not in api.GH_DIAGNOSTIC_KINDS)
    def test_current_diagnostic_label_matches_actual_API_hard1G_route(self):
        with tempfile.TemporaryDirectory()as d:
            r=self.runner(Path(d))
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}),mock.patch.object(api.subprocess,'Popen',side_effect=self.popen(0)),mock.patch.object(api.os,'waitid',return_value=object()):value=r.startup_diagnostics()
            out=api.public_facts({'gh_startup_diagnostics':value})['gh_startup_diagnostics']
            self.assertIs(out['API_original_AS512_unchanged'],False);self.assertIs(out['API_inherited_hard_AS1GiB'],True)
    def test_probe_profile_cannot_run_api_or_git_or_large_output(self):
        with tempfile.TemporaryDirectory()as d:
            r=self.runner(Path(d))
            for argv,n in [(['/usr/bin/gh','api'],65536),(['/usr/bin/git','--version'],65536),(['/usr/bin/gh','--version'],65537)]:
                with self.subTest(argv=argv,n=n),self.assertRaisesRegex(api.Refused,'GH_PROBE_PROFILE'):r.call(argv,'GH_VERSION_INHERITED',n)
            self.assertEqual(r.count,0)
    def test_first_actual_API_failure_retains_closed_exit_class_and_token_not_raw(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);r=self.runner(root);seen=[]
            with mock.patch.object(api.subprocess,'Popen',side_effect=self.popen(1,b'gh: PRIVATE_TOKEN_MARKER https://private.invalid (HTTP 403)\n',seen)),mock.patch.object(api.os,'waitid',return_value=object()):
                with self.assertRaisesRegex(api.Refused,'COMMAND_OUTCOME'):r.api('repos/hyperlane-xyz/hyperlane-monorepo/actions/runs/42435923739')
            self.assertEqual(seen[0][1]['GH_TOKEN'],'PRIVATE_TOKEN_MARKER');self.assertEqual(r.waited,1);self.assertEqual(r.failed,1)
            row=r.summary()['last_failed_command'];self.assertEqual(row['exit_code'],1);self.assertEqual(row['error_class'],'HTTP_403');self.assertIsNone(row['signal'])
            wire=json.dumps(api.public_facts({'command_waits':r.summary()}));self.assertNotIn('PRIVATE',wire);self.assertNotIn('https:',wire)
    def test_actual_signal_exit_reports_positive_signal_without_invalid_negative_JSON(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);r=self.runner(root)
            with mock.patch.object(api.subprocess,'Popen',side_effect=self.popen(-9)),mock.patch.object(api.os,'waitid',return_value=object()):
                with self.assertRaisesRegex(api.Refused,'COMMAND_OUTCOME'):r.api('repos/hyperlane-xyz/hyperlane-monorepo/actions/runs/42435923739')
            row=api.public_facts(r.summary())['last_failed_command'];self.assertIsNone(row['exit_code']);self.assertEqual(row['signal'],9);self.assertEqual(row['error_class'],'SIGNAL')
    def test_fixed_error_classification_is_closed_and_unknown_does_not_echo(self):
        with tempfile.TemporaryDirectory()as d:
            p=Path(d)/'stderr'
            for raw,expected in [(b'gh: bad credentials (HTTP 401)\n','HTTP_401'),(b'gh: server (HTTP 503)\n','HTTP_5XX'),(b'lookup private.invalid: no such host','DNS_FAILURE'),(b'PRIVATE_MARKER','UNKNOWN'),(b'', 'NONE')]:
                p.write_bytes(raw);self.assertEqual(api.fixed_stderr_class(p,0 if not raw else 1),expected)
            p.write_bytes(b'x'*(1024**2+1));self.assertEqual(api.fixed_stderr_class(p,1),'STDERR_BOUND');p.unlink();self.assertEqual(api.fixed_stderr_class(p,1),'UNAVAILABLE')
    def test_late_probe_wait0_preserves_actualwait_and_fails_original_5s(self):
        class Late(Meter):
            def __init__(self):super().__init__();self.now=0;self.clock=lambda:self.now
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);meter=Late();r=self.runner(root,meter);child=mock.Mock(pid=123)
            def wait(**kw):meter.now=6;return 0
            child.wait.side_effect=wait
            with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',return_value=object()):
                with self.assertRaisesRegex(api.Refused,'GH_PROBE_DEADLINE'):r.call(['/usr/bin/gh','--version'],'GH_VERSION_AS512',65536)
            self.assertEqual(r.waited,1);child.wait.assert_called_once();self.assertFalse(list(root.glob('call-*')))
    def test_inherited_probe_still_refuses_actual_RSS_over512(self):
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);r=self.runner(root);child=mock.Mock(pid=123);child.wait.return_value=0
            fields=['0']*22;fields[19]='1';fields[21]=str(512*1024**2//4096+1)
            with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',side_effect=[None,object()]),mock.patch.object(api.Path,'read_text',return_value='123 (gh) '+' '.join(fields)),mock.patch.object(api.os,'sysconf',return_value=4096):
                with self.assertRaisesRegex(api.Refused,'CHILD_IDENTITY_OR_RSS'):r.call(['/usr/bin/gh','--version'],'GH_VERSION_INHERITED',65536)
            self.assertEqual(r.waited,1);child.wait.assert_called_once();self.assertFalse(list(root.glob('call-*')))
    def test_partial_AB_diagnostics_survive_a_guard_failure_after_actualwait(self):
        class Late(Meter):
            def __init__(self):super().__init__();self.now=0;self.clock=lambda:self.now
        with tempfile.TemporaryDirectory()as d:
            root=Path(d);meter=Late();r=self.runner(root,meter);child=mock.Mock(pid=123)
            def wait(**kw):meter.now=6;return 0
            child.wait.side_effect=wait
            with mock.patch.object(api,'file_pin',return_value={'bytes':1,'sha256':'a'*64}),mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',return_value=object()):
                with self.assertRaisesRegex(api.Refused,'GH_PROBE_DEADLINE'):r.startup_diagnostics()
            rows=api.public_facts(r.summary())['gh_startup_diagnostics']['probes'];self.assertEqual(set(rows),{'AS512'});self.assertIs(rows['AS512']['actual_parent_wait'],True)
    def test_enabled_main_AB_precedes_first_remote_api_disabled_main_no_probe(self):
        tree=ast.parse((HERE/'cohort_readback.py').read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        calls=[n for n in ast.walk(main)if isinstance(n,ast.Call)]
        startup=next(n for n in calls if isinstance(n.func,ast.Attribute)and n.func.attr=='startup_diagnostics')
        remote=next(n for n in calls if isinstance(n.func,ast.Name)and n.func.id=='remote_inventory')
        self.assertLess(startup.lineno,remote.lineno)
        disabled=next(n for n in ast.walk(main)if isinstance(n,ast.If)and isinstance(n.test,ast.UnaryOp)and isinstance(n.test.operand,ast.Name)and n.test.operand.id=='enabled')
        self.assertLess(disabled.end_lineno,startup.lineno)

if __name__=='__main__':unittest.main()
