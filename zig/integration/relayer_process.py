#!/usr/bin/env python3
"""Actual relayer executable on disposable Anvil/repository contracts/public key11.

Correctness + durable recovery, not a throughput benchmark or production rollout.
Rust HyperlaneRocksDB/FullPayload reads independently decode the stopped database.
"""
from __future__ import annotations
import argparse,collections,contextlib,hashlib,http.server,json,math,os,pathlib,re,shutil,signal,socket,subprocess,sys,tempfile,threading,time,urllib.error,urllib.request
import evm
ROOT=evm.ROOT
ORIGIN,DESTINATION=9913371,9913372
DELIVERED_SELECTOR=evm.calldata('delivered(bytes32)','0x'+'00'*32)[:10]
def record_first_inclusion(mapping,key,observed_monotonic_seconds,observed_unix_seconds,capacity=4096):
 if key not in mapping:
  if len(mapping)>=capacity:mapping.pop(next(iter(mapping)))
  mapping[key]={'monotonic':observed_monotonic_seconds,'unix':observed_unix_seconds}
 return mapping[key]
def capture_proxy_response(owner,method,request,body,requested_unix_seconds):
 value=json.loads(body);observed_monotonic=time.monotonic();observed=time.time()
 if method=='eth_sendRawTransaction'and'result'in value:
  owner.raw_transactions.append(value['result']);owner.broadcasts.append({'hash':value['result'],'requested_unix_seconds':requested_unix_seconds,'confirmed_unix_seconds':observed})
 if method=='eth_estimateGas'and'result'in value:
  call=request['params'][0];owner.estimates.append({'from':call.get('from'),'to':call.get('to'),'data':call.get('data'),'block':request['params'][1]if len(request['params'])>1 else None,'result':value['result'],'unix_seconds':observed})
 if method=='eth_getTransactionReceipt'and value.get('result')is not None:record_first_inclusion(owner.receipt_inclusions,request['params'][0].lower(),observed_monotonic,observed)
 if method=='eth_call'and value.get('result')is not None:
  call=request['params'][0];data=call.get('data','')
  if data.startswith(DELIVERED_SELECTOR)and len(data)==len(DELIVERED_SELECTOR)+64 and int(value['result'],16)==1:record_first_inclusion(owner.delivered_inclusions,'0x'+data[-64:].lower(),observed_monotonic,observed)
class RpcProxy:
 def __init__(self,chain,delay=0,fail_method=None):self.chain=chain;self.delay=delay;self.fail_method=fail_method;self.methods=collections.Counter();self.stop=threading.Event();self.stall_receipts=False;self.receipt_stalls=0;self.raw_transactions=[];self.broadcasts=[];self.estimates=[];self.receipt_inclusions={};self.delivered_inclusions={}
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def do_POST(self):
    request=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));method=request['method'];owner.methods[method]+=1;requested_unix_seconds=time.time()
    if owner.delay:time.sleep(owner.delay)
    if method=='eth_getTransactionReceipt'and owner.stall_receipts:owner.receipt_stalls+=1;owner.stop.wait(30);self.close_connection=True;return
    try:
     upstream=urllib.request.Request(owner.chain.url,data=json.dumps(request).encode(),headers={'Content-Type':'application/json'})
     if method==owner.fail_method:body=json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32000,'message':'public fixture endpoint failure'}}).encode()
     else:
      with urllib.request.urlopen(upstream,timeout=20)as response:body=response.read()
     capture_proxy_response(owner,method,request,body,requested_unix_seconds)
     self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    except (BrokenPipeError,ConnectionResetError,urllib.error.URLError):self.close_connection=True
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):daemon_threads=True
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.stop.set();self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
def chunks(value):return[value[i:i+32]for i in range(0,len(value),32)]
def sha(path):return chunks(hashlib.sha256(path.read_bytes()).hexdigest())
def pin(path,label):
 path=path.resolve();data=path.read_bytes();digest=hashlib.sha256(data).hexdigest();target=ROOT/'zig/integration/.cache/relayer-binaries'/digest[:32]/label;target.parent.mkdir(parents=True,exist_ok=True)
 if not target.exists():target.write_bytes(data);target.chmod(0o755)
 assert target.read_bytes()==data and path.read_bytes()==data,'binary changed while pinning'
 return target
def port():
 with socket.socket()as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
def launch(binary,config,log,extra_environment=None):
 environment={'HYPERLANE_ZIG_DEFAULTS':str(config),'HYPERLANE_CURL_LIBRARY':'/usr/lib/libcurl.4.dylib'};environment.update(extra_environment or {})
 launched=time.time();process=subprocess.Popen([str(binary)],cwd=ROOT,env=environment,stdout=log,stderr=log);process.ziggy_launch_unix_seconds=launched
 return process
def stop(process,hard=False):
 began=time.monotonic()
 if process.poll()is None:process.kill()if hard else process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill();process.wait();raise AssertionError('agent shutdown exceeded10s')
 return {'exit':process.returncode,'milliseconds':(time.monotonic()-began)*1000,'signal':'SIGKILL'if hard else'SIGTERM'}
def wait(predicate,process,seconds,description):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  if process.poll()is not None:raise AssertionError(f'agent exited{process.returncode} while waiting for{description}')
  if predicate():return
  time.sleep(.05)
 raise AssertionError(f'deadline waiting for{description}')
def crash_library():
 source=ROOT/'zig/integration/faults/seal_crash.c';identity=hashlib.sha256(source.read_bytes()).hexdigest();library=ROOT/'zig/integration/.cache'/('seal-crash-'+identity[:32]+'.dylib')
 command=['/usr/bin/clang','-dynamiclib','-O2','-Wall','-Wextra','-Werror','-isysroot','/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk',str(source),'-o',str(library)]
 if not library.exists():subprocess.run(command,cwd=ROOT,check=True,capture_output=True)
 return library,{'scope':'fixture-only dyld interposition after actual task-owned WAL write; unchanged executable','library_sha256_chunks':sha(library),'source_sha256_chunks':sha(source),'compile_command':command}
def verify_crash_library(library):
 source=ROOT/'zig/integration/faults/seal_crash_test.c';identity=hashlib.sha256(source.read_bytes()).hexdigest();writer=ROOT/'zig/integration/.cache'/('seal-crash-test-'+identity[:32])
 if not writer.exists():subprocess.run(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-isysroot','/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk',str(source),'-o',str(writer)],check=True,capture_output=True)
 with tempfile.TemporaryDirectory(prefix='ziggy-public-relayer-process-interposer-')as directory:
  root=pathlib.Path(directory);database=root/'crash-db-0';database.mkdir();other=root/'control-db';other.mkdir();proof=root/'proof.json'
  environment={'DYLD_INSERT_LIBRARIES':str(library),'ZIGGY_SEAL_CRASH_DATABASE':str(database.resolve()),'ZIGGY_SEAL_CRASH_PROOF':str(proof.resolve())}
  control=subprocess.run([str(writer),str(other/'000004.log'),str(root/'control-after')],env=environment,timeout=3)
  assert control.returncode==0 and(root/'control-after').exists()and not proof.exists(),'unrelated path must never arm fault'
  armed=subprocess.run([str(writer),str(database/'000004.log'),str(root/'after')],env=environment,timeout=3)
  assert armed.returncode==-signal.SIGKILL and proof.exists()and not(root/'after').exists(),'fault must kill after durable WAL write before returning'
 return {'positive_real_write_sigkill':True,'unrelated_path_negative_control':True,'source_sha256_chunks':sha(source),'writer_sha256_chunks':sha(writer)}
def compile_contracts():
 evm.CACHE=ROOT/'zig/integration/.cache/relayer-contracts';evm.CACHE.mkdir(parents=True,exist_ok=True)
 evm.CONTRACTS={name:path for name,path in evm.CONTRACTS.items()if name in ['Mailbox','MerkleTreeHook','TestIsm','TestRecipient','TestPostDispatchHook','StorageMessageIdMultisigIsm','StorageMerkleRootMultisigIsm']}
 evm.CONTRACTS.update(ValidatorAnnounce='solidity/contracts/isms/multisig/ValidatorAnnounce.sol',InterchainGasPaymaster='solidity/contracts/hooks/igp/InterchainGasPaymaster.sol',StorageGasOracle='solidity/contracts/hooks/igp/StorageGasOracle.sol')
 return evm.compile_contracts()
def metric_value(body,name,labels):
 prefix=name.encode()+b'{'+labels.encode()+b'} '
 for line in body.splitlines():
  if line.startswith(prefix):return float(line[len(prefix):])
 raise AssertionError(f'missing actual metric sample {name}{{{labels}}}')
def metric_observation(body, name, labels):
    """Absent child series is evidence of absence, never an invented zero."""
    def parse_labels(text):
        result = {}
        offset = 0
        while offset < len(text):
            match = re.match(r'([a-zA-Z_][a-zA-Z_0-9]*)=("(?:[^"\\]|\\.)*")', text[offset:])
            assert match is not None, 'malformed metric labels'
            key, encoded = match.groups()
            assert key not in result, 'duplicate metric label'
            result[key] = json.loads(encoded)
            offset += match.end()
            if offset < len(text):
                assert text[offset] == ',', 'malformed metric separator'
                offset += 1
                assert offset < len(text), 'trailing metric separator'
        return result
    expected = parse_labels(labels)
    value = None
    family_present = False
    seen = set()
    for line in body.decode().splitlines():
        if not line.startswith(name + '{'):
            continue
        family_present = True
        match = re.fullmatch(re.escape(name) + r'\{(.*)\} ([^ ]+)', line)
        assert match is not None, 'malformed metric sample'
        actual = parse_labels(match[1])
        assert actual.keys() == expected.keys(), 'wrong metric label schema'
        for key in ('agent', 'hyperlane_baselib_version'):
            if key in expected:
                assert actual[key] == expected[key], 'wrong metric agent/version'
        identity = tuple(sorted(actual.items()))
        assert identity not in seen, 'duplicate metric sample'
        seen.add(identity)
        try:
            number = float(match[2])
        except ValueError as error:
            raise AssertionError('malformed metric value') from error
        assert math.isfinite(number) and number >= 0 and number.is_integer(), 'invalid integer metric value'
        if actual == expected:
            value = int(number)
    return {'value': value, 'present': value is not None, 'family_present': family_present}

def telemetry(metrics_port):
 url=f'http://127.0.0.1:{metrics_port}/metrics'
 with urllib.request.urlopen(url,timeout=3)as response:body=response.read();status=response.status
 with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=3)as response:head_body=response.read();head_status=response.status
 assert status==200 and head_status==200 and not head_body,(status,head_status,len(head_body))
 assert b'agent="relayer"'in body and b'hyperlane_baselib_version="3.0.0"'in body,'source core metric labels missing'
 base='agent="relayer",hyperlane_baselib_version="3.0.0"'
 events={
  'lander_finalized':metric_value(body,'hyperlane_lander_finalized_transactions','destination="test2"'),
  'lander_submissions':metric_value(body,'hyperlane_lander_transaction_submissions','destination="test2"'),
  'lander_status_reads':metric_value(body,'hyperlane_lander_status_read_requests','destination="test2",stage="InclusionStage"'),
  'messages_processed':metric_value(body,'hyperlane_messages_processed_count',f'origin="test1",remote="test2",{base}'),
  'last_processed_nonce':metric_value(body,'hyperlane_last_known_message_nonce',f'phase="message_processed",origin="test1",{base}'),
  'metadata_build_success':metric_value(body,'hyperlane_metadata_build_count',f'app_context="Unknown",origin="test1",remote="test2",status="success",{base}'),
  'metadata_build_duration':metric_value(body,'hyperlane_metadata_build_duration',f'app_context="Unknown",origin="test1",remote="test2",status="success",{base}'),
  'pending_active':metric_value(body,'hyperlane_pending_message_active',f'app_context="Unknown",origin="test1",remote="test2",{base}'),
  'confirm_queue':metric_value(body,'hyperlane_submitter_queue_length',f'remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",{base}'),
 }
 for phase in ['prepared','submitted','confirmed']:
  events[f'operation_{phase}']=metric_value(body,'hyperlane_operations_processed_count',f'app_context="Unknown",phase="{phase}",chain="test2",{base}')
 assert events['lander_finalized']>=3 and events['lander_submissions']>=3 and events['lander_status_reads']>0,events
 assert events['messages_processed']==3 and events['last_processed_nonce']==2,events
 assert events['metadata_build_success']>=3 and events['metadata_build_duration']>0,events
 assert all(events[f'operation_{phase}']>=3 for phase in ['prepared','submitted','confirmed']),events
 assert events['pending_active']==0 and events['confirm_queue']==0,events
 return {'get_status':status,'head_status':head_status,'head_bytes':len(head_body),'bytes':len(body),'sha256_chunks':chunks(hashlib.sha256(body).hexdigest()),'source_base_version':'3.0.0','agent':'relayer','event_metrics':events}
def rust_probe(oracle,database,count):
 result=subprocess.run([str(oracle),'relayer-probe',str(database),str(ORIGIN),'test1',str(DESTINATION),'test2',str(count)],cwd=ROOT,env={},capture_output=True,text=True,timeout=30)
 if result.returncode:raise AssertionError(result.stderr[-4000:])
 return json.loads(result.stdout)
SOURCE_CONFIRM_SECONDS=600
SOURCE_FINALITY_GRACE_SECONDS=30
MULTICALL3='0xcA11bde05977b3631167028862bE2a173976CA11'
IMMUTABLE_ORACLE=ROOT/'zig/bench/results/disk-preparation-20261106/rocks-helper-functional/ziggy-rocks-oracle'
IMMUTABLE_ORACLE_SHA256='8e295002b44b4248d00d6627aaa47a21'+'2315f6f837f3a2d652f2e7f6ada69fd9'
def verified_oracle(path):
 path=path.resolve();assert hashlib.sha256(path.read_bytes()).hexdigest()==IMMUTABLE_ORACLE_SHA256,'oracle does not match accepted immutable sidecar-proof helper';return path
def message_transaction(chain,proxy,message):
 matches=[]
 for transaction_hash in dict.fromkeys(proxy.raw_transactions):
  transaction=chain.rpc('eth_getTransactionByHash',[transaction_hash])
  if transaction and transaction.get('blockNumber')is not None and message['wire']in transaction['input']:matches.append(transaction)
 assert len(matches)==1,('message transaction identity mismatch',len(matches));return matches[0]
def proxy_inclusion(proxy,chain,message):
 transaction=message_transaction(chain,proxy,message);candidates=[]
 if transaction['hash'].lower()in proxy.receipt_inclusions:candidates.append(proxy.receipt_inclusions[transaction['hash'].lower()])
 if message['id'].lower()in proxy.delivered_inclusions:candidates.append(proxy.delivered_inclusions[message['id'].lower()])
 return (min(candidates,key=lambda value:value['monotonic'])if candidates else None),transaction
def observe_inclusions(delivered,messages,process,description,proxy,chain,mailbox,seconds=90):
 pending={id(message)for message in messages if'included_monotonic'not in message}
 deadline=time.monotonic()+seconds
 while pending and time.monotonic()<deadline:
  if process.poll()is not None:raise AssertionError(f'agent exited{process.returncode}while waiting for{description}')
  for message in messages:
   if id(message)in pending and delivered(message['id']):
    observed,transaction=proxy_inclusion(proxy,chain,message)
    if observed is not None:
     message['included_unix_seconds']=observed['unix'];message['included_monotonic']=observed['monotonic'];message['included_transaction_hash']=transaction['hash'];pending.remove(id(message))
  if pending:time.sleep(.05)
 if pending:raise AssertionError(f'deadline waiting for{description} with actual proxy inclusion evidence')
def retirement_lower_bound(messages,now_monotonic_seconds):
 assert messages and all('included_monotonic'in message for message in messages),'retirement requires first actual proxy inclusion'
 return now_monotonic_seconds>=max(message['included_monotonic']for message in messages)+SOURCE_CONFIRM_SECONDS
def retirement_deadline(messages,grace=SOURCE_FINALITY_GRACE_SECONDS):
 assert messages and all('included_monotonic'in message for message in messages),'retirement requires actual observed inclusion'
 return max(message['included_monotonic']for message in messages)+SOURCE_CONFIRM_SECONDS+grace
def retirement_poll(operations,confirmed,messages,now_monotonic_seconds,historical_confirmed_offset=0):
 assert messages and all('included_monotonic'in message for message in messages),'retirement requires first actual proxy inclusion'
 assert isinstance(operations,list)and historical_confirmed_offset>=0
 eligible=sum(now_monotonic_seconds>=message['included_monotonic']+SOURCE_CONFIRM_SECONDS for message in messages)
 allowed=historical_confirmed_offset+eligible
 if confirmed is not None:assert type(confirmed)in(int,float)and math.isfinite(confirmed)and confirmed>=0 and int(confirmed)==confirmed,'invalid confirmed counter'
 if confirmed is not None and confirmed>allowed:raise AssertionError(f'partial early retirement: confirmed={confirmed},historical_offset={historical_confirmed_offset},eligible_after600={eligible},now_monotonic={now_monotonic_seconds}')
 active_ids={operation['id'].lower()for operation in operations}
 assert len(active_ids)==len(operations),'duplicate active operation ID'
 for message in messages:
  if now_monotonic_seconds<message['included_monotonic']+SOURCE_CONFIRM_SECONDS and message['id'].lower()not in active_ids:raise AssertionError(f'tracked operation disappeared before its own600s bound: {message["id"]}')
 return not operations and confirmed is not None and confirmed==historical_confirmed_offset+len(messages)and retirement_lower_bound(messages,now_monotonic_seconds)
def wait_for_retirement(metrics_port,process,messages,destination_domain=DESTINATION,historical_confirmed_offset=0,historical_offset_reason='no older operations in this process'):
    first_completion = None
    first_counter = None
    first_observation = None
    absent_samples = 0
    polls = 0
    def settled():
        nonlocal first_completion, first_counter, first_observation, absent_samples, polls
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/list_operations?destination_domain={destination_domain}',timeout=3) as response:
                operations = json.loads(response.read())
            with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/metrics',timeout=3) as response:
                body = response.read()
        except (OSError,ValueError):
            return False
        base = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
        observation = metric_observation(body, 'hyperlane_operations_processed_count', f'app_context="Unknown",phase="confirmed",chain="test2",{base}')
        confirmed = observation['value']
        now = time.monotonic()
        polls += 1
        if first_observation is None:
            first_observation = dict(observation, monotonic=now)
        if confirmed is None:
            absent_samples += 1
        elif first_counter is None:
            first_counter = confirmed
        # ID disappearance/individual600s eligibility checks run even without a
        # materialized confirmed counter. Missing telemetry cannot complete.
        complete = retirement_poll(operations, confirmed, messages, now, historical_confirmed_offset)
        if complete and first_completion is None:
            first_completion = {'monotonic': now, 'unix': time.time(), 'confirmed': confirmed}
        return complete
    began = time.monotonic()
    wait(settled,process,max(1,retirement_deadline(messages)-began),'live completion polling with production600s lower bound')
    assert retirement_lower_bound(messages,time.monotonic()), 'retirement observed before first actual proxy inclusion plus600'
    with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/metrics',timeout=3) as response:
        body = response.read()
    base = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
    confirmed = metric_value(body,'hyperlane_operations_processed_count',f'app_context="Unknown",phase="confirmed",chain="test2",{base}')
    confirm_queue = metric_value(body,'hyperlane_submitter_queue_length',f'remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",{base}')
    assert confirmed > 0 and confirmed == historical_confirmed_offset+len(messages) and confirm_queue == 0, (confirmed,confirm_queue,historical_confirmed_offset,len(messages))
    observed = time.time()
    required = max(message['included_unix_seconds'] for message in messages)+SOURCE_CONFIRM_SECONDS
    return {'production_confirm_seconds':SOURCE_CONFIRM_SECONDS,'bounded_grace_seconds':SOURCE_FINALITY_GRACE_SECONDS,'wait_seconds':time.monotonic()-began,'deadline_from_latest_actual_inclusion':retirement_deadline(messages),'latest_included_unix_seconds':max(message['included_unix_seconds'] for message in messages),'required_earliest_retirement_unix_seconds':required,'actual_retirement_unix_seconds':observed,'retirement_after_required_seconds':observed-required,'first_live_completion':first_completion,'historical_confirmed_offset':historical_confirmed_offset,'historical_offset_is_upper_bound_not_injected_counter':True,'first_actual_confirmed_counter':first_counter,'first_confirmed_counter_observation':first_observation,'confirmed_counter_absent_samples':absent_samples,'polls':polls,'historical_offset_reason':historical_offset_reason,'expected_tracked_messages':len(messages),'first_proxy_inclusions':[{'id_chunks':chunks(message['id']),'transaction_hash_chunks':chunks(message['included_transaction_hash']),'first_positive_receipt_or_delivered_unix_seconds':message['included_unix_seconds'],'first_positive_receipt_or_delivered_monotonic_seconds':message['included_monotonic']} for message in messages],'operations_confirmed':confirmed,'confirm_queue':confirm_queue}
def wait_role_ready(metrics_port,process,data_type='dispatched_messages',chain='test1'):
 launched=getattr(process,'ziggy_launch_unix_seconds',None);assert launched is not None,'missing actual process launch time'
 evidence={'data_type':data_type,'chain':chain,'launch_unix_seconds':launched,'liveness':None}
 def ready():
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/metrics',timeout=2)as response:body=response.read()
   with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/list_operations?destination_domain={DESTINATION}',timeout=2)as response:operations=json.loads(response.read())
   if b'agent="relayer"'not in body or not isinstance(operations,list):return False
   base='agent="relayer",hyperlane_baselib_version="3.0.0"'
   liveness=metric_value(body,'hyperlane_contract_sync_liveness',f'data_type="{data_type}",chain="{chain}",task="cursor_task",{base}')
   evidence['liveness']=liveness
   return liveness>=int(launched)
  except (OSError,ValueError,AssertionError):return False
 wait(ready,process,30,f'fresh current-process {data_type} source cycle readiness')
 return evidence
def early_included_snapshot(body, operations, origin, latest_nonce, messages, now, initial=False, aggregate=True):
    assert isinstance(operations, list) and messages, 'missing per-ID early witness'
    by_id = {}
    for row in operations:
        assert isinstance(row, dict), 'corrupt admin row'
        identity = row.get('id')
        assert isinstance(identity, str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', identity), 'malformed admin ID'
        identity = identity.lower()
        assert identity not in by_id, 'duplicate admin ID'
        by_id[identity] = row
    known = set()
    witnesses = []
    ready = True
    for message in messages:
        identity = message['id'].lower()
        assert re.fullmatch(r'0x[0-9a-f]{64}', identity) and identity not in known, 'duplicate/invalid tracked ID'
        known.add(identity)
        included = message['included_monotonic']
        assert math.isfinite(included) and math.isfinite(now) and 0 <= now-included < SOURCE_CONFIRM_SECONDS, 'early witness outside actual per-ID600s hold'
        assert identity in by_id, 'tracked operation disappeared before its own600s bound'
        try:
            wire = bytes.fromhex(message['wire'])
        except ValueError as error:
            raise AssertionError('invalid known message wire') from error
        assert len(wire) >= 77, 'truncated known message wire'
        expected = {'version':wire[0], 'nonce':int.from_bytes(wire[1:5],'big'), 'origin':int.from_bytes(wire[5:9],'big'), 'sender':'0x'+wire[9:41].hex(), 'destination':int.from_bytes(wire[41:45],'big'), 'recipient':'0x'+wire[45:77].hex(), 'body':list(wire[77:])}
        assert expected['origin'] == {'test1':ORIGIN, 'test3':9913373}[origin] and expected['destination'] == DESTINATION, 'known message domain mismatch'
        operation = by_id[identity].get('operation')
        assert isinstance(operation, dict) and operation.get('type') == 'PendingMessage', 'corrupt admin operation type'
        actual = operation.get('message')
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), 'corrupt admin message schema'
        for key in ('version','nonce','origin','destination'):
            assert type(actual[key]) is int, 'corrupt admin numeric field'
        assert isinstance(actual['body'], list) and all(type(value) is int and 0 <= value <= 255 for value in actual['body']), 'corrupt admin message body'
        assert actual == expected, 'admin message does not match exact known wire/domain/nonce'
        status = operation.get('status')
        if status == {'Confirm':'SubmittedBySelf'}:
            assert operation.get('submitted') is True, 'Confirm operation not submitted'
        else:
            # Inclusion can precede the next bounded actor poll. Permit only
            # known pre-confirm states while waiting; never excuse a missing ID.
            assert status in ('FirstPrepareAttempt','ReadyToSubmit') and operation.get('submitted') is False, 'corrupt/unexpected admin status'
            ready = False
        witnesses.append({'id_chunks':chunks(identity), 'message':expected, 'status':status, 'submitted':operation['submitted'], 'first_actual_inclusion_monotonic':included, 'observed_monotonic':now, 'age_seconds':now-included, 'active':True})
    base = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
    samples = {
        'messages_processed':metric_observation(body,'hyperlane_messages_processed_count',f'origin="{origin}",remote="test2",{base}'),
        'last_processed_nonce':metric_observation(body,'hyperlane_last_known_message_nonce',f'phase="message_processed",origin="{origin}",{base}'),
        'operations_confirmed':metric_observation(body,'hyperlane_operations_processed_count',f'app_context="Unknown",phase="confirmed",chain="test2",{base}'),
    }
    processed, last, confirmed = (samples[key]['value'] for key in ('messages_processed','last_processed_nonce','operations_confirmed'))
    if initial:
        assert processed in (None,0) and confirmed in (None,0) and last in (None,0), 'positive early completion metric'
    if processed is not None:
        assert processed <= latest_nonce and (processed == 0 or (last is not None and last < latest_nonce)), 'processed metric exceeds early bound'
    if last is not None and last > 0:
        assert last < latest_nonce, 'last nonce reaches fresh early message'
    if aggregate and confirmed is not None:
        assert confirmed <= latest_nonce, 'confirmed metric exceeds early bound'
    mandatory = {
        'self_submitted':metric_observation(body,'hyperlane_lander_transaction_submissions','destination="test2"'),
        'confirm_queue':metric_observation(body,'hyperlane_submitter_queue_length',f'remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",{base}'),
        'submitted_phase':metric_observation(body,'hyperlane_operations_processed_count',f'app_context="Unknown",phase="submitted",chain="test2",{base}'),
    }
    submissions, confirm_queue = mandatory['self_submitted']['value'], mandatory['confirm_queue']['value']
    if ready:
        assert all(sample['present'] and sample['value'] > 0 for sample in mandatory.values()), 'missing positive Confirm/submission metrics'
    return {'messages_processed':processed,'last_processed_nonce':last,'operations_confirmed':confirmed,'metric_observations':samples,'mandatory_metric_observations':mandatory,'nonce_observed_without_processed':last is not None and processed is None,'self_submitted':submissions,'confirm_queue':confirm_queue,'latest_included_nonce':latest_nonce,'aggregate_checked':aggregate,'per_id_active_confirm_witnesses':witnesses,'ready':ready,'early_not_retired':ready,'metrics_sha256_chunks':chunks(hashlib.sha256(body).hexdigest())}

def early_included_guard(metrics_port,origin,latest_nonce,messages,initial=False,aggregate=True):
    deadline = time.monotonic()+5
    while True:
        with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/list_operations?destination_domain={DESTINATION}',timeout=3) as response:
            operations = json.loads(response.read())
        with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/metrics',timeout=3) as response:
            body = response.read()
        result = early_included_snapshot(body,operations,origin,latest_nonce,messages,time.monotonic(),initial,aggregate)
        if result['ready']:
            return result
        assert time.monotonic() < deadline, 'bounded wait for active Confirm witnesses expired'
        time.sleep(.05)
def deploy_multicall3(chain):
 source=(ROOT/'rust/main/utils/run-locally/src/ethereum/multicall.rs').read_text();marker='SIGNED_DEPLOY_MULTICALL_TX: &str = "';start=source.index(marker)+len(marker);deployment=source[start:source.index('";',start)]
 if chain.rpc('eth_getCode',[MULTICALL3,'latest'])=='0x':
  chain.rpc('anvil_setBalance',['0x05f32B3cC3888453ff71B01135B34FF8e41263F2',hex(10**18)]);chain.receipt(chain.rpc('eth_sendRawTransaction',[deployment]))
 assert chain.rpc('eth_getCode',[MULTICALL3,'latest'])!='0x'
 return MULTICALL3
def abi_word(data,offset):return int.from_bytes(data[offset:offset+32],'big')
def decode_aggregate3(calldata):
 data=bytes.fromhex(calldata.removeprefix('0x'));assert data[:4].hex()=='82ad56cb','actual transaction is not Multicall3 aggregate3'
 array=4+abi_word(data,4);count=abi_word(data,array);offsets=array+32;calls=[]
 for index in range(count):
  tuple_start=offsets+abi_word(data,offsets+index*32);target='0x'+data[tuple_start+12:tuple_start+32].hex();assert abi_word(data,tuple_start+32)==1
  encoded_start=tuple_start+abi_word(data,tuple_start+64);length=abi_word(data,encoded_start);calls.append({'to':target,'calldata':data[encoded_start+32:encoded_start+32+length]})
 return calls
def process_wire(call):
 message_offset=abi_word(call,36);start=4+message_offset;length=abi_word(call,start);return call[start+32:start+32+length]
def sealed_message(probe,identity):
 expected=identity.removeprefix('0x').lower();matches=[link for link in probe['sealed_payload_links']if''.join(link['message_id_chunks']).lower()==expected];assert len(matches)==1,(expected,len(matches));return matches[0]
def canonical_receipt(chain,transaction):
 receipt=chain.receipt(transaction['hash']);assert receipt['transactionHash'].lower()==transaction['hash'].lower()and transaction['blockHash'].lower()==receipt['blockHash'].lower()and int(transaction['blockNumber'],16)==int(receipt['blockNumber'],16)
 known=chain.rpc('eth_getBlockByHash',[receipt['blockHash'],False]);assert known['hash'].lower()==receipt['blockHash'].lower()and int(known['number'],16)==int(receipt['blockNumber'],16)
 canonical=chain.rpc('eth_getBlockByNumber',[receipt['blockNumber'],False]);assert canonical['hash'].lower()==receipt['blockHash'].lower()and int(canonical['number'],16)==int(receipt['blockNumber'],16)
 return receipt,canonical
def original_estimate(proxy,calldata,signer,target,broadcast_hash):
 broadcasts=[row for row in proxy.broadcasts if row['hash'].lower()==broadcast_hash.lower()];assert broadcasts,'missing actual matching broadcast';requested=min(row['requested_unix_seconds']for row in broadcasts)
 matches=[row for row in proxy.estimates if row['from']and row['to']and row['data']and row['from'].lower()==signer.lower()and row['to'].lower()==target.lower()and row['data'].lower()==calldata.lower()and row['unix_seconds']<requested]
 assert len(matches)==1,('original estimate identity/timestamp mismatch',len(matches));proof=matches[0];assert isinstance(proof['result'],str)and proof['result'].startswith('0x');int(proof['result'],16)
 return dict(proof,broadcast_requested_unix_seconds=requested)
def verify_process_events(receipt,mailbox,identities):
 assert receipt.get('status')=='0x1','Mailbox delivery receipt must succeed'
 expected={identity.lower()for identity in identities};assert len(expected)==len(identities),'duplicate expected ProcessId member'
 topic=evm.run(['cast','keccak','ProcessId(bytes32)']).lower();found=[]
 for event in receipt.get('logs',[]):
  topics=event.get('topics',[])
  if len(topics)>=2 and topics[0].lower()==topic and event.get('address','').lower()==mailbox.lower():
   assert event.get('transactionHash','').lower()==receipt['transactionHash'].lower(),'ProcessId transaction identity mismatch'
   assert event.get('blockHash','').lower()==receipt['blockHash'].lower()and int(event['blockNumber'],16)==int(receipt['blockNumber'],16),'ProcessId block identity mismatch'
   found.append(topics[1].lower())
 assert len(found)==len(expected)and set(found)==expected,('Mailbox ProcessId membership mismatch',found,sorted(expected))
 return {'status':receipt['status'],'mailbox_emitter':mailbox.lower(),'process_ids':sorted(found)}
def verify_sealed_singleton(chain,destination_rpc,mailbox,message,probe,source):
 link=sealed_message(probe,message['id']);canonical=source=='canonical';assert link['message_source']==source and link['canonical_nonce_message_present']is canonical and link['canonical_nonce_matches_message']is canonical and link['private_operation_stage']=='delivered'and link['destination_payload_present']and link['estimated_gas']is not None and link['gas_expenditure_record_present']
 transaction=message_transaction(chain,destination_rpc,message);assert transaction['from'].lower()==evm.TEST_SIGNER.lower()and transaction['to'].lower()==mailbox.lower();receipt,header=canonical_receipt(chain,transaction);event_proof=verify_process_events(receipt,mailbox,[message['id']])
 original=original_estimate(destination_rpc,transaction['input'],evm.TEST_SIGNER,mailbox,transaction['hash']);estimate=int(original['result'],16);assert estimate==int(link['estimated_gas']),(estimate,link['estimated_gas'])
 gas_used=int(receipt['gasUsed'],16);gas_price=int(receipt['effectiveGasPrice'],16);assert gas_used>0 and gas_price>0 and int(link['spent']['gas_used'])==gas_used and int(link['spent']['tokens_used'])==gas_used*gas_price
 return {'process_event_proof':event_proof,'message_source':source,'canonical_nonce_message_present':link['canonical_nonce_message_present'],'canonical_nonce_matches_message':link['canonical_nonce_matches_message'],'private_operation_stage':link['private_operation_stage'],'canonical_transaction_hash_chunks':chunks(transaction['hash']),'canonical_block_hash_chunks':chunks(header['hash']),'canonical_block_number':int(header['number'],16),'sealed_estimated_gas':int(link['estimated_gas']),'original_process_estimate':estimate,'original_estimate_proof':original,'receipt_gas_used':gas_used,'effective_gas_price':gas_price,'receipt_tokens_used':gas_used*gas_price,'gas_expenditure_record_present':True}
def verify_batch_allocation(chain,destination_rpc,transaction,messages,probe,mailbox,expected_messages=None):
 receipt,header=canonical_receipt(chain,transaction);assert receipt['status']=='0x1'and transaction['to'].lower()==MULTICALL3.lower()and transaction['from'].lower()==evm.TEST_SIGNER.lower()
 calls=decode_aggregate3(transaction['input']);assert len(calls)==4 and all(call['to'].lower()==mailbox.lower()for call in calls)
 actual_gas=int(receipt['gasUsed'],16);gas_price=int(receipt['effectiveGasPrice'],16);estimates=[];originals=[];members=[];sealed=[]
 for call in calls:
  wire=process_wire(call['calldata']).hex();index=next(index for index,message in enumerate(messages)if message['wire']==wire);link=sealed_message(probe,messages[index]['id']);assert link['estimated_gas']is not None and link['message_source']=='canonical'and link['canonical_nonce_message_present']and link['canonical_nonce_matches_message']and link['private_operation_stage']=='delivered'and link['destination_payload_present'];original=original_estimate(destination_rpc,'0x'+call['calldata'].hex(),evm.TEST_SIGNER,mailbox,transaction['hash']);assert int(original['result'],16)==int(link['estimated_gas']);estimates.append(int(link['estimated_gas']));originals.append(original);members.append(index);sealed.append(link)
 assert len(set(members))==4,'maxBatch4 requires four distinct message IDs'
 expected=expected_messages if expected_messages is not None else messages
 assert len(expected)==4 and {messages[index]['id'].lower()for index in members}=={message['id'].lower()for message in expected},'batch members differ from four expected messages'
 event_proof=verify_process_events(receipt,mailbox,[messages[index]['id']for index in members])
 total_estimate=sum(estimates);allocated=0;evidence=[]
 for index,estimate,original,link in zip(members,estimates,originals,sealed):
  row=probe['messages'][index];expected=actual_gas*estimate//total_estimate;spent_gas=int(row['spent']['gas_used']);spent_tokens=int(row['spent']['tokens_used']);assert spent_gas==expected,(index,spent_gas,expected);assert spent_tokens==spent_gas*gas_price;assert int(link['spent']['gas_used'])==spent_gas and int(link['spent']['tokens_used'])==spent_tokens and link['gas_expenditure_record_present'];allocated+=spent_gas
  evidence.append({'nonce':index,'id_chunks':chunks(messages[index]['id']),'canonical_transaction_hash_chunks':chunks(transaction['hash']),'canonical_block_hash_chunks':chunks(header['hash']),'canonical_block_number':int(header['number'],16),'sealed_estimated_gas':estimate,'original_process_estimate':int(original['result'],16),'original_estimate_proof':original,'receipt_allocated_gas':spent_gas,'receipt_allocated_tokens':spent_tokens})
 assert 0<=actual_gas-allocated<len(calls),(actual_gas,allocated)
 return {'process_event_proof':event_proof,'multicall3':MULTICALL3,'canonical_transaction_hash_chunks':chunks(transaction['hash']),'canonical_block_hash_chunks':chunks(header['hash']),'canonical_block_number':int(header['number'],16),'selector':'0x82ad56cb','calls':len(calls),'receipt_gas_used':actual_gas,'effective_gas_price':gas_price,'truncation_remainder':actual_gas-allocated,'members':evidence}
def static_contract_tests():
 passed=[]
 def rejects(label,fn):
  try:fn()
  except AssertionError:passed.append(label);return
  raise AssertionError(f'negative static contract did not reject: {label}')
 mailbox='0x'+'44'*20;identity='0x'+'cc'*32;wire='cc'*64;transaction_hash='0x'+'11'*32;block_hash='0x'+'22'*32
 transaction={'hash':transaction_hash,'from':evm.TEST_SIGNER,'to':mailbox,'input':'0xabcd'+wire,'blockHash':block_hash,'blockNumber':'0x10'}
 receipt={'transactionHash':transaction_hash,'blockHash':block_hash,'blockNumber':'0x10','gasUsed':hex(70000),'effectiveGasPrice':'0x2','status':'0x1','logs':[{'transactionHash':transaction_hash,'blockHash':block_hash,'blockNumber':'0x10','address':mailbox,'topics':[evm.run(['cast','keccak','ProcessId(bytes32)']),identity]}]}
 class Chain:
  def __init__(self):self.canonical={'hash':block_hash,'number':'0x10'}
  def receipt(self,unused):return dict(receipt)
  def rpc(self,method,params=()):
   if method=='eth_getTransactionByHash':return dict(transaction)
   if method=='eth_getBlockByHash':return {'hash':block_hash,'number':'0x10'}
   if method=='eth_getBlockByNumber':return dict(self.canonical)
   if method=='eth_estimateGas':raise AssertionError('Mailbox.process AlreadyDelivered post-mine re-estimation is forbidden')
   raise AssertionError(f'unexpected static RPC {method}')
 chain=Chain();proxy=RpcProxy(chain);proxy.raw_transactions=[transaction_hash];proxy.broadcasts=[{'hash':transaction_hash,'requested_unix_seconds':200.0,'confirmed_unix_seconds':201.0}]
 original={'from':evm.TEST_SIGNER,'to':mailbox,'data':transaction['input'],'block':'0xf','result':hex(70000),'unix_seconds':100.0};proxy.estimates=[dict(original)]
 message={'id':identity,'wire':wire};probe={'sealed_payload_links':[{'message_id_chunks':chunks(identity.removeprefix('0x')),'estimated_gas':'70000','spent':{'gas_used':'70000','tokens_used':'140000'},'gas_expenditure_record_present':True,'message_source':'canonical','canonical_nonce_message_present':True,'canonical_nonce_matches_message':True,'private_operation_stage':'delivered','destination_payload_present':True}]}
 proof=verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical');assert proof['original_process_estimate']==70000 and proof['original_estimate_proof']['unix_seconds']<200;passed.append('original_prebroadcast_estimate_accepted_without_postmine_rpc')
 chain.canonical={'hash':'0x'+'33'*32,'number':'0x10'};rejects('orphan_header_rejected_at_canonical_height',lambda:canonical_receipt(chain,transaction));chain.canonical={'hash':block_hash,'number':'0x10'}
 for label,field,value in [('wrong_calldata_rejected','data','0xdead'),('wrong_signer_rejected','from','0x'+'55'*20),('wrong_target_rejected','to','0x'+'66'*20)]:
  proxy.estimates=[dict(original,**{field:value})];rejects(label,lambda:original_estimate(proxy,transaction['input'],evm.TEST_SIGNER,mailbox,transaction_hash))
 proxy.estimates=[dict(original,result='0x1')];rejects('wrong_estimate_result_rejected',lambda:verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical'))
 proxy.estimates=[dict(original,unix_seconds=200.0)];rejects('postbroadcast_estimate_rejected',lambda:original_estimate(proxy,transaction['input'],evm.TEST_SIGNER,mailbox,transaction_hash))
 proxy.estimates=[dict(original)];assert verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical')['original_estimate_proof']['result']==hex(70000)
 proxy.receipt_inclusions={transaction_hash.lower():{'monotonic':100.0,'unix':1000.0}};proxy.delivered_inclusions={identity.lower():{'monotonic':150.0,'unix':1500.0}};observed,included_transaction=proxy_inclusion(proxy,chain,message);message['included_unix_seconds']=observed['unix'];message['included_monotonic']=observed['monotonic'];assert observed['monotonic']==100.0 and included_transaction['hash']==transaction_hash;assert not retirement_lower_bound([message],160.0) and not retirement_lower_bound([message],699.0) and retirement_lower_bound([message],700.0);passed.append('first_proxy_inclusion_rejects_60s_and_enforces_exact_600s_lower_bound')
 rejects('already_complete_at_zero_rejected_immediately',lambda:retirement_poll([],1,[message],0.0))
 bounded={};record_first_inclusion(bounded,'a',10.0,100.0,2);record_first_inclusion(bounded,'a',20.0,200.0,2);record_first_inclusion(bounded,'b',30.0,300.0,2);record_first_inclusion(bounded,'c',40.0,400.0,2);assert bounded=={'b':{'monotonic':30.0,'unix':300.0},'c':{'monotonic':40.0,'unix':400.0}};passed.append('bounded_first_seen_maps_preserve_first_monotonic_timestamp')
 staged=[{'id':'eligible','included_monotonic':0.0},{'id':'remaining','included_monotonic':20.0}]
 rejects('partial_early_confirmation_with_remaining_operations_rejected',lambda:retirement_poll([{'id':'remaining'}],1,staged,60.0))
 assert not retirement_poll([{'id':'remaining'}],1,staged,610.0)
 rejects('staggered_second_message_cannot_use_first_eligibility',lambda:retirement_poll([{'id':'remaining'}],2,staged,610.0))
 assert retirement_poll([],2,staged,620.0);passed.append('staggered_eligible_and_final_confirmations_accepted')
 assert not retirement_poll([{'id':'remaining'}],5,staged,610.0,historical_confirmed_offset=4)
 rejects('restart_offset_cannot_hide_new_early_confirmation',lambda:retirement_poll([{'id':'remaining'}],6,staged,610.0,historical_confirmed_offset=4))
 assert retirement_poll([],6,staged,620.0,historical_confirmed_offset=4)
 assert not retirement_poll([],0,staged,620.0);passed.append('restart_offset_and_exact_terminal_count_required')
 original_events=receipt['logs']
 receipt['status']='0x0';rejects('failed_singleton_receipt_rejected',lambda:verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical'));receipt['status']='0x1'
 receipt['logs']=[];rejects('missing_process_event_rejected',lambda:verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical'))
 for label,field,value in [('foreign_mailbox_event_rejected','address','0x'+'99'*20),('wrong_event_transaction_rejected','transactionHash','0x'+'88'*32),('wrong_event_block_rejected','blockHash','0x'+'77'*32),('wrong_process_id_rejected','topics',[original_events[0]['topics'][0],'0x'+'66'*32])]:
  receipt['logs']=[dict(original_events[0],**{field:value})];rejects(label,lambda:verify_sealed_singleton(chain,proxy,mailbox,message,probe,'canonical'))
 receipt['logs']=original_events
 return passed
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--binary',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/relayer');parser.add_argument('--validator-binary',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/validator');parser.add_argument('--oracle',type=pathlib.Path,default=IMMUTABLE_ORACLE);parser.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/relayer-process.json');parser.add_argument('--compile-only',action='store_true');parser.add_argument('--skip-expenditure-assert',action='store_true',help='Diagnostic only; result never passes expenditure acceptance');parser.add_argument('--keep-fixture',type=pathlib.Path);args=parser.parse_args()
 contracts=compile_contracts()
 if args.compile_only:print(json.dumps({'compiled':list(contracts)}));return
 binary=pin(args.binary,'relayer');validator_binary=pin(args.validator_binary,'validator');oracle=verified_oracle(args.oracle);fault_library,fault_identity=crash_library();fault_identity['self_test']=verify_crash_library(fault_library);args.output.parent.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='ziggy-public-relayer-process-')as directory,(evm.CACHE/'anvil.log').open('w')as anvil_log:
  temporary=pathlib.Path(directory);chain=evm.Chain(f'http://127.0.0.1:{port()}');anvil=subprocess.Popen(['anvil','--host','127.0.0.1','--port',chain.url.rsplit(':',1)[1],'--chain-id','31337','--silent'],cwd=ROOT,stdout=anvil_log,stderr=anvil_log);agents=[]
  try:
   for _ in range(100):
    if anvil.poll()is not None:raise AssertionError(f'Anvil exited{anvil.returncode}')
    try:chain.account=chain.rpc('eth_accounts')[0];break
    except (ConnectionError,urllib.error.URLError):time.sleep(.05)
   else:raise AssertionError('Anvil readiness deadline')
   def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
   null=deploy('TestIsm');required=deploy('TestPostDispatchHook');domains={}
   for name,domain in [('test1',ORIGIN),('test2',DESTINATION)]:
    mailbox=deploy('Mailbox','constructor(uint32)',str(domain));hook=deploy('MerkleTreeHook','constructor(address)',mailbox);announce=deploy('ValidatorAnnounce','constructor(address)',mailbox);igp=deploy('InterchainGasPaymaster');chain.send(evm.calldata('initialize(address,address)',chain.account,chain.account),igp);chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,null,hook,required),mailbox);domains[name]={'name':name,'domainId':domain,'chainId':31337,'protocol':'ethereum','rpcUrls':[{'http':chain.url}],'mailbox':mailbox,'merkleTreeHook':hook,'validatorAnnounce':announce,'interchainGasPaymaster':igp,'blocks':{'reorgPeriod':0,'confirmations':0,'estimateBlockTime':1},'index':{'from':0,'interval':1},'signer':{'type':'hexKey','key':'0x'+'11'*32}}
   gas_oracle=deploy('StorageGasOracle');chain.send(evm.calldata('setRemoteGasData((uint32,uint128,uint128))',f'({DESTINATION},10000000000,1)'),gas_oracle);chain.send(evm.calldata('setDestinationGasConfigs((uint32,(address,uint96))[])',f'[({DESTINATION},({gas_oracle},0))]'),domains['test1']['interchainGasPaymaster'])
   isms=[null,deploy('StorageMessageIdMultisigIsm','constructor(address[],uint8)',f'[{evm.TEST_SIGNER}]','1'),deploy('StorageMerkleRootMultisigIsm','constructor(address[],uint8)',f'[{evm.TEST_SIGNER}]','1')];recipients=[]
   for ism in isms:recipient=deploy('TestRecipient');chain.send(evm.calldata('setInterchainSecurityModule(address)',ism),recipient);recipients.append(recipient)
   chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)]);topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)']);messages=[]
   def dispatch(recipient,label):
    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)',str(DESTINATION),'0x'+'00'*12+recipient[2:],'0x'+label.encode().hex()),domains['test1']['mailbox']);event=next(v for v in receipt['logs']if v['address'].lower()==domains['test1']['mailbox'].lower()and v['topics'][0]==topic);raw=bytes.fromhex(event['data'][2:]);wire=raw[64:64+int.from_bytes(raw[32:64],'big')];identity=evm.run(['cast','keccak','0x'+wire.hex()]);payment=chain.receipt(chain.rpc('eth_sendTransaction',[{'from':chain.account,'to':domains['test1']['interchainGasPaymaster'],'data':evm.calldata('payForGas(bytes32,uint32,uint256,address)',identity,str(DESTINATION),'100000',chain.account),'value':hex(100000),'gas':'0xe00000'}]));messages.append({'id':identity,'wire':wire.hex(),'label':label,'dispatch_block':int(receipt['blockNumber'],16),'gas_block':int(payment['blockNumber'],16)});return identity
   for index,recipient in enumerate(recipients):dispatch(recipient,['null','message-id','merkle-root'][index])
   checkpoints=temporary/'checkpoints';validator_config=temporary/'validator-config';validator_config.mkdir();(validator_config/'public.json').write_text(json.dumps({'originChainName':'test1','db':str(temporary/'validator-db'),'validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoints)},'interval':1,'metricsPort':port(),'chains':{'test1':domains['test1']}}))
   with (temporary/'validator.log').open('w')as log:
    validating=launch(validator_binary,validator_config,log);agents.append(validating);wait(lambda:(checkpoints/'2_with_id.json').exists()and(checkpoints/'merkle_snapshot.json').exists(),validating,30,'complete validator checkpoint history');validator_stop=stop(validating)
   assert validator_stop['exit']==0,validator_stop
   with RpcProxy(chain)as destination_rpc:
    configured=json.loads(json.dumps(domains));configured['test2']['rpcUrls']=[{'http':destination_rpc.url}];relayer_config=temporary/'relayer-config';relayer_config.mkdir();database=temporary/'relayer-db';value={'relayChains':'test1,test2','db':str(database),'allowLocalCheckpointSyncers':True,'gasPaymentEnforcement':[{'type':'none'}],'metricsPort':port(),'chains':configured};(relayer_config/'public.json').write_text(json.dumps(value))
    def delivered(identity):return int(chain.rpc('eth_call',[{'to':domains['test2']['mailbox'],'data':evm.calldata('delivered(bytes32)',identity)},'latest']),16)==1
    with (temporary/'relayer-first.log').open('w')as log:
     running=launch(binary,relayer_config,log);agents.append(running);started=time.monotonic();observe_inclusions(delivered,messages,running,'all3 ISM deliveries',destination_rpc,chain,domains['test2']['mailbox']);delivery_ms=(time.monotonic()-started)*1000
     early_included=early_included_guard(value['metricsPort'],'test1',len(messages)-1,messages,initial=True)
     settlement=wait_for_retirement(value['metricsPort'],running,messages);metrics=telemetry(value['metricsPort']);first_stop=stop(running)
    assert first_stop['exit']==0,first_stop
    first_probe=rust_probe(oracle,database,3)
    assert all(v['present']and v['processed']and v['payment']and v['payloads']and all(p['present']for p in v['payloads'])for v in first_probe['messages']),first_probe
    initial_receipt_proofs=[verify_sealed_singleton(chain,destination_rpc,domains['test2']['mailbox'],message,first_probe,'canonical')for message in messages]
    args.output.write_text(json.dumps({'passed':False,'stage':'three ISM deliveries completed; crash/recovery acceptance pending','first_rust_readback':first_probe,'gas_expenditure_recorded':all(int(v['spent']['gas_used'])>0 and int(v['spent']['tokens_used'])>0 for v in first_probe['messages'])},indent=2)+'\n')
    before_nonce=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])
    with (temporary/'relayer-restart.log').open('w')as log:
     running=launch(binary,relayer_config,log);agents.append(running);restart_readiness=wait_role_ready(value['metricsPort'],running);restart_stop=stop(running)
    assert restart_stop['exit']==0 and chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])==before_nonce,restart_stop
    restart_probe=rust_probe(oracle,database,3);assert first_probe==restart_probe,(first_probe,restart_probe)
    # A fourth delivery starts a real hanging receipt. Then dispatch a fifth
    # message; independent origin indexing must keep ingesting while it stalls.
    destination_rpc.stall_receipts=True;fourth=dispatch(recipients[0],'receipt-stall-delivery')
    with (temporary/'relayer-stalled.log').open('w')as log:
     running=launch(binary,relayer_config,log);agents.append(running);wait(lambda:delivered(fourth)and destination_rpc.receipt_stalls>0,running,45,'delivery then stalled receipt');dispatch(recipients[0],'origin-progress-during-receipt-stall');time.sleep(2);stalled_stop=stop(running)
    assert stalled_stop['exit']==0 and stalled_stop['milliseconds']<3000,stalled_stop
    stalled_probe=rust_probe(oracle,database,len(messages));assert stalled_probe['messages'][len(messages)-1]['present']and stalled_probe['messages'][len(messages)-1]['insertion_id_chunks'],stalled_probe
    destination_rpc.stall_receipts=False
    multicall=deploy_multicall3(chain);batch_start=len(messages)
    for index,recipient in enumerate([recipients[0],recipients[1],recipients[2],recipients[0]]):dispatch(recipient,f'max-batch-4-{index}')
    with (temporary/'validator-batch.log').open('w')as log:
     validating=launch(validator_binary,validator_config,log);agents.append(validating);wait(lambda:(checkpoints/f'{len(messages)-1}_with_id.json').exists(),validating,45,'batch validator checkpoint history');batch_validator_stop=stop(validating)
    assert batch_validator_stop['exit']==0,batch_validator_stop
    batch_messages=messages[batch_start:]
    batch_config=temporary/'batch-config';batch_config.mkdir();batch_database=temporary/'batch-db';batch_value=json.loads(json.dumps(value));batch_value['db']=str(batch_database);batch_value['metricsPort']=port();batch_value['whitelist']=[{'messageId':[message['id']for message in batch_messages]}];batch_value['chains']['test2']['maxBatchSize']=4;batch_value['chains']['test2']['batchContractAddress']=multicall;(batch_config/'public.json').write_text(json.dumps(batch_value));raw_before_batch=len(destination_rpc.raw_transactions)
    with (temporary/'relayer-batch.log').open('w')as log:
     running=launch(binary,batch_config,log);agents.append(running);batch_messages=messages[batch_start:];observe_inclusions(delivered,batch_messages,running,'four ready messages in maxBatchSize4 role run',destination_rpc,chain,domains['test2']['mailbox'])
     batch_early=early_included_guard(batch_value['metricsPort'],'test1',len(messages)-1,batch_messages)
     batch_settlement=wait_for_retirement(batch_value['metricsPort'],running,batch_messages,historical_offset_reason='exact four target IDs admitted by whitelist; older canonical nonces indexed but denied');batch_stop=stop(running)
    assert batch_stop['exit']==0,batch_stop
    batch_probe=rust_probe(oracle,batch_database,len(messages));assert all(row['present']and row['processed']and row['payment']and row['payloads']for row in batch_probe['messages'][batch_start:]),batch_probe
    batch_transactions=[]
    for transaction_hash in dict.fromkeys(destination_rpc.raw_transactions[raw_before_batch:]):
     transaction=chain.rpc('eth_getTransactionByHash',[transaction_hash])
     if transaction and transaction.get('blockNumber')is not None and transaction.get('to')and transaction['to'].lower()==multicall.lower():batch_transactions.append(transaction)
    assert len(batch_transactions)==1,batch_transactions
    batch_allocation=verify_batch_allocation(chain,destination_rpc,batch_transactions[0],messages,batch_probe,domains['test2']['mailbox'],batch_messages)
    crash_attempts=[];crash_result=None
    for attempt in range(8):
     dispatch(recipients[0],f'preenqueue-crash-{attempt}');crash_message=messages[-1]
     crash_database=temporary/f'crash-db-{attempt}';crash_config=temporary/f'crash-config-{attempt}';crash_config.mkdir();crash_value=json.loads(json.dumps(value));crash_value['db']=str(crash_database);crash_value['metricsPort']=port();crash_value['whitelist']=[{'messageId':crash_message['id']}];(crash_config/'public.json').write_text(json.dumps(crash_value))
     with (temporary/f'relayer-crash-{attempt}.log').open('w')as log:
      crash_proof=temporary/f'seal-crash-proof-{attempt}.json'
      crashing=launch(binary,crash_config,log,{'DYLD_INSERT_LIBRARIES':str(fault_library),'ZIGGY_SEAL_CRASH_DATABASE':str(crash_database.resolve()),'ZIGGY_SEAL_CRASH_PROOF':str(crash_proof.resolve())});agents.append(crashing)
      try:crashing.wait(timeout=45)
      except subprocess.TimeoutExpired:stop(crashing)
      assert crashing.returncode==-signal.SIGKILL and crash_proof.exists(),('real WAL crash hook was not reached',crashing.returncode)
      proof=json.loads(crash_proof.read_text());assert proof['seal_wal_fsynced_before_sigkill']
     snapshot=rust_probe(oracle,crash_database,len(messages));links=snapshot['sealed_payload_links'];captured=any(not row['destination_payload_present']for row in links);crash_attempts.append({'attempt':attempt,'sigkill':crashing.returncode==-signal.SIGKILL,'fault_proof':proof,'sealed_links':links,'captured_pre_enqueue':captured})
     if not captured:continue
     before_recovery_nonce=int(chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']),16)
     with (temporary/'relayer-crash-recovery.log').open('w')as log:
      recovering=launch(binary,crash_config,log);agents.append(recovering);wait(lambda:delivered(crash_message['id']),recovering,90,'sealed payload replay delivery');observe_inclusions(delivered,[crash_message],recovering,'latest recovered inclusion',destination_rpc,chain,domains['test2']['mailbox']);recovery_early=early_included_guard(crash_value['metricsPort'],'test1',len(messages)-1,[crash_message]);recovery_settlement=wait_for_retirement(crash_value['metricsPort'],recovering,[crash_message],historical_offset_reason='exact fresh crash target admitted by whitelist; older canonical nonces indexed but denied');recovery_stop=stop(recovering)
     after_recovery_nonce=int(chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']),16);assert after_recovery_nonce==before_recovery_nonce+1,(before_recovery_nonce,after_recovery_nonce)
     recovered=rust_probe(oracle,crash_database,len(messages));assert recovered['messages'][-1]['processed'],recovered
     recovery_receipt_proof=verify_sealed_singleton(chain,destination_rpc,domains['test2']['mailbox'],messages[-1],recovered,'canonical')
     with (temporary/'relayer-crash-recovered-restart.log').open('w')as log:
      replayed=launch(binary,crash_config,log);agents.append(replayed);replay_readiness=wait_role_ready(crash_value['metricsPort'],replayed);replay_stop=stop(replayed)
     assert int(chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']),16)==after_recovery_nonce
     replayed_probe=rust_probe(oracle,crash_database,len(messages));assert recovered==replayed_probe,(recovered,replayed_probe)
     crash_result={'passed':True,'attempts':crash_attempts,'actual_pre_enqueue_rust_readback':snapshot,'recovered_rust_readback':recovered,'replayed_rust_readback':replayed_probe,'recovery_receipt_proof':recovery_receipt_proof,'replay_readiness':replay_readiness,'recovery_new_nonce_count':1,'restart_new_nonce_count':0,'early_included':recovery_early,'settlement':recovery_settlement,'recovery_stop':recovery_stop,'replay_stop':replay_stop};break
    assert crash_result is not None,crash_attempts
    expenditure=all(int(v['spent']['gas_used'])>0 and int(v['spent']['tokens_used'])>0 for v in first_probe['messages'])
    result={'passed':expenditure,'scope':__doc__,'binaries':{'relayer_sha256_chunks':sha(binary),'validator_sha256_chunks':sha(validator_binary),'rust_oracle_sha256_chunks':sha(oracle)},'validator_stop':validator_stop,'telemetry':metrics,'delivery_ms':delivery_ms,'early_included':early_included,'settlement':settlement,'first_stop':first_stop,'restart_readiness':restart_readiness,'restart_stop':restart_stop,'stalled_stop':stalled_stop,'restart_nonce_unchanged':True,'receipt_stall_requests':destination_rpc.receipt_stalls,'origin_progress_during_receipt_stall':True,'gas_expenditure_recorded':expenditure,'first_rust_readback':first_probe,'initial_receipt_proofs':initial_receipt_proofs,'stalled_rust_readback':stalled_probe,'max_batch_4':{'config':{'maxBatchSize':4,'batchContractAddress':multicall,'whitelist_message_ids_chunks':[chunks(message['id'])for message in batch_messages]},'early_included':batch_early,'settlement':batch_settlement,'stop':batch_stop,'stopped_rust_readback':batch_probe,'actual_allocation':batch_allocation},'rpc_methods':dict(destination_rpc.methods),'messages':[{'id_chunks':chunks(v['id']),'label':v['label'],'dispatch_block':v['dispatch_block'],'gas_block':v['gas_block']}for v in messages],'preenqueue_crash':crash_result,'fault_injection':fault_identity}
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    if not expenditure and not args.skip_expenditure_assert:raise AssertionError('actual Rust readback found missing receipt gas expenditure; diagnostic artifact retained')
    print(json.dumps({'passed':result['passed'],'delivered_cases':3,'max_batch_4_calls':batch_allocation['calls'],'restart_nonce_unchanged':True,'receipt_stall_origin_progress':True}))
  finally:
   failure=sys.exc_info()[0];preserve=args.keep_fixture
   for agent in agents:
    if agent.poll()is None:stop(agent)
   anvil.terminate()
   try:anvil.wait(timeout=5)
   except subprocess.TimeoutExpired:anvil.kill();anvil.wait()
   if failure is not None and preserve is None:preserve=args.output.parent/f'{args.output.stem}-failed-latest'
   if preserve:
    preserve.mkdir(parents=True,exist_ok=True);shutil.copytree(temporary,preserve,dirs_exist_ok=True)
   if failure is not None:
    partial={'passed':False,'stage':'failed; latest stopped fixture preserved','failed_fixture':str(preserve),'errors':[{'type':failure.__name__,'detail':'acceptance failed; see latest preserved stopped DB/logs/config'}]};(preserve/'partial-result.json').write_text(json.dumps(partial,indent=2)+'\n');args.output.write_text(json.dumps(partial,indent=2)+'\n')
if __name__=='__main__':main()
