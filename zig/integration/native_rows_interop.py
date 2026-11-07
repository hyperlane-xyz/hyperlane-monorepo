#!/usr/bin/env python3
"""Actual Zig operation persistence -> two independent Rust readers. No chain/600s acceptance."""
import argparse,copy,hashlib,json,pathlib,selectors,struct,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
OLD_SHA='8e295002b44b4248d00d6627aaa47a21'+'2315f6f837f3a2d652f2e7f6ada69fd9'
REFERENCE_SHA='de1a7ce2afa16e1c527fe875082bff280'+'868bfadaaa5c3088aeef277e5b5c52e'
COUNT=5
FORBIDDEN=['native-rows-sensitive-authorization-never-print','native-rows-signed-wire-never-print/','public_fixture_case']
FORBIDDEN += [value.encode().hex()for value in FORBIDDEN]
def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def artifact(path,expected=None):
 path=path.resolve(strict=True);record={'path':str(path),'bytes':path.stat().st_size,'sha256':sha(path)}
 if expected is not None and record['sha256']!=expected:raise ValueError('ImmutableArtifactMismatch')
 return record
def safe(text):
 if any(value in text for value in FORBIDDEN):raise AssertionError('SensitiveFixtureDataInOutput')
 return json.loads(text)
def database_files(root):
 result={}
 for path in sorted(root.rglob('*')):
  if path.is_symlink():raise AssertionError('DatabaseSymlink')
  if path.is_file():result[str(path.relative_to(root))]={'bytes':path.stat().st_size,'sha256':sha(path)}
 return result
def invoke(command,root,label,input=None):
 started=time.monotonic();result=subprocess.run([str(v)for v in command],cwd=ROOT,env={},input=input,text=True,capture_output=True,timeout=30)
 safe_output=all(not any(value in text for value in FORBIDDEN)for text in [result.stdout,result.stderr]);
 if not safe_output:raise AssertionError('SensitiveFixtureDataInOutput')
 (root/(label+'.stdout')).write_text(result.stdout);(root/(label+'.stderr')).write_text(result.stderr)
 (root/(label+'-command.json')).write_text(json.dumps({'argv':[str(v)for v in command],'environment':{},'exit_code':result.returncode,'started_monotonic':started,'ended_monotonic':time.monotonic()},indent=2)+'\n')
 return result

def verify_native(expected,value):
 assert value['complete'] is True and value['readonly'] is True and value['configuration_authority_verified'] is False
 assert len(expected['rows'])==COUNT and len(value['rows'])==COUNT
 for index,(written,read) in enumerate(zip(expected['rows'],value['rows'])):
  assert read['id']==written['id'] and read['present'] is True
  op=read['operation']
  for key in ['nonce','context','generation','stage','confirmation_started','deadline','identity','row','stored_canonical_intent','signed','authority']:assert op[key]==written[key],key
  assert op['generation']==1 and op['stage']=='submitting' and op['retries']==0
  assert op['context']=='0x'+bytes([9 if index==3 else 7+index]).hex()*32
  assert op['authority']=={'protocol':'sealevel'if index==1 else'aleo'if index==4 else'starknet','origin':9913371,'destination':9913372,'mailbox':'0x'+('33'*32 if index==1 else '00'*31+'33'),'chain_id':'public-native-storage-fixture'if index==1 else'testnet'if index==4 else'0x534e5f5345504f4c4941','origin_hook':'0x'+('55'*32 if index==1 else '00'*31+'55'),'operation_id':written['id'],'generation':1,'kind':'process','target':'0x'+'00'*31+'77'if index==4 else None}
  gas=((1<<200)+101)*(1 if index==2 else 3)//4 if index in(2,3)else(1<<200)+123+index
  tokens=((1<<240)+17)*(1 if index==2 else 3)//4 if index in(2,3)else(1<<240)+456+index
  assert int(written['gas_used_hex'],16)==gas and int(written['tokens_used_hex'],16)==tokens
  assert int(written['payment_hex'],16)==(1<<192)+789+index and int(written['payment_gas_hex'],16)==(1<<160)+101112+index
  assert op['expected_context_checked'] is True and op['origin']==9913371 and op['destination']==9913372 and op['nonce']==index and op['kind']=='process' and op['target'] is None
  assert op['confirmation_started'] is True and op['deadline']['delay_ms']==600000 and op['deadline']['unix_ms']==1800000600000
  assert op['expenditure']['present'] is True
  assert op['expenditure']['gas_used_hex']==written['gas_used_hex'] and op['expenditure']['tokens_used_hex']==written['tokens_used_hex']
  identity=bytes.fromhex(op['identity']['hex'][2:]);tag=1 if index==1 else 0
  marker=bytes([tag])+identity+tokens.to_bytes(32,'little')+gas.to_bytes(32,'little')
  assert op['expenditure']['marker']=={'bytes':len(marker),'sha256':'0x'+hashlib.sha256(marker).hexdigest()}
  assert op.get('starknet')==written['starknet']
  if index in(0,2,3):
   quote=op['starknet'];assert isinstance(quote,dict) and set(quote)=={'gas_limit','estimated_cost','batch'}
   assert quote['gas_limit']==(1 if index==2 else 3 if index==3 else 100) and quote['estimated_cost']==str((1<<240)+17+index)
   if index==0:assert quote['batch'] is None
  else:assert op.get('starknet') is None
 assert len(value['rows'][0]['operation']['identity']['hex'])==66
 signature=value['rows'][1]['operation']['identity']['hex'];assert len(signature)==130 and signature[2:66]!=signature[66:]
 batch=value['rows'][2]['operation']['starknet']['batch'];assert batch==value['rows'][3]['operation']['starknet']['batch']
 assert set(batch)=={'version','members'} and batch['version']==1 and len(batch['members'])==2
 assert [m['operation_id']for m in batch['members']]==[r['id']for r in expected['rows'][2:4]]
 for index,member in enumerate(batch['members'],2):
  assert set(member)=={'operation_id','origin','origin_hook','generation','source_intent_digest','gas_limit','estimated_cost'}
  assert member['origin']==9913371 and member['origin_hook']=='0x'+'00'*31+'55' and member['generation']==1
  assert member['gas_limit']==(1 if index==2 else 3) and member['estimated_cost']==str((1<<240)+17+index)
  assert member['source_intent_digest'].startswith('0x') and len(bytes.fromhex(member['source_intent_digest'][2:]))==32
 assert sum(int(row['gas_used_hex'],16)for row in expected['rows'][2:4])+1==(1<<200)+101
 assert sum(int(row['tokens_used_hex'],16)for row in expected['rows'][2:4])+1==(1<<240)+17

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--writer',type=pathlib.Path,required=True);parser.add_argument('--reader',type=pathlib.Path,required=True);parser.add_argument('--reader-sha256',required=True);parser.add_argument('--old-oracle',type=pathlib.Path,default=ROOT/'zig/bench/results/disk-preparation-20261106/rocks-helper-functional/ziggy-rocks-oracle');parser.add_argument('--message-reference',type=pathlib.Path,default=ROOT/'zig/reference/target/release/ziggy-rust-reference');parser.add_argument('--output',type=pathlib.Path,required=True);args=parser.parse_args()
 assert len(args.reader_sha256)==64 and all(c in'0123456789abcdef'for c in args.reader_sha256)
 records={'writer':artifact(args.writer),'native_reader':artifact(args.reader,args.reader_sha256),'old_canonical_oracle':artifact(args.old_oracle,OLD_SHA),'rust_message_reference':artifact(args.message_reference,REFERENCE_SHA)}
 root=pathlib.Path(tempfile.mkdtemp(prefix='ziggy-native-rows-interop-v2-',dir='/tmp'));root.chmod(0o700)
 with(root/'fixture.marker').open('xb')as marker:marker.write(b'ziggy-native-rows-interop-v2\n')
 source_before={name:sha(ROOT/name)for name in ['zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py']}
 writer=None;stderr=(root/'writer.stderr').open('w');result={'passed':False,'scope':__doc__,'fixture_root':str(root),'artifacts':records,'source_before':source_before,'errors':[],'actual_chain_or_SDK_signature_acceptance':False,'elapsed_confirmation_hold_credit_ms':0}
 try:
  assert not(root/'db').exists()
  command=[records['writer']['path'],'write-hold',str(root)];writer=subprocess.Popen(command,cwd=ROOT,env={},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True)
  selector=selectors.DefaultSelector();selector.register(writer.stdout,selectors.EVENT_READ)
  try:assert selector.select(timeout=20),'writer readiness timeout'
  finally:selector.close()
  expected=safe(writer.stdout.readline());assert expected['mode']=='write-hold' and expected['confirmation_policy_ms']==600000 and expected['elapsed_hold_credit_ms']==0 and expected['broadcasts']==0
  (root/'writer-ready.json').write_text(json.dumps(expected,indent=2)+'\n')
  request={'marker':'ziggy-native-rows-readonly-v1','db_path':str(root/'db'),'origin_namespace':'test1','origin':9913371,'destination':9913372,'operations':[{'id':row['id'],'nonce':row['nonce'],'kind':'process','target':None,'context':row['context']}for row in expected['rows']]}
  request_path=root/'request.json';request_path.write_text(json.dumps(request))
  locked=invoke([records['native_reader']['path'],request_path],root,'live-writer-refusal');assert locked.returncode!=0 and 'LiveWriterOrLockUnavailable' in locked.stderr
  started=time.monotonic();remaining,_=writer.communicate(input='\n',timeout=15);assert writer.returncode==0 and not remaining
  result['writer_wait_receipt']={'pid':writer.pid,'exit_code':writer.returncode,'wait_returned':True,'ended_monotonic':time.monotonic(),'wait_seconds':time.monotonic()-started,'scope':'actual fixture writer reaped before either stopped reader'}
  stderr.close();assert not any(value in(root/'writer.stderr').read_text()for value in FORBIDDEN)
  # Original canonical oracle opens a writer: it MUST finish before native read.
  old=invoke([records['old_canonical_oracle']['path'],'relayer-probe-all',root/'db','9913371','test1',str(COUNT),json.dumps({'9913372':'test2'})],root,'old-canonical-first');assert old.returncode==0;canonical=safe(old.stdout)
  wires=[]
  for index in range(COUNT):wires.append(bytes([3])+struct.pack('>II',index,9913371)+b'\x11'*32+struct.pack('>I',9913372)+b'\x22'*32+f'native-rows-public-message-{index}'.encode())
  vectors=invoke([records['rust_message_reference']['path'],'vectors'],root,'rust-message-vectors',input=''.join(w.hex()+'\n'for w in wires));assert vectors.returncode==0;vectors=[json.loads(line)for line in vectors.stdout.splitlines()];assert len(vectors)==COUNT
  assert canonical['origin_domain']==9913371 and canonical['origin_namespace']=='test1' and canonical['origin_nonce_count']==COUNT and not canonical['sealed_payload_links']
  for index,(written,observed,vector,wire)in enumerate(zip(expected['rows'],canonical['messages'],vectors,wires)):
   assert bytes.fromhex(vector['encoded'].removeprefix('0x'))==wire
   assert vector['id'].removeprefix('0x')==written['id'].removeprefix('0x')==''.join(observed['id_chunks'])
   assert written['message_wire']=={'bytes':len(wire),'sha256':'0x'+hashlib.sha256(wire).hexdigest()}
   assert observed['present'] is True and observed['nonce']==index and observed['origin']==9913371 and observed['destination']==9913372 and observed['processed'] is False and not observed['payloads']
   assert observed['gas_expenditure_record_present'] is True
   assert int(observed['spent']['gas_used'])==int(written['gas_used_hex'],16) and int(observed['spent']['tokens_used'])==int(written['tokens_used_hex'],16)
   assert int(observed['payment']['payment'])==int(written['payment_hex'],16) and int(observed['payment']['gas_amount'])==int(written['payment_gas_hex'],16)
  before=database_files(root/'db');read=invoke([records['native_reader']['path'],request_path],root,'native-reader');assert read.returncode==0;value=safe(read.stdout);verify_native(expected,value);assert database_files(root/'db')==before
  wrong_recipient=copy.deepcopy(value);wrong_recipient['rows'][4]['operation']['authority']['target']='0x'+'00'*31+'78'
  try:verify_native(expected,wrong_recipient)
  except AssertionError:pass
  else:raise AssertionError('AleoWrongResolvedRecipientAccepted')
  assert database_files(root/'db')==before
  negative=[]
  for label,field,replacement,error in [('wrong-context','context','0x'+'99'*32,'ContextMismatch'),('wrong-nonce','nonce',99,'RowAuthorityMismatch')]:
   wrong=copy.deepcopy(request);wrong['operations'][0][field]=replacement;path=root/(label+'.json');path.write_text(json.dumps(wrong));attempt=invoke([records['native_reader']['path'],path],root,label);assert attempt.returncode!=0 and error in attempt.stderr;assert database_files(root/'db')==before;negative.append(label)
  missing=copy.deepcopy(request);missing['operations'][0]['id']='0x'+'ff'*32;path=root/'missing-id.json';path.write_text(json.dumps(missing));attempt=invoke([records['native_reader']['path'],path],root,'missing-id');assert attempt.returncode==0;absent=safe(attempt.stdout);assert absent['complete'] is False and absent['rows'][0]['present'] is False and 'operation'not in absent['rows'][0];assert database_files(root/'db')==before;negative.append('missing-id-is-not-acceptance')
  reopened=invoke([records['writer']['path'],'reopen',root],root,'actual-zig-readonly-reopen');assert reopened.returncode==0;again=safe(reopened.stdout);assert again['mode']=='reopen' and again['rows']==expected['rows'] and again['broadcasts']==0;assert database_files(root/'db')==before
  reread=invoke([records['native_reader']['path'],request_path],root,'native-reader-after-zig-reopen');assert reread.returncode==0;assert safe(reread.stdout)==value and database_files(root/'db')==before
  assert all(artifact(pathlib.Path(item['path']))==item for item in records.values())
  result.update(passed=True,writer_expected=expected,canonical_rust_readback=canonical,native_readback=value,negative_controls=negative,all_database_files_unchanged_by_readers_or_readonly_reopen=True,database_file_hashes_after_old_oracle=before,actual_policy_ms=600000,full_identity_widths=[32,64],large_u256_costs_exact=True,public_starknet_frozen_quotes_exact=True,actual_production_group_journal_and_signed_barrier=True,unequal_group_gas_weights=[1,3],group_synthetic_cost_rounding_dust={"gas":1,"tokens":1},aleo_process_row_null_target_with_prepared_resolved_target=True,wrong_resolved_recipient_family_control=True,cost_marker_idempotence_verified_by_actual_writer=True,reopened_signed_bytes_identical=True,old_and_new_oracles_sequential=True)
 except BaseException as error:
  result['errors'].append({'type':type(error).__name__,'detail':str(error)if isinstance(error,ValueError)else'interoperability assertion failed; private stopped fixture retained'})
  raise
 finally:
  if writer is not None and writer.poll()is None:
   try:writer.communicate(input='\n',timeout=10)
   except (subprocess.TimeoutExpired,BrokenPipeError):writer.kill();writer.wait()
  if not stderr.closed:stderr.close()
  result['source_after']={name:sha(ROOT/name)for name in source_before};result['source_unchanged']=result['source_after']==source_before
  if not result['source_unchanged']:result['passed']=False;result['errors'].append({'type':'SourceChanged','detail':'fixture source changed during execution'})
  result['owned_process_cleanup']={'writer_reaped':writer is None or writer.poll()is not None,'no_nodes_or_agent_roles_launched':True,'fixture_retained_for_evidence':True};args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
 if not result['passed']:raise AssertionError('InteropSourceChanged')
 print(json.dumps({'passed':True,'structural_storage_interop_only':True,'elapsed_confirmation_hold_credit_ms':0,'fixture_root':str(root)}))
if __name__=='__main__':main()
