"""Pure runtime-route/schema/qualification/budget controls, no native/API work."""
from pathlib import Path
import ast
import copy
import datetime
import hashlib
import importlib.util
import itertools
import json
import os
import re
import sys
import tempfile
from types import SimpleNamespace as N
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('runtime_ci_controls',HERE/'paired_linux_runtime_ci.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
REPO=Path(os.environ.get('PAIRED_RUNTIME_CONTROL_REPO',str(HERE.parents[1]))).resolve()

class Fixture(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name).resolve();self.repo=self.root/'repo';self.repo.mkdir();self.original_file=c.__file__;self.rows={}
    def file(self,relative,body):
        path=self.repo/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);row=c.pin(path);return dict(row,path=relative)
    def document(self,name,value):return self.file(name,(json.dumps(value,sort_keys=True)+'\n').encode())
    def enabled(self):
        source=[]
        for path in sorted(c.REQUIRED_SOURCE):
            body=Path(c.__file__).read_bytes()if path==c.SELF else b'# Source fixture, no execution\n'
            if path=='zig/bench/paired_linux_methods.json':body=(REPO/path).read_bytes()
            if path=='zig/bench/native_case_request.json':body=b'{"root_approved":false}\n'
            source.append(self.file(path,body))
        proof=self.document('proof.json',{'kind':'fixture proof not native acceptance'});readback=self.document('readback.json',{'passed':True,'fixture_only':True});products={name:{'bytes':1,'sha256':'a'*64}for name in c.PRODUCTS}
        cases=[{'family':family,'mode':mode,'passed':True,'public_proof':proof,'Root_readback':readback,'runtime_products':copy.deepcopy(products)}for family in c.FAMILIES for mode in c.MODES]
        native={'schema':1,'kind':'paired-linux-Root-native18-v1','root_approved':True,'passed':True,'producer_source_commit':'b'*40,'cases':cases}
        jobs=[{'name':'unit','run_id':1,'run_attempt':1,'job_id':1,'source_commit':'e'*40,'conclusion':'success','Root_readback':readback}];general={'schema':1,'kind':'paired-linux-Root-general-CI-v1','root_approved':True,'passed':True,'producer_source_commit':'b'*40,'Source_scope_qualified':True,'required_jobs':['unit'],'jobs':jobs}
        runtime=[self.file(f'zig/src/fixture-{i}.zig',b'// pure Source qualification fixture\n')for i in range(607)];final={'schema':1,'kind':'paired-linux-Root-final-Source-v1','root_approved':True,'passed':True,'producer_source_commit':'b'*40,'runtime_607':runtime,'Root_readback':readback}
        cohort={'passed':True,'root_approved':True,'Root_actual_cohort_acceptance':True,'all8_same_run_required_product_artifacts':True,'source_commit':'b'*40,'eight_artifacts':{key:{'id':i+1,'name':key,'size_in_bytes':1,'sha256':'a'*64}for i,key in enumerate(['sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference'])},'all4_required_jobs_actual_success':[{'name':name,'id':i+1}for i,name in enumerate(['full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)','native-harness-controls','svm-prerequisites'])]}
        self.documents={'native18_qualification':native,'general_CI_qualification':general,'final_Source_qualification':final,'cohort_qualification':cohort,'reuse_header':{'root_approved':True,'producer_source_commit':'b'*40,'Root_input_accepted':True,'Root_six_accepted':True}}
        value={key:None for key in c.FIELDS};value.update(schema=1,kind='paired-linux-runtime-ci-v1',root_approved=True,required_source=source,methods=next(r for r in source if r['path']=='zig/bench/paired_linux_methods.json'))
        for key,doc in self.documents.items():value[key]=self.document(key+'.json',doc)
        return self.save(value),value
    def save(self,value):
        path=self.repo/c.REQUEST;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value));return path
    def admit(self,value):
        path=self.save(value)
        with mock.patch.object(c,'__file__',str(self.repo/c.SELF)):return c.request(path,c.pin(path)['sha256'],self.repo)

    def inert_request(self):
        # False-gate controls must stay independent of live runtime activation.
        return {'schema':1,'kind':'paired-linux-runtime-ci-v1','root_approved':False,'reuse_header':None,'cohort_qualification':None,'native18_qualification':None,'general_CI_qualification':None,'final_Source_qualification':None,'methods':None,'required_source':[]}

class Request(Fixture):
    def test_inert_actual_request_before_any_module_setup_output_or_download(self):
        value=self.inert_request();path=self.save(value)
        with mock.patch.object(c,'source_module',side_effect=AssertionError('No import')),mock.patch.object(c,'current_identity',side_effect=AssertionError('No API/env')):self.assertIsNone(c.request(path,c.pin(path)['sha256'],self.repo))
        self.assertEqual([p for p in self.repo.rglob('*')if p.is_file()],[path])
    def test_oversized_request_refused_before_hash_or_decode(self):
        path=self.repo/'request.json'
        with path.open('wb')as stream:stream.truncate(2*1024**2+1)
        with mock.patch.object(c,'pin',side_effect=AssertionError('unbounded hash'))as hashed,mock.patch.object(c,'decode',side_effect=AssertionError('unbounded decode'))as decoded:
            with self.assertRaisesRegex(c.Refused,'before hash'):c.request(path,'a'*64,self.repo)
            hashed.assert_not_called();decoded.assert_not_called()
    def test_false_with_future_gate_or_nonliteral_bool_or_extra_field_refuses(self):
        base=self.inert_request()
        for field,value,reason in [('root_approved',1,'Closed runtime request'),('reuse_header',{},'Unapproved future gates must remain null'),('required_source',[{}],'Unapproved future gates must remain null'),('unknown',None,'Closed runtime request')]:
            with self.subTest(field=field),self.assertRaisesRegex(c.Refused,reason):self.admit({**base,field:value})
    def test_actual_enabled_closed_dto_and_all18_products_admitted_as_fixture_only(self):
        _,value=self.enabled();context=self.admit(value);self.assertEqual(context['producer'],'b'*40);self.assertEqual(len(context['native']['cases']),18);self.assertEqual(len(context['runtime_607']),607);self.assertNotIn('execution_source_commit',value)
    def test_each_independent_actual_Root_gate_and_source_count_required(self):
        _,base=self.enabled()
        for key in ['cohort_qualification','native18_qualification','general_CI_qualification','final_Source_qualification']:
            doc=copy.deepcopy(self.documents[key]);doc['passed']=False;value=copy.deepcopy(base);value[key]=self.document(key+'.json',doc)
            with self.subTest(gate=key),self.assertRaises(c.Refused):self.admit(value)
            self.document(key+'.json',self.documents[key])
        value=copy.deepcopy(base);value['required_source']=value['required_source'][:-1]
        with self.assertRaises(c.Refused):self.admit(value)
    def test_foundry_installer_test_and_root_cannot_be_omitted_from_runtime_authority(self):
        required={'zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json'};self.assertTrue(required<=c.REQUIRED_SOURCE)
        for missing in required:
            _,value=self.enabled();value['required_source']=[r for r in value['required_source']if r['path']!=missing]
            with self.subTest(missing=missing),self.assertRaisesRegex(c.Refused,'Full finite runtime CI Source closure'):self.admit(value)
    def test_missing_duplicate_family_wrong_mode_or_C43_hash_cannot_replace_fresh18(self):
        _,base=self.enabled()
        for change in ['missing','duplicate','wrongmode','wrongproducer']:
            doc=copy.deepcopy(self.documents['native18_qualification'])
            if change=='missing':doc['cases'].pop()
            if change=='duplicate':doc['cases'][-1]=doc['cases'][0]
            if change=='wrongmode':doc['cases'][0]['mode']='debug'
            if change=='wrongproducer':doc['producer_source_commit']='c'*40
            value=copy.deepcopy(base);value['native18_qualification']=self.document('native18_qualification.json',doc)
            with self.subTest(change=change),self.assertRaises(c.Refused):self.admit(value)
    def test_current_native_case_must_be_false_and_immutable_committed_methods(self):
        _,value=self.enabled();self.file('zig/bench/native_case_request.json',b'{"root_approved":true}')
        value['required_source']=[self.file(r['path'],b'{"root_approved":true}')if r['path']=='zig/bench/native_case_request.json'else r for r in value['required_source']]
        with self.assertRaisesRegex(c.Refused,'selector'):self.admit(value)
        self.assertEqual(len((REPO/'zig/bench/paired_linux_methods.json').read_bytes()),11229);self.assertEqual(hashlib.sha256((REPO/'zig/bench/paired_linux_methods.json').read_bytes()).hexdigest(),c.METHODS_SHA)
    def test_captured_metadata_replacement_and_nonfinite_duplicate_rejected(self):
        row=self.document('fixed.json',{'root_approved':False});(self.repo/'fixed.json').write_text('{"root_approved":true}')
        with self.assertRaises(c.Refused):c.data(row,self.repo)
        for raw in [b'{"a":1,"a":2}',b'{"a":NaN}',b'{"a":1e999}',b'['*34+b'0'+b']'*34]:
            with self.assertRaises(c.Refused):c.decode(raw)
    def test_source_loader_only_captured_bytes_no_adjacent_cache(self):
        row=self.file('module.py',b'answer=17\n');context={'repo':self.repo,'source':{'module.py':row}};(self.repo/'__pycache__').mkdir();(self.repo/'__pycache__/module.pyc').write_bytes(b'not executed')
        name='pure_ci_source_fixture';self.addCleanup(sys.modules.pop,name,None);self.assertEqual(c.source_module(context,'module.py',name).answer,17)
        with self.assertRaisesRegex(c.Refused,'preloaded'):c.source_module(context,'module.py',name)

class Budget(unittest.TestCase):
    def fixture(self):
        stamp='2026-11-08T00:00:00Z';start=c.started_ns(stamp);run={'id':10,'run_attempt':2,'head_sha':'a'*40,'head_branch':'feat/zig-agent-rewrite','status':'in_progress','event':'push','path':c.WORKFLOW,'repository':{'full_name':c.REPO},'head_repository':{'full_name':c.REPO},'head_commit':{'message':'[zig-native-case] [zig-paired-runtime]'}};job={'id':20,'run_id':10,'run_attempt':2,'name':'paired-linux-runtime (4)','status':'in_progress','conclusion':None,'started_at':stamp,'steps':[{'number':8,'name':c.MEASURED_STEP_NAME,'status':'in_progress','conclusion':None,'started_at':stamp,'completed_at':None}]};return start,run,job
    def call(self,run,jobs,before,after,mono1=100*c.NS,mono2=101*c.NS):return c.actual_budget(run,jobs,'a'*40,10,2,4,mono1,before,mono2,after)
    def test_actual_started_at_full330_and_conservative_remaining_fence(self):
        start,run,job=self.fixture();value=self.call(run,[job],start+100*c.NS,start+101*c.NS);self.assertEqual(value['remaining_ns'],(18360-101)*c.NS);self.assertEqual(value['job_id'],20);self.assertEqual(value['minimum_remaining_seconds'],18110)
        # Exactly threshold is allowed; a single additional ns refuses.
        self.call(run,[job],start+(18360-18110-1)*c.NS,start+(18360-18110)*c.NS)
        with self.assertRaisesRegex(c.Refused,'budget'):self.call(run,[job],start+(18360-18110-1)*c.NS+1,start+(18360-18110)*c.NS+1)
    def test_wrong_run_attempt_head_marker_jobname_or_terminal_job_refuses(self):
        start,run,job=self.fixture()
        for field,value in [('run_attempt',3),('head_sha','b'*40),('head_branch','main'),('head_commit',{'message':'[zig-paired-runtime]'})]:
            with self.subTest(field=field),self.assertRaises(c.Refused):self.call(dict(run,**{field:value}),[job],start,start+c.NS)
        for field,value in [('name','paired-linux-runtime (5)'),('status','completed'),('run_attempt',1),('started_at',None)]:
            with self.subTest(field=field),self.assertRaises(c.Refused):self.call(run,[dict(job,**{field:value})],start,start+c.NS)
        with self.assertRaises(c.Refused):self.call(run,[job,job],start,start+c.NS)
    def test_clock_shift_future_job_or_old_budget_are_not_borrowed(self):
        start,run,job=self.fixture()
        with self.assertRaises(c.Refused):self.call(run,[job],start,start+3*c.NS)
        with self.assertRaises(c.Refused):self.call(run,[job],start-c.NS,start)
        with self.assertRaises(c.Refused):self.call(run,[job],start+2000*c.NS,start+2001*c.NS)
        # UTC lag within tolerance never increases the monotonic-based budget.
        value=self.call(run,[job],start+100*c.NS,start+100*c.NS);self.assertEqual(value['remaining_ns'],(18360-101)*c.NS)
    def test_exact_current_push_identity_and_no_future_HEAD_template(self):
        env={'GITHUB_REPOSITORY':c.REPO,'GITHUB_EVENT_NAME':'push','GITHUB_REF':c.BRANCH,'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'10','GITHUB_RUN_ATTEMPT':'2'};self.assertEqual(c.current_identity(env),('a'*40,10,2))
        for k,v in [('GITHUB_EVENT_NAME','workflow_dispatch'),('GITHUB_REF','refs/heads/main'),('GITHUB_SHA','pending')]:
            with self.assertRaises(c.Refused):c.current_identity(dict(env,**{k:v}))
    def test_actual_quiet_compiler_snapshot_never_signals(self):
        fake=N(COMPILERS={'rustc'},processes=lambda:{99:{'comm':'rustc','state':'S','start':'linux-ticks:1'}})
        with self.assertRaisesRegex(c.Refused,'foreign'):c.quiet(fake)
        fake.processes=lambda:{99:{'comm':'rustc','state':'Z','start':'linux-ticks:1'}};self.assertTrue(c.quiet(fake)['passed'])

    def test_actual_step_identity_missing_ambiguous_terminal_and_future_refuse(self):
        start,run,job=self.fixture();base=copy.deepcopy(job['steps'][0])
        for changed in [None,[],[base,base],[base,dict(base,number=9)],[dict(base,name='different')],[dict(base,status='completed')],[dict(base,conclusion='success')],[dict(base,number=True)],[dict(base,number=0)],[dict(base,started_at=None)],[dict(base,started_at='2026-11-08T00:00:02Z')],[dict(base,started_at='2026-11-07T23:59:59Z')],[dict(base,completed_at='2026-11-08T00:00:01Z')],[base,dict(base,name='other step')]]:
            with self.subTest(changed=changed),self.assertRaises(c.Refused):self.call(run,[dict(job,steps=changed)],start,start+c.NS)
    def test_job_and_step_fences_both_have_exact_threshold_and_public_identity(self):
        start,run,job=self.fixture();step=job['steps'][0]
        row=self.call(run,[job],start+249*c.NS,start+250*c.NS);self.assertEqual(row['remaining_ns'],18110*c.NS);self.assertEqual(row['step_remaining_ns'],18110*c.NS);self.assertEqual(row['job_remaining_ns'],19550*c.NS);self.assertEqual((row['actual_step_number'],row['actual_step_name'],row['actual_step_started_at'],row['step_wall_seconds']),(8,c.MEASURED_STEP_NAME,step['started_at'],18360));self.assertEqual(row['step_deadline_UTC_ns'],start+18360*c.NS)
        with self.assertRaises(c.Refused):self.call(run,[job],start+249*c.NS+1,start+250*c.NS+1)
        job['steps'][0]['started_at']='2026-11-08T00:25:00Z';row=self.call(run,[job],start+1689*c.NS,start+1690*c.NS);self.assertEqual(row['job_remaining_ns'],18110*c.NS);self.assertEqual(row['step_remaining_ns'],18170*c.NS);self.assertEqual(row['remaining_ns'],18110*c.NS)
        with self.assertRaises(c.Refused):self.call(run,[job],start+1689*c.NS+1,start+1690*c.NS+1)
    def test_slow_preflight_inside_step_cannot_borrow_ample_job_budget(self):
        start,run,job=self.fixture();elapsed=300*c.NS;self.assertGreater(19800*c.NS-elapsed,c.MINIMUM_REMAINING_NS);self.assertLess(18360*c.NS-elapsed,c.MINIMUM_REMAINING_NS)
        with self.assertRaisesRegex(c.Refused,'measured-step budget'):self.call(run,[job],start+299*c.NS,start+300*c.NS)

class Mint(Fixture):
    def prepared(self):
        _,value=self.enabled();context=self.admit(value);manifest={'producer_source_commit':'b'*40,'artifacts':{'zig':{mode:{name:{'path':'not-executed/'+name,'bytes':1,'sha256':'a'*64}for name in c.PRODUCTS}for mode in c.MODES}}};m=self.document('prepared-manifest.json',manifest);accepted=self.document('accepted-six.json',{'passed':True,'whole_original_proof_source_unchanged':True});binding={'enabled':True,'inputs_root':str(self.root/'published'),'input_manifest':dict(m,path=str(self.repo/m['path'])),'accepted_six':dict(accepted,path=str(self.repo/accepted['path'])),'provenance':{'current_execution_source_commit':'a'*40,'product_source_commit':'b'*40}};row=self.document('binding.json',binding);return context,dict(row,path=str(self.repo/row['path'])),manifest
    def exercise(self,*,cleanup_error=False,restore_error=False,bad_head=False,wrong_native=False,late_step_publication=False,late_job_publication=False):
        context,binding,manifest=self.prepared();calls=[];outer=self;now=c.started_ns('2026-11-08T00:01:00Z');output=self.root/'mint';owner=self.root/'owner'
        if wrong_native:context['native']['cases'][0]['runtime_products']['relayer']['sha256']='f'*64
        class Guard:
            def __init__(self,*args):self.deadline=1000;self.cleanup_deadline=1030;self.clock=lambda:0
            def __call__(self,*args):calls.append('guard')
            def cleanup(self):
                calls.append('cleanup')
                if cleanup_error:raise c.Refused('fixed cleanup fixture')
        class Runner:
            def __init__(self,root,repo,gh,guard,token):self.root=root;self.repo=repo;self.gh=gh;self.n=0;self.token=token
            def git(self,args,**kwargs):
                calls.append(('git',args));self.n+=1
                if args==['rev-parse','HEAD']:
                    path=self.root/'actual-head';path.write_text(('f'if bad_head else'a')*40+'\n');return path,0
                return self.repo/args[1].split(':',1)[1],0
            def call(self,args,kind,maximum):
                calls.append(('API',kind));self.n+=1;endpoint=args[-1];path=self.root/('API-'+str(self.n));job={'id':20,'run_id':10,'run_attempt':2,'name':'paired-linux-runtime (4)','status':'in_progress','conclusion':None,'started_at':('2026-11-07T23:35:00Z'if late_job_publication else'2026-11-08T00:00:00Z'),'steps':[{'number':8,'name':c.MEASURED_STEP_NAME,'status':'in_progress','conclusion':None,'started_at':'2026-11-08T00:00:00Z','completed_at':None}]}
                value={'jobs':[job],'total_count':1}if'/jobs?'in endpoint else {'id':10,'run_attempt':2,'head_sha':'a'*40,'head_branch':'feat/zig-agent-rewrite','status':'in_progress','event':'push','path':c.WORKFLOW,'repository':{'full_name':c.REPO},'head_repository':{'full_name':c.REPO},'head_commit':{'message':'[zig-native-case] [zig-paired-runtime]'}}
                path.write_text(json.dumps(value));return path,0
            def summary(self):return {'all_calls_actually_waited':True,'failure_count':0,'actual_calls':self.n,'actual_parent_waits':self.n,'fixture_only':True}
        def restore(previous):
            calls.append('restore')
            if restore_error:raise c.Refused('fixed restore fixture')
        stage=N(arm_interrupts=lambda guard:calls.append('arm')or{},restore_interrupts=restore);reader=N(Guard=Guard,Runner=Runner,LIMITS={});custody=N(COMPILERS={'rustc'},processes=lambda:{})
        def loader(ctx,relative,name):
            calls.append(('load',relative));return reader if relative.endswith('cohort_readback.py')else custody if relative.endswith('cold_matrix_owner.py')else stage if relative.endswith('paired_linux_stage.py')else N()
        env={'GITHUB_REPOSITORY':c.REPO,'GITHUB_EVENT_NAME':'push','GITHUB_REF':c.BRANCH,'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'10','GITHUB_RUN_ATTEMPT':'2','GH_TOKEN':'PRIVATE_TOKEN_FIXTURE'}
        with mock.patch.object(c,'source_module',side_effect=loader),mock.patch.object(c.resource,'setrlimit'),mock.patch.object(c.time,'monotonic_ns',side_effect=lambda:((400 if late_step_publication else 260)if(late_step_publication or late_job_publication)and(output/'actual-prework-quiet-and-budget.json').exists()else 100)*c.NS),mock.patch.object(c.time,'time_ns',return_value=now),mock.patch.dict(os.environ,{},clear=False):
            if cleanup_error or restore_error or bad_head or wrong_native or late_step_publication or late_job_publication:
                with self.assertRaises(c.Refused):c.mint(context,binding,output,Path('/not-executed/gh'),4,env,owner)
                result=None
            else:result=c.mint(context,binding,output,Path('/not-executed/gh'),4,env,owner)
        self.assertIn('cleanup',calls);self.assertIn('restore',calls)
        return output,result,calls
    def test_real_mint_caller_separate_actualHEAD_products_jobclock_and_closed_authority(self):
        output,result,calls=self.exercise();authority=c.data(result);self.assertEqual(set(authority),{'schema','kind','root_approved','execution_source_commit','producer_source_commit','methods','required_source','accepted_six','final_native18','quiet'});self.assertEqual(authority['execution_source_commit'],'a'*40);self.assertEqual(authority['producer_source_commit'],'b'*40);self.assertTrue(authority['root_approved']);self.assertEqual(len([x for x in calls if isinstance(x,tuple)and x[0]=='API']),2);self.assertNotIn('PRIVATE_TOKEN_FIXTURE',json.dumps(c.data(c.pin(output/'mint-result.json'))))
    def test_cleanup_or_restore_failure_revokes_published_authority_and_mintpass(self):
        for field in ['cleanup_error','restore_error']:
            # Each case has a separate independent fixture output root.
            with self.subTest(field=field):
                if (self.root/'mint').exists():
                    import shutil
                    shutil.rmtree(self.root/'mint')
                output,_,_=self.exercise(**{field:True});self.assertFalse(c.data(c.pin(output/'runtime-authority.json'))['root_approved']);self.assertFalse(c.data(c.pin(output/'mint-result.json'))['passed'])
    def test_bad_actual_checkout_or_new_native_product_hash_never_mints(self):
        for field in ['bad_head','wrong_native']:
            with self.subTest(field=field):
                if (self.root/'mint').exists():
                    import shutil
                    shutil.rmtree(self.root/'mint')
                output,_,calls=self.exercise(**{field:True});self.assertFalse((output/'runtime-authority.json').exists());self.assertFalse(any(isinstance(x,tuple)and x[0]=='API'for x in calls));failed=c.data(c.pin(output/'mint-result.json'));self.assertFalse(failed['passed']);self.assertTrue(failed['actual_commands']['all_calls_actually_waited']);self.assertNotIn('PRIVATE_TOKEN_FIXTURE',json.dumps(failed))
    def test_same_pure_output_formula_never_uses_unrelated_result_glob(self):
        _,value=self.enabled();context=self.admit(value);authority={'path':str(self.root/'authority'),'bytes':1,'sha256':'f'*64};owner=self.root/'owner';raw=c.emit_paths(context,authority,owner,4);token=hashlib.sha256((str(owner/'worker')+'f'*64).encode()).hexdigest()[:32];self.assertEqual(raw,self.repo/'zig/bench/results'/('scraper-process-linux-'+token+'-4'));self.assertNotIn('*',str(raw))


    def test_actual_mint_rechecks_step_fence_after_post_API_Source_work(self):
        output,result,calls=self.exercise(late_step_publication=True);self.assertIsNone(result);self.assertFalse((output/'runtime-authority.json').exists());self.assertEqual(len([x for x in calls if isinstance(x,tuple)and x[0]=='API']),2);failed=c.data(c.pin(output/'mint-result.json'));self.assertFalse(failed['passed']);self.assertTrue(failed['actual_commands']['all_calls_actually_waited']);record=c.data(c.pin(output/'actual-prework-quiet-and-budget.json'))['job_budget'];self.assertGreater(record['conservative_job_deadline_monotonic_ns']-400*c.NS,c.MINIMUM_REMAINING_NS);self.assertLess(record['conservative_step_deadline_monotonic_ns']-400*c.NS,c.MINIMUM_REMAINING_NS)

    def test_actual_mint_rechecks_job_fence_when_step_still_has_ample_time(self):
        output,result,calls=self.exercise(late_job_publication=True);self.assertIsNone(result);self.assertFalse((output/'runtime-authority.json').exists());self.assertEqual(len([x for x in calls if isinstance(x,tuple)and x[0]=='API']),2);record=c.data(c.pin(output/'actual-prework-quiet-and-budget.json'))['job_budget'];self.assertLess(record['conservative_job_deadline_monotonic_ns']-260*c.NS,c.MINIMUM_REMAINING_NS);self.assertGreater(record['conservative_step_deadline_monotonic_ns']-260*c.NS,c.MINIMUM_REMAINING_NS);self.assertFalse(c.data(c.pin(output/'mint-result.json'))['passed'])

class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text=(HERE.parents[1]/c.WORKFLOW).read_text();cls.job=cls.text.split('  paired-linux-runtime:\n',1)[1].split('  # END REVIEWED PAIRED LINUX JOBS',1)[0];cls.rows={};name=None;started=False
        for line in cls.text.splitlines():
            if line=='jobs:':started=True
            if not started:continue
            if line.startswith('  ')and not line.startswith('   ')and line.endswith(':'):name=line.strip()[:-1]
            if line.startswith('    if: '):cls.rows[name]=line[8:]
    def evaluate(self,event='push',ref=c.BRANCH,message='',**flags):
        scope={'github':N(event_name=event,ref=ref,event=N(head_commit=N(message=message))),'inputs':N(paired_linux=flags.get('paired',False),svm_prerequisites=flags.get('svm',False),cold_full_feature=flags.get('cold',False),aleo_linux_prerequisite=flags.get('aleo',False),aleo_linux_sdk_prerequisite=flags.get('sdk',False),aleo_native_docker_prerequisite=flags.get('docker',False),aleo_full_case=flags.get('full',False)),'needs':N(paired_linux_inputs=N(outputs=N(functional_enabled='false',runtime_enabled='false'))),'contains':lambda text,needle:needle in text}
        selected=set()
        for name,value in self.rows.items():
            code=value.removeprefix('${{ ').removesuffix(' }}').replace('needs.paired-linux-inputs','needs.paired_linux_inputs');code=re.sub(r'!(?!=)',' not ',code).replace('&&',' and ').replace('||',' or ').strip()
            if eval(compile(code,'actual-reviewed-job-if','eval'),{'__builtins__':{}},scope):selected.add(name)
        return selected
    def test_all17_other_job_bodies_byteexact_and18_members(self):
        tree=ast.parse((REPO/'zig/bench/paired_linux_test.py').read_bytes());helper=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow');scope={}
        exec(compile(ast.Module(body=[helper],type_ignores=[]),'actual-reviewed-native-HTTP-inverse','exec'),scope)
        ordinary=scope['ordinary_native_http_workflow'](self.text)
        prefix,tail=ordinary.split('  paired-linux-runtime:\n',1);inverse=prefix+tail.split('  # END REVIEWED PAIRED LINUX JOBS',1)[1]
        self.assertEqual(len(self.rows),18);self.assertEqual(hashlib.sha256(inverse.encode()).hexdigest(),'61c6875a22586bcd3408ef4d44638102'+'2879a14543ba46209f40638732810219')
        self.assertIn('name: paired-linux-input-diagnostic-',inverse);self.assertNotIn('needs:',self.job)
    def test_288_existing_ordinary_routes_never_start_runtime(self):
        count=0
        for event,ref,message,svm,cold,sdk,aleo in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main',c.BRANCH],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],[False,True],[False,True],[False,True],[False,True]):
            self.assertNotIn('paired-linux-runtime',self.evaluate(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo));count+=1
        self.assertEqual(count,288)
    def test_dual_push_route_independent_from_once_build_and_false_native_selector(self):
        message='[zig-native-case] [zig-paired-runtime]'
        self.assertEqual(self.evaluate(message=message),{'native-case-producer-inputs','paired-linux-runtime'})
        for wrong in [dict(message='[zig-paired-runtime]'),dict(message='[zig-native-case]'),dict(message=message,event='workflow_dispatch'),dict(message=message,ref='refs/heads/main'),dict(message=message,event='pull_request')]:self.assertNotIn('paired-linux-runtime',self.evaluate(**wrong))
        for marker in ['[zig-paired-linux]','[zig-aleo-fullcase-only]','[zig-aleo-docker-only]','[zig-aleo-sdk-only]','[zig-aleo-kernel-only]']:self.assertNotIn('paired-linux-runtime',self.evaluate(message=message+' '+marker))
    def test_false_gate_before_setup_and_reuse_clock_separate_from_original_owner(self):
        order=['Read inert runtime authority','Check runtime controller','actions/setup-node@','Stage exact official native pnpm12.3.0 outside all measurements','Install verified official Foundry v1.5.0','Stage the same ordinary consumer tools','Reuse the actual Root-qualified','Check actual job budget']
        positions=[self.job.index(x)for x in order];self.assertEqual(positions,sorted(positions))
        for item in ['timeout-minutes: 330','timeout-minutes: 306','timeout-minutes: 32','max-parallel: 2','index: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]','actions: read','exec env -u GH_TOKEN python3 -I -B','--owner-output "$OWNER"','--reuse "$REUSE" --reuse-sha256 "$REUSE_SHA"','${{ steps.measured.outputs.raw_output }}']:self.assertIn(item,self.job)
        self.assertNotIn('cargo ',self.job);self.assertNotIn('rustup ',self.job);self.assertNotIn('pnpm install',self.job);self.assertNotIn('sdk_build',self.job);self.assertNotIn('inputs_root }}',self.job)
        # Every Source-importing Python entry retains isolated no-bytecode flags.
        for line in self.job.splitlines():
            if line.lstrip().startswith(('python3 ','exec env -u GH_TOKEN python3 ')):self.assertIn('python3 -I -B',line)
        self.assertIn('PAIRED_PG16_DIGEST_A: 43f9275df91e012c3da3d86bea5d7bb5',self.job);self.assertIn('PAIRED_PG16_DIGEST_B: e67a473296cc906c5f9e80b8176b1a37',self.job)
    def test_runtime_step_reserves_startup_and_finally_beyond_all_original_inner_clocks(self):
        measured=self.job.split('      - name: Check actual job budget and supervise the unchanged original workload',1)[1].split('      - uses: actions/upload-artifact@',1)[0];step_minutes=int(re.search(r'timeout-minutes: ([0-9]+)',measured).group(1));job_minutes=int(re.search(r'timeout-minutes: ([0-9]+)',self.job).group(1))
        tree=ast.parse((HERE/'paired_linux_runtime_ci.py').read_text());guard=next(n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='Guard');mint={ast.literal_eval(k):ast.literal_eval(v)for k,v in zip(guard.args[1].keys,guard.args[1].values)if isinstance(k,ast.Constant)and isinstance(v,ast.Constant)}
        tree=ast.parse((REPO/'zig/bench/paired_linux_runtime_owner.py').read_text());limits=next(n.value for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='LIMITS'for t in n.targets));owner={ast.literal_eval(k):ast.literal_eval(v)for k,v in zip(limits.keys,limits.values)if isinstance(k,ast.Constant)and isinstance(v,ast.Constant)}
        self.assertEqual((mint['wall_seconds'],mint['cleanup_seconds'],owner['wall_seconds'],owner['PG_cleanup_seconds'],job_minutes,c.MINIMUM_REMAINING_NS//c.NS),(180,30,18000,60,330,18110))
        self.assertEqual(step_minutes*60,c.MEASURED_STEP_WALL_NS//c.NS);self.assertIn('- name: '+c.MEASURED_STEP_NAME,self.job)
        envelope=mint['wall_seconds']+mint['cleanup_seconds']+owner['wall_seconds']+owner['PG_cleanup_seconds'];self.assertGreaterEqual(step_minutes*60-envelope,90)
        # Old304 minutes has no reserve even before counting mint cleanup.
        self.assertLess(304*60-envelope,0)

    def test_actual_source_and_reuse_CLI_signatures_without_project_import(self):
        tree=ast.parse((REPO/'zig/bench/paired_linux_reuse.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='reuse');self.assertEqual([a.arg for a in fn.args.args],['header_pin','repo','output','current_source_commit','gh','token'])
        self.assertEqual(len(c.REQUIRED_SOURCE),49)
        for name in ['paired_linux_runtime.py','paired_linux_runtime_owner.py','paired_linux.py']:
            nodes=ast.parse((REPO/'zig/bench'/name).read_text()).body;literal=next((n.value for n in nodes if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id in {'SOURCE_REQUIRED','SOURCE_PATHS'}for t in n.targets)),None)
            if literal is not None:
                if name=='paired_linux_runtime.py':
                    assignments=[n for n in nodes if isinstance(n,ast.Assign)];loads=ast.literal_eval(next(n.value for n in assignments if any(isinstance(t,ast.Name)and t.id=='LOADS'for t in n.targets)));required={p for _,p in loads}|set(ast.literal_eval(literal.right))
                else:required=set(ast.literal_eval(literal))
                self.assertTrue(required<=c.REQUIRED_SOURCE)

if __name__=='__main__':unittest.main(verbosity=2)
