#!/usr/bin/env python3
"""Actual EVM validator role on disposable Anvil; public key11 only, no env credentials."""
import argparse,contextlib,hashlib,http.server,json,pathlib,socket,shutil,subprocess,tempfile,threading,time,urllib.error,urllib.request
import evm
ROOT=evm.ROOT

class HangingServer:
 def __enter__(self):
  owner=self;self.stopping=threading.Event();self.accepted=0
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_POST(self):
    self.rfile.read(int(self.headers.get('content-length','0')));owner.accepted+=1;owner.stopping.wait(30);self.close_connection=True
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):daemon_threads=True
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):
  self.stopping.set();self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)

class Proxy:
 def __init__(self,url,delay=0,corrupt=False,stall_receipts=False):self.target=url;self.delay=delay;self.corrupt=corrupt;self.corrupted=0;self.stall_receipts=stall_receipts;self.receipt_stalls=0;self.stop=threading.Event()
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_POST(self):
    body=self.rfile.read(int(self.headers.get('content-length','0')))
    if owner.delay:time.sleep(owner.delay)
    try:
     request=json.loads(body)
     if owner.stall_receipts and request.get('method')=='eth_getTransactionReceipt':owner.receipt_stalls+=1;owner.stop.wait(30);self.close_connection=True;return
     with urllib.request.urlopen(urllib.request.Request(owner.target,body,{'Content-Type':'application/json'}),timeout=5)as response:data=response.read()
     if owner.corrupt and request.get('method')=='eth_getLogs':
      result=json.loads(data)
      for event in result.get('result',[]):
       if len(event.get('data',''))>=66:event['data']='0x'+'ee'*32+event['data'][66:];owner.corrupted+=1
      data=json.dumps(result).encode()
     self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    except (ConnectionError,urllib.error.URLError,BrokenPipeError):self.close_connection=True
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):daemon_threads=True
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.stop.set();self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--driver',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/zig-validator-integration');p.add_argument('--daemon',type=pathlib.Path);p.add_argument('--check-rpc-metrics',action='store_true');p.add_argument('--check-admin',action='store_true');p.add_argument('--curl-library',default='/usr/lib/libcurl.4.dylib');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-evm-integration.json');args=p.parse_args()
 evm.CACHE=ROOT/'zig/integration/.cache/validator';evm.CACHE.mkdir(parents=True,exist_ok=True)
 evm.CONTRACTS={k:v for k,v in evm.CONTRACTS.items()if k in ['Mailbox','MerkleTreeHook','TestIsm','TestPostDispatchHook']};evm.CONTRACTS['ValidatorAnnounce']='solidity/contracts/isms/multisig/ValidatorAnnounce.sol';contracts=evm.compile_contracts()
 with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 chain=evm.Chain(f'http://127.0.0.1:{port}')
 with tempfile.TemporaryDirectory(prefix='ziggy-public-validator-')as temp,(evm.CACHE/'anvil.log').open('w')as log,HangingServer()as stalled,contextlib.ExitStack()as daemon_context:
  temp=pathlib.Path(temp);process=subprocess.Popen(['anvil','--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
  try:
   for _ in range(100):
    if process.poll()is not None:raise RuntimeError('Anvil exited')
    try:chain.account=chain.rpc('eth_accounts')[0];break
    except (ConnectionError,urllib.error.URLError):time.sleep(.05)
   else:raise RuntimeError('Anvil readiness deadline')
   def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
   mailbox=deploy('Mailbox','constructor(uint32)','9913371');hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox)
   chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox)
   fork_base=chain.rpc('evm_snapshot');messages=[];topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)'])
   for i in range(3):
    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'public-validator-{i}'.encode().hex()),mailbox);event=next(x for x in receipt['logs']if x['address'].lower()==mailbox.lower()and x['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);n=int.from_bytes(data[32:64],'big');messages.append(data[64:64+n].hex())
   config=temp/'config';config.mkdir();checkpoint_path=temp/'checkpoints';rpc=[{'http':stalled.url},{'http':chain.url+'?fixture=a'},{'http':chain.url+'/?fixture=a'},{'http':chain.url+'?fixture=b'}]
   value={'originChainName':'test1','validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoint_path)},'skipAnnounce':False,'chains':{'test1':{'name':'test1','domainId':9913371,'chainId':31337,'protocol':'ethereum','rpcUrls':rpc,'rpcConsensusType':'majority','mailbox':mailbox,'validatorAnnounce':announce,'merkleTreeHook':hook,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0}}}}
   (config/'public.json').write_text(json.dumps(value));fixture={'marker':'ziggy-public-validator-integration-v1','config_dir':str(config),'db_path':str(temp/'db'),'curl_library':args.curl_library,'steps':1,'rpc_timeout_ms':20000};fp=temp/'fixture.json'
   def run(**updates):
    fixture.update(updates);fp.write_text(json.dumps(fixture));return json.loads(evm.run([args.driver,fp]))
   started=time.monotonic();pending=run();early_quorum_ms=int((time.monotonic()-started)*1000);assert early_quorum_ms<5000 and stalled.accepted>0,(early_quorum_ms,stalled.accepted);assert pending['announcement_pending']and pending['checkpoint_signatures']==0,pending
   calldata=''.join(pending['announcement_calldata']);chain.send(calldata,announce)
   first=run(steps=6);assert first['latest']==2 and first['tree_count']==3 and first['checkpoint_signatures']==3 and first['configured_slots']==3 and first['unavailable']==1 and first['snapshot_through']==2,first
   replay=run();assert replay['checkpoint_signatures']==0 and replay['published']==0,replay
   bootstrap=run(db_path=str(temp/'fresh-db'));assert bootstrap['bootstrap_index']==2 and bootstrap['checkpoint_signatures']==0 and bootstrap['repair_complete']and bootstrap['history_repaired']==3,bootstrap
   rust=evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(m+'\n'for m in messages));expected=[json.loads(line)for line in rust.splitlines()]
   for i,v in enumerate(expected):
    obj=json.loads((checkpoint_path/f'{i}_with_id.json').read_text());assert obj['value']['checkpoint']['root'].removeprefix('0x')==v['root'].removeprefix('0x');assert obj['value']['message_id'].removeprefix('0x')==v['id'].removeprefix('0x')
   daemon_result=None
   if args.daemon:
    daemon_proxy=daemon_context.enter_context(Proxy(chain.url,stall_receipts=True))
    with socket.socket()as metrics_socket:metrics_socket.bind(('127.0.0.1',0));daemon_metrics_port=metrics_socket.getsockname()[1]
    daemon_config=temp/'daemon-config';daemon_config.mkdir();daemon_path=temp/'daemon-checkpoints';daemon_value=json.loads(json.dumps(value));daemon_value['metricsPort']=daemon_metrics_port;daemon_value['db']=str(temp/'daemon-db');daemon_value['interval']=1;daemon_value['checkpointSyncer']['path']=str(daemon_path);daemon_value['chains']['test1']['rpcUrls']=[{'http':daemon_proxy.url+'?daemon=a'},{'http':chain.url+'?daemon=b'}];daemon_value['chains']['test1']['signer']={'type':'hexKey','key':'0x'+'11'*32};(daemon_config/'public.json').write_text(json.dumps(daemon_value))
    chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)])
    daemon_env={'HYPERLANE_ZIG_DEFAULTS':str(daemon_config),'HYPERLANE_CURL_LIBRARY':args.curl_library}
    def launch():return subprocess.Popen([str(args.daemon.resolve())],cwd=temp,env=daemon_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def stop_daemon(proc):
     proc.terminate()
     try:stdout,stderr=proc.communicate(timeout=10)
     except subprocess.TimeoutExpired:proc.kill();proc.communicate();raise AssertionError('daemon did not drain within10s')
     assert proc.returncode==0,stderr
    daemon_started=time.monotonic();daemon=launch();daemon_ready=False;daemon_ready_ms=None;rpc_metrics=None;admin=None
    try:
     for _ in range(300):
      if daemon.poll()is not None:raise AssertionError(daemon.communicate())
      if (daemon_path/'2_with_id.json').exists()and(daemon_path/'merkle_snapshot.json').exists():daemon_ready=True;daemon_ready_ms=(time.monotonic()-daemon_started)*1000;break
      time.sleep(.1)
     if daemon_ready and args.check_rpc_metrics:
      metrics_url=f'http://127.0.0.1:{daemon_metrics_port}/metrics'
      with urllib.request.urlopen(metrics_url,timeout=3)as response:metrics_text=response.read(8*1024*1024).decode();assert response.status==200
      with urllib.request.urlopen(urllib.request.Request(metrics_url,method='HEAD'),timeout=3)as response:assert response.status==200 and not response.read()
      rows=[line for line in metrics_text.splitlines()if line.startswith('hyperlane_request_count{')]
      assert any('rpc_role="quorum"'in line and 'operation="validator_checkpoint"'in line and float(line.rsplit(' ',1)[1])>0 for line in rows),rows
      assert any('rpc_role="primary"'in line and 'operation="contract_sync"'in line and float(line.rsplit(' ',1)[1])>0 for line in rows),rows
      assert all('daemon='not in line and '?'not in line for line in rows),rows
      rpc_metrics={'passed':True,'get_status':200,'head_status':200,'physical_request_count_rows':rows,'scope':'actual EVM vote FSM and primary indexing; chain-votes fixture separately verifies SDK replay accounting'}
     if daemon_ready and args.check_admin:
      base=f'http://127.0.0.1:{daemon_metrics_port}'
      def get(path,method='GET'):
       try:response=urllib.request.urlopen(urllib.request.Request(base+path,method=method),timeout=3)
       except urllib.error.HTTPError as error:response=error
       with response:return response.status,response.read(),dict(response.headers)
      status,body,headers=get('/eigen/node');assert status==200
      node_info=json.loads(body);assert node_info=={'node_name':'Hyperlane Validator','spec_version':'0.1.0','node_version':'0.1.0'},node_info
      assert get('/eigen/node/')[0]==404
      status,body,headers=get('/ready');ready=json.loads(body);assert status==200 and ready['state']=='ready'and not ready['signing_blocked'],ready
      assert get('/eigen/node/health')[0]==200
      status,body,headers=get('/eigen/node/services');services=json.loads(body);assert status==200 and len(services)==2 and all(v['status']=='Up'for v in services)
      assert get('/eigen/node/services/unknown/health')[0]==200
      query='/merkle_tree_insertions?leaf_index_start=0&leaf_index_end=2'
      status,body,headers=get(query);rows=json.loads(body)['merkle_tree_insertions'];assert status==200 and len(rows)==3,rows
      for index,row in enumerate(rows):assert row['leaf_index']==index and row['message_id'].removeprefix('0x')==expected[index]['id'].removeprefix('0x')and row['insertion_block_number']is not None,row
      status,body,headers=get(query,'HEAD');assert status==200 and not body and int(headers['Content-Length'])>0
      status,body,headers=get('/merkle_tree_insertions?leaf_index_start=1&leaf_index_end=1');assert status==400 and json.loads(body)=={'message':'leaf_index_end less than leaf_index_start'}
      admin={'passed':True,'node_info':node_info,'ready':ready,'eigen_health_status':200,'services':services,'merkle_insertions':[{**row,'message_id':[row['message_id'][i:i+32]for i in range(0,len(row['message_id']),32)]}for row in rows],'inclusive_end_verified':True,'head_body_bytes':0,'equal_range_status':400,'trailing_slash_node_status':404}
    finally:stop_daemon(daemon)
    if not daemon_ready:
     diagnostic=subprocess.run([str(args.daemon.resolve()),'--zig-once'],cwd=temp,env=daemon_env,text=True,capture_output=True,timeout=30)
     debug=evm.CACHE/'daemon-debug';shutil.copytree(temp,debug,dirs_exist_ok=True);(debug/'once.stdout').write_text(diagnostic.stdout);(debug/'once.stderr').write_text(diagnostic.stderr)
     raise AssertionError(f'daemon checkpoint deadline; health={diagnostic.stdout}; error={diagnostic.stderr}; public fixture retained at {debug}')
    assert daemon_ready_ms<10000 and daemon_proxy.receipt_stalls>0,(daemon_ready_ms,daemon_proxy.receipt_stalls)
    before_nonce=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']);assert int(before_nonce,16)>0
    before_objects={p.name:p.read_bytes()for p in daemon_path.glob('*_with_id.json')};assert len(before_objects)==3
    for i,v in enumerate(expected):assert json.loads(before_objects[f'{i}_with_id.json'])['value']['checkpoint']['root'].removeprefix('0x')==v['root'].removeprefix('0x')
    daemon=launch()
    try:time.sleep(3);assert daemon.poll()is None
    finally:stop_daemon(daemon)
    assert before_nonce==chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])
    assert before_objects=={p.name:p.read_bytes()for p in daemon_path.glob('*_with_id.json')}
    daemon_result={'passed':True,'actual_binary':str(args.daemon.relative_to(ROOT)if args.daemon.is_relative_to(ROOT)else args.daemon),'binary_sha256_chunks':[hashlib.sha256(args.daemon.read_bytes()).hexdigest()[i:i+32]for i in (0,32)],'credential_environment':'empty except explicit defaults and native curl path','checkpoint_objects':3,'announcement_nonce':int(before_nonce,16),'restart_objects_unchanged':True,'restart_nonce_unchanged':True,'sigterm_clean_exit':True,'checkpoint_ready_ms':daemon_ready_ms,'receipt_stall_requests':daemon_proxy.receipt_stalls,'configured_rpc_deadline_ms':20000,'checkpoint_progress_while_receipt_worker_stalled':True,'rpc_metrics':rpc_metrics,'admin':admin}
   fallback_path=temp/'fallback-checkpoints';value['checkpointSyncer']['path']=str(fallback_path);value['chains']['test1']['rpcConsensusType']='fallback';(config/'public.json').write_text(json.dumps(value))
   started=time.monotonic();fallback_wait=run(db_path=str(temp/'fallback-db'),steps=1);fallback_ms=int((time.monotonic()-started)*1000);assert fallback_ms<5000 and fallback_wait['configured_slots']==1 and fallback_wait['announcement_pending'],fallback_wait
   chain.send(''.join(fallback_wait['announcement_calldata']),announce);fallback=run(steps=6);assert fallback['latest']==2 and fallback['checkpoint_signatures']==3 and fallback['configured_slots']==1,fallback
   value['checkpointSyncer']['path']=str(checkpoint_path);value['chains']['test1']['rpcConsensusType']='majority';(config/'public.json').write_text(json.dumps(value))
   with Proxy(chain.url,corrupt=True)as liar,Proxy(chain.url,delay=.005)as honest1,Proxy(chain.url,delay=.010)as honest2:
    recovery_path=temp/'recovery-checkpoints';value['checkpointSyncer']['path']=str(recovery_path);value['chains']['test1']['rpcUrls']=[{'http':x.url}for x in [liar,honest1,honest2]];(config/'public.json').write_text(json.dumps(value))
    waiting=run(db_path=str(temp/'recovery-db'),steps=1);assert waiting['announcement_pending'];chain.send(''.join(waiting['announcement_calldata']),announce)
    recovered=run(steps=12);assert liar.corrupted>0 and recovered['recoveries']>=1 and recovered['checkpoint_signatures']==3 and recovered['latest']==2 and not recovered['halted'],recovered
    for i,v in enumerate(expected):
     obj=json.loads((recovery_path/f'{i}_with_id.json').read_text());assert obj['value']['checkpoint']['root'].removeprefix('0x')==v['root'].removeprefix('0x')
   value['checkpointSyncer']['path']=str(checkpoint_path);value['chains']['test1']['rpcUrls']=rpc;(config/'public.json').write_text(json.dumps(value))
   assert chain.rpc('evm_revert',[fork_base])
   chain.rpc('evm_setAutomine',[False]);transactions=[]
   for i in range(4):
    data=evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'canonical-fork-{i}'.encode().hex());transactions.append(chain.rpc('eth_sendTransaction',[{'from':chain.account,'to':mailbox,'data':data,'gas':'0xe00000'}]))
   chain.rpc('evm_mine');chain.rpc('evm_setAutomine',[True])
   for transaction in transactions:chain.receipt(transaction)
   pending_fork=run(db_path=str(temp/'db'),steps=1);assert pending_fork['announcement_pending']and pending_fork['checkpoint_signatures']==0
   chain.send(''.join(pending_fork['announcement_calldata']),announce)
   fork=run(steps=6,expect_halt=True);assert fork['halted']and fork['checkpoint_signatures']==0,fork
   assert (checkpoint_path/'reorg_flag.json').is_file()
   blocked=subprocess.run([str(args.driver),str(fp)],cwd=ROOT,text=True,capture_output=True);assert blocked.returncode!=0 and 'ReorgFlagPresent' in blocked.stderr
   result={'passed':True,'scope':'Actual EVM validator role/localstorage/nativeRocksDB/HTTP integration; not whole-agent performance','contracts':evm.CONTRACTS,'daemon':daemon_result,'classic_fallback':{'first_role_tick_ms':fallback_ms,'configured_slots':1,'checkpoint_objects':3},'stalled_first':{'request_seen':stalled.accepted>0,'configured_rpc_timeout_ms':20000,'first_role_tick_ms':early_quorum_ms,'requests_started':stalled.accepted},'cases':['stalled first endpoint cannot block live quorum and all slots retain20s deadlines','classic fallback accepts healthy ready slot without waiting for stalled redundant peer','offchain signed announcement + actual Solidity announcement gate','canonical RPC URL dedup with unavailable slot retained','finalized event indexing and checkpoint quorum','all3 checkpoint roots/message IDs match actual Rust core','same DB restart publishes/signs nothing twice','empty DB authenticated snapshot bootstrap + complete history repair','lying event endpoint unsigned suffix discarded then canonical quorum recovered without signing bad history','growing-count signed-prefix fork audited within multi-event block then durable local/cloud restart guard'],'unsigned_suffix_recovery':{k:v for k,v in recovered.items()if k!='announcement_calldata'},'fork':{k:v for k,v in fork.items()if k!='announcement_calldata'},'first':{k:v for k,v in first.items()if k!='announcement_calldata'},'replay':{k:v for k,v in replay.items()if k!='announcement_calldata'},'bootstrap':{k:v for k,v in bootstrap.items()if k!='announcement_calldata'}}
   args.output.write_text(json.dumps(result,indent=2)+'\n');print('EVM validator integration passed: announcement,3checkpoints,Rustparity,restart,snapshotbootstrap')
  finally:
   process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:process.kill();process.wait()
if __name__=='__main__':main()
