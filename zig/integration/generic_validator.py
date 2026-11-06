#!/usr/bin/env python3
"""Native generic validator + Tron HTTP surface against disposable Solidity state.

This validates real native codecs/indexing/DB/sign/publication and restart/fork
handling. The HTTP gateway bridges walletSolidity reads to local Anvil; it is
not a Tron consensus/execution client or an all-VM process parity claim.
"""
import argparse,contextlib,hashlib,http.server,json,pathlib,shutil,socket,subprocess,tempfile,threading,time,urllib.error
import evm,validator
ROOT=evm.ROOT
def protobuf_fields(data):
 def varint(offset):
  value=0
  for shift in range(0,70,7):
   byte=data[offset];offset+=1;value|=(byte&127)<<shift
   if byte<128:return value,offset
  raise AssertionError('varint overflow')
 fields={};offset=0
 while offset<len(data):
  key,offset=varint(offset);number,kind=key>>3,key&7
  if kind==0:value,offset=varint(offset)
  elif kind==2:
   size,offset=varint(offset);value=data[offset:offset+size];assert len(value)==size;offset+=size
  else:raise AssertionError(('unsupported wire',kind))
  fields.setdefault(number,[]).append(value)
 return fields
class TronGateway:
 def __init__(self,chain,corrupt=False):self.chain=chain;self.requests={};self.selectors={};self.delay=0;self.fail_tree_after=None;self.tree_failures=0;self.announcements=[];self.corrupt=corrupt;self.corrupted=0;self.state_height=None;self.native_receipts={};self.native_broadcasts=0;self.stall_receipts=False;self.receipt_stalls=0;self.stop=threading.Event();self.tree_selector=evm.run(['cast','sig','tree()']).removeprefix('0x');self.insertion_topic=evm.run(['cast','keccak','InsertedIntoTree(bytes32,uint32)'])
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def do_POST(self):
    request=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))));owner.requests[self.path]=owner.requests.get(self.path,0)+1
    try:
     if self.path.endswith('/triggerconstantcontract'):
      selector=request['data'][:8];owner.selectors[selector]=owner.selectors.get(selector,0)+1
      if owner.delay:time.sleep(owner.delay)
      if owner.fail_tree_after is not None and selector==owner.tree_selector and owner.selectors[selector]>owner.fail_tree_after:
       owner.tree_failures+=1;self.send_response(503);self.send_header('Content-Length','0');self.end_headers();return
      result=owner.chain.rpc('eth_call',[{'to':'0x'+request['contract_address'][-40:],'data':'0x'+request['data']},hex(owner.state_height)if owner.state_height is not None else'latest']);response={'result':{'result':True},'constant_result':[result.removeprefix('0x')]}
     elif self.path.endswith('/estimateenergy'):response={'result':{'result':True},'energy_required':1000}
     elif self.path.endswith('/broadcasthex'):
      transaction=protobuf_fields(bytes.fromhex(request['transaction']));raw=transaction[1][0];contract=protobuf_fields(protobuf_fields(raw)[11][0]);anyvalue=protobuf_fields(contract[2][0]);trigger=protobuf_fields(anyvalue[2][0]);native_id='0x'+hashlib.sha256(raw).hexdigest()
      if native_id not in owner.native_receipts:
       receipt=owner.chain.send('0x'+trigger[4][0].hex(),'0x'+trigger[2][0][-20:].hex());receipt['transactionHash']=native_id;owner.native_receipts[native_id]=receipt;owner.native_broadcasts+=1
      response={'result':True}
     elif self.path.endswith('/getnowblock')or self.path.endswith('/getblockbynum'):
      block=owner.chain.rpc('eth_getBlockByNumber',['latest'if self.path.endswith('/getnowblock')else hex(request['num']),False]);response={'blockID':block['hash'].removeprefix('0x'),'block_header':{'raw_data':{'number':int(block['number'],16),'timestamp':int(block['timestamp'],16)*1000}}}
     else:
      if request['method']=='eth_getTransactionReceipt'and owner.stall_receipts:owner.receipt_stalls+=1;owner.stop.wait(30);self.close_connection=True;return
      result=owner.native_receipts.get(request.get('params',[None])[0])if request['method']=='eth_getTransactionReceipt'and request.get('params',[None])[0]in owner.native_receipts else owner.chain.rpc(request['method'],request.get('params',[]))
      if owner.corrupt and request['method']=='eth_getLogs':
       for event in result:
        if len(event.get('data',''))>=66 and event['topics'][0]==owner.insertion_topic:event['data']='0x'+'ee'*32+event['data'][66:];owner.corrupted+=1
      response={'jsonrpc':'2.0','id':request['id'],'result':result}
     body=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    except (BrokenPipeError,ConnectionResetError):self.close_connection=True
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):daemon_threads=True
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.stop.set();self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--driver',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/generic-validator-integration');p.add_argument('--task-driver',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-generic-integration.json');p.add_argument('--curl-library',default='/usr/lib/libcurl.4.dylib');args=p.parse_args()
 evm.CACHE=ROOT/'zig/integration/.cache/validator';evm.CACHE.mkdir(parents=True,exist_ok=True);evm.CONTRACTS={k:v for k,v in evm.CONTRACTS.items()if k in ['Mailbox','MerkleTreeHook','TestIsm','TestPostDispatchHook']};evm.CONTRACTS['ValidatorAnnounce']='solidity/contracts/isms/multisig/ValidatorAnnounce.sol';contracts=evm.compile_contracts()
 with socket.socket()as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 chain=evm.Chain(f'http://127.0.0.1:{port}')
 with tempfile.TemporaryDirectory(prefix='ziggy-public-generic-validator-')as directory,(evm.CACHE/'generic-anvil.log').open('w')as log:
  temp=pathlib.Path(directory);process=subprocess.Popen(['anvil','--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
  try:
   for _ in range(100):
    try:chain.account=chain.rpc('eth_accounts')[0];break
    except (ConnectionError,urllib.error.URLError):time.sleep(.05)
   else:raise AssertionError('Anvil readiness deadline')
   def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
   domain=3999999999;mailbox=deploy('Mailbox','constructor(uint32)',str(domain));hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox);chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox);fork_base=chain.rpc('evm_snapshot');messages=[];topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)'])
   def dispatch(text):
    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+text.encode().hex()),mailbox);event=next(x for x in receipt['logs']if x['address'].lower()==mailbox.lower()and x['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);return data[64:64+int.from_bytes(data[32:64],'big')].hex()
   for i in range(3):messages.append(dispatch(f'generic-native-{i}'))
   with TronGateway(chain)as left,TronGateway(chain)as right:
    config=temp/'config';config.mkdir();checkpoint_path=temp/'checkpoints';value={'originChainName':'nativefixture','validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoint_path)},'skipAnnounce':False,'chains':{'nativefixture':{'name':'nativefixture','domainId':domain,'chainId':31337,'protocol':'tron','rpcUrls':[{'http':left.url}],'walletUrls':[{'http':left.url+'/wallet'}],'walletSolidityUrls':[{'http':left.url+'/walletsolidity'},{'http':right.url+'/walletsolidity'}],'mailbox':mailbox,'validatorAnnounce':announce,'merkleTreeHook':hook,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0,'interval':1}}}}
    (config/'public.json').write_text(json.dumps(value));fixture={'marker':'ziggy-public-generic-validator-integration-v1','config_dir':str(config),'db_path':str(temp/'db'),'curl_library':args.curl_library,'steps':1,'rpc_timeout_ms':20000};path=temp/'fixture.json'
    def run(**changes):fixture.update(changes);path.write_text(json.dumps(fixture));return json.loads(evm.run([args.driver.resolve(),path]))
    pending=run();assert pending['announcement_pending']and pending['checkpoint_signatures']==0,pending
    signed=json.loads(bytes.fromhex(''.join(pending['announcement_calldata']).removeprefix('0x')));chain.send(evm.calldata('announce(address,string,bytes)',signed['value']['validator'],signed['value']['storage_location'],signed['serialized_signature']),announce)
    first=run(steps=12);assert first['latest']==2 and first['checkpoint_signatures']==3 and first['snapshot_through']==2,first
    replay=run();assert replay['checkpoint_signatures']==0 and replay['published']==0,replay
    bootstrap=run(db_path=str(temp/'fresh-db'),steps=12);assert bootstrap['bootstrap_index']==2 and bootstrap['checkpoint_signatures']==0 and bootstrap['repair_complete'],bootstrap
    rust=[json.loads(line)for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input='\n'.join(messages)+'\n').splitlines()]
    for i,expected in enumerate(rust):
     actual=json.loads((checkpoint_path/f'{i}_with_id.json').read_text());assert actual['value']['checkpoint']['root'].removeprefix('0x')==expected['root']and actual['value']['message_id'].removeprefix('0x')==expected['id']
    task_result=None
    if args.task_driver:
     task_config=temp/'task-config';task_config.mkdir();task_path=temp/'task-checkpoints';task_value=json.loads(json.dumps(value));task_value['checkpointSyncer']['path']=str(task_path);task_value['interval']=1;task_value['chains']['nativefixture']['index']['interval']=1;(task_config/'public.json').write_text(json.dumps(task_value));task_fixture=temp/'task-fixture.json';task_fixture.write_text(json.dumps({'marker':'ziggy-public-validator-tasks-v1','config_dir':str(task_config),'db_path':str(temp/'task-db'),'curl_library':args.curl_library,'run_ms':7000}));left.stall_receipts=True;announcement_base=chain.rpc('evm_snapshot')
     started=time.monotonic();native_process=subprocess.Popen([str(args.task_driver.resolve()),str(task_fixture)],cwd=ROOT,env={},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);checkpoint_ready=None
     while native_process.poll()is None:
      if checkpoint_ready is None and(task_path/'2_with_id.json').exists()and(task_path/'merkle_snapshot.json').exists():checkpoint_ready=(time.monotonic()-started)*1000
      time.sleep(.02)
     stdout,stderr=native_process.communicate();left.stall_receipts=False
     assert native_process.returncode==0,stderr;task_result=json.loads(stdout);task_result['checkpoint_ready_ms']=checkpoint_ready;task_result['receipt_stall_requests']=left.receipt_stalls;task_result['native_broadcasts']=left.native_broadcasts;task_result['binary_sha256_chunks']=[hashlib.sha256(args.task_driver.read_bytes()).hexdigest()[i:i+32]for i in [0,32]]
     assert checkpoint_ready is not None and checkpoint_ready<5000 and left.receipt_stalls>0 and task_result['checkpoint']['completed']>=3 and task_result['shutdown_ms']<3000,task_result
     for i,expected in enumerate(rust):assert json.loads((task_path/f'{i}_with_id.json').read_text())['value']['checkpoint']['root'].removeprefix('0x')==expected['root']
     before_objects={p.name:p.read_bytes()for p in task_path.glob('*_with_id.json')};before_broadcasts=left.native_broadcasts;assert chain.rpc('evm_revert',[announcement_base]);left.stall_receipts=True
     values=json.loads(task_fixture.read_text());values['run_ms']=3500;task_fixture.write_text(json.dumps(values));result=subprocess.run([str(args.task_driver.resolve()),str(task_fixture)],cwd=ROOT,env={},capture_output=True,text=True,timeout=15);left.stall_receipts=False;assert result.returncode==0,result.stderr
     reopened=json.loads(result.stdout);reopened['native_broadcasts']=left.native_broadcasts-before_broadcasts;assert reopened['native_broadcasts']==1 and reopened['checkpoint']['work']==0,reopened
     assert before_objects=={p.name:p.read_bytes()for p in task_path.glob('*_with_id.json')};task_result['announcement_only_reorg_reopened_revision']=reopened
    with TronGateway(chain,corrupt=True)as liar:
     recovery_path=temp/'recovery-checkpoints';value['checkpointSyncer']['path']=str(recovery_path);value['chains']['nativefixture']['rpcUrls']=[{'http':liar.url},{'http':right.url}];(config/'public.json').write_text(json.dumps(value));pending_recovery=run(db_path=str(temp/'recovery-db'),steps=1)
     signed=json.loads(bytes.fromhex(''.join(pending_recovery['announcement_calldata']).removeprefix('0x')));chain.send(evm.calldata('announce(address,string,bytes)',signed['value']['validator'],signed['value']['storage_location'],signed['serialized_signature']),announce)
     recovered=run(steps=24,allow_retries=True);assert liar.corrupted>0 and recovered['recoveries']>=1 and recovered['checkpoint_signatures']==3 and recovered['latest']==2 and not recovered['halted'],recovered
     for i,expected in enumerate(rust):assert json.loads((recovery_path/f'{i}_with_id.json').read_text())['value']['checkpoint']['root'].removeprefix('0x')==expected['root']
    value['checkpointSyncer']['path']=str(checkpoint_path);value['chains']['nativefixture']['rpcUrls']=[{'http':left.url}];(config/'public.json').write_text(json.dumps(value));fixture['allow_retries']=False
    shutil.copytree(temp/'db',temp/'mixed-db');shutil.copytree(checkpoint_path,temp/'mixed-checkpoints')
    assert chain.rpc('evm_revert',[fork_base]);fork_again=chain.rpc('evm_snapshot');chain.rpc('evm_setAutomine',[False]);transactions=[]
    for i in range(4):transactions.append(chain.rpc('eth_sendTransaction',[{'from':chain.account,'to':mailbox,'data':evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'generic-fork-{i}'.encode().hex()),'gas':'0xe00000'}]))
    chain.rpc('evm_mine');chain.rpc('evm_setAutomine',[True]);[chain.receipt(tx)for tx in transactions]
    waiting=run(db_path=str(temp/'db'),steps=1);assert waiting['announcement_pending'];signed=json.loads(bytes.fromhex(''.join(waiting['announcement_calldata']).removeprefix('0x')));chain.send(evm.calldata('announce(address,string,bytes)',signed['value']['validator'],signed['value']['storage_location'],signed['serialized_signature']),announce)
    fork=run(steps=16,expect_halt=True);assert fork['halted']and fork['checkpoint_signatures']==0,fork;assert(checkpoint_path/'reorg_flag.json').exists()
    assert chain.rpc('evm_revert',[fork_again])
    for i in range(3):dispatch(f'generic-mixed-fork-{i}')
    right.state_height=int(chain.rpc('eth_blockNumber'),16);dispatch('generic-mixed-fork-3')
    value['checkpointSyncer']['path']=str(temp/'mixed-checkpoints');(config/'public.json').write_text(json.dumps(value));waiting_mixed=run(db_path=str(temp/'mixed-db'),steps=1,expect_halt=False)
    signed=json.loads(bytes.fromhex(''.join(waiting_mixed['announcement_calldata']).removeprefix('0x')));chain.send(evm.calldata('announce(address,string,bytes)',signed['value']['validator'],signed['value']['storage_location'],signed['serialized_signature']),announce)
    mixed=run(steps=16,expect_halt=True);assert mixed['halted']and mixed['checkpoint_signatures']==0,mixed;assert(temp/'mixed-checkpoints'/'reorg_flag.json').exists();right.state_height=None
    def chunks(text):return[text[i:i+32]for i in range(0,len(text),32)]
    hashes={name:chunks(hashlib.sha256((ROOT/name).read_bytes()).hexdigest())for name in ['zig/src/agents/validator/generic.zig','zig/src/agents/validator/frontier_audit.zig','zig/src/agents/validator/chain_checkpoint.zig','zig/src/agents/validator/chain_votes.zig','zig/src/agents/validator/replay.zig','zig/src/agents/validator.zig','zig/src/agents/indexing/source.zig','zig/src/agents/store.zig','zig/src/agents/validator_task.zig','zig/src/agents/validator/announcement_task.zig','zig/src/agents/validator/announcement.zig','zig/src/agents/validator/mailbox.zig']}
    output={'passed':True,'binary_sha256_chunks':chunks(hashlib.sha256(args.driver.read_bytes()).hexdigest()),'source_sha256_chunks':hashes,'checkpoint_objects_utf8_chunks':{str(i):chunks((checkpoint_path/f'{i}_with_id.json').read_text())for i in range(3)},'rust_vectors':[{k:chunks(v[k])for k in ['root','id','encoded']}for v in rust],'scope':__doc__,'two_descriptor_task':task_result,'protocol':'tron','cases':['offchain announcement + actual Solidity location gate','native source indexing/RocksDB/sign/publication','three checkpoint roots and IDs match actual Rust','same DB restart no signatures/publications','authenticated snapshot restart repairs old history','lying indexer unsigned suffix repaired after root-authenticated audit and endpoint rotation','growing-count signed prefix fork via complete independently root-authenticated replay, halt before signing','mixed-count3+4 quorum independently authenticates common canonical prefix and halts conflicting old signed prefix'],'first':{k:v for k,v in first.items()if k!='announcement_calldata'},'replay':{k:v for k,v in replay.items()if k!='announcement_calldata'},'bootstrap':{k:v for k,v in bootstrap.items()if k!='announcement_calldata'},'fork':{k:v for k,v in fork.items()if k!='announcement_calldata'},'unsigned_suffix_recovery':{k:v for k,v in recovered.items()if k!='announcement_calldata'},'mixed_count_fork':{k:v for k,v in mixed.items()if k!='announcement_calldata'},'requests_by_path':left.requests}
    args.output.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({'passed':True,'protocol':'tron','checkpoints':3,'fork_halted':True}))
  finally:
   process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:process.kill();process.wait()
if __name__=='__main__':main()
