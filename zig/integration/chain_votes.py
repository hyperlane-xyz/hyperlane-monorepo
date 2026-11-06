#!/usr/bin/env python3
"""Actual native per-VM read replay: nine hanging Tron peers plus18 healthy peers.

No blockchain writes, credentials or external endpoints. The ABI frontier and
expected root derive from actual production Rust IncrementalMerkle/message code.
"""
import argparse,contextlib,http.server,json,pathlib,subprocess,tempfile,threading,time
import evm
ROOT=evm.ROOT
class Peer:
 def __init__(self,body=None):self.body=body;self.requests=0;self.paths=[];self.stop=threading.Event()
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def do_POST(self):
    data=self.rfile.read(int(self.headers.get('content-length','0')));owner.requests+=1;owner.paths.append(self.path)
    if owner.body is None:owner.stop.wait(30);self.close_connection=True;return
    body=json.dumps(owner.body(json.loads(data),owner)).encode()if callable(owner.body)else owner.body
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):
   daemon_threads=True
   def handle_error(self,request,client_address):pass
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.stop.set();self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--driver',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/chain-votes-integration');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/chain-votes-integration.json');p.add_argument('--curl-library',default='/usr/lib/libcurl.4.dylib');args=p.parse_args()
 # Canonical message bytes from the published repository vector, then actual
 # production Rust computes the ID and one-leaf frontier root independently.
 import sys
 sys.path.insert(0,str(ROOT/'zig/bench'));import run as kernels
 known,_=kernels.corpus();wire=kernels.fixture(known['version'],known['nonce'],known['origin'],bytes.fromhex(known['sender'][2:]),known['destination'],bytes.fromhex(known['recipient'][2:]),bytes(known['body']));oracle=json.loads(evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=wire.hex()+'\n'))
 tree=bytes.fromhex(oracle['id'])+bytes(31*32)+(1).to_bytes(32,'big');body=json.dumps({'constant_result':[tree.hex()],'result':{'result':True}}).encode()
 with tempfile.TemporaryDirectory(prefix='ziggy-public-chain-votes-')as temp,contextlib.ExitStack()as peers:
  temp=pathlib.Path(temp);hanging=[peers.enter_context(Peer())for _ in range(9)];healthy=[peers.enter_context(Peer(body))for _ in range(18)];all_peers=hanging+healthy;config=temp/'config';config.mkdir();contract='0x'+'00'*19+'01'
  values={'originChainName':'votefixture','validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(temp/'unused-checkpoints')},'chains':{'votefixture':{'name':'votefixture','domainId':3999999999,'chainId':728126428,'protocol':'tron','rpcUrls':[{'http':healthy[0].url}],'walletUrls':[{'http':healthy[0].url+'/wallet'}],'walletSolidityUrls':[{'http':healthy[0].url+'/walletsolidity'}],'mailbox':contract,'validatorAnnounce':contract,'merkleTreeHook':contract,'interchainGasPaymaster':contract,'blocks':{'reorgPeriod':0}}}};(config/'public.json').write_text(json.dumps(values))
  root_hex='0x'+oracle['root'];fixture={'marker':'ziggy-public-chain-votes-v1','config_dir':str(config),'state_urls':[peer.url+'/walletsolidity' for peer in all_peers],'expected_root':[root_hex[i:i+32]for i in range(0,len(root_hex),32)],'required':18,'timeout_ms':20000,'curl_library':args.curl_library};path=temp/'fixture.json';path.write_text(json.dumps(fixture));started=time.monotonic();result=json.loads(evm.run([args.driver.resolve(),path]));wall_ms=(time.monotonic()-started)*1000
  assert result['physical_rpc_completions']==18,result
  assert result['passed']and result['configured_slots']==27 and result['ready']>=18 and result['required']==18,result
  assert result['elapsed_ms']<5000 and all(peer.requests>0 for peer in hanging),(result,[peer.requests for peer in hanging])
  assert all(path.endswith('/walletsolidity/triggerconstantcontract')for peer in all_peers for path in peer.paths)
  output={'passed':True,'scope':'Actual native curl_multi replay of concrete Tron Contracts.tree; fixed denominator; no signer/DB/publication; not full generic validator role parity','hanging_peers':9,'healthy_peers':18,'all_hanging_received_post':True,'native_worker_threads_for_requests':0,'result':result,'process_wall_ms':wall_ms,'requests_by_peer':[peer.requests for peer in all_peers],'rust_reference':{'message':'vectors/message.json','root_chunks':fixture['expected_root']},'properties':['all27 slots start before socket wait','nine stalled peers cannot exhaust a blocking worker pool','configured20s absolute deadline retained','quorum18 of27 checked against actual Rust frontier root','all transfers cancelled/drained before borrowed clients destroyed']}
  # Concrete Starknet read exercises multiple RPC stages, changing correlation
  # IDs on every re-execution and two IDENTICAL hash-fence request occurrences.
  leaf=int(oracle['id'],16);felts=['0x20']
  for index in range(32):
   value=leaf if index==0 else 0;felts.extend([hex(value&((1<<128)-1)),hex(value>>128),hex(index)])
  felts.extend(['0x1','0x0'])
  def starknet(mode):
   def response(request,owner):
    method=request['method'];identity=request['id']
    if mode=='wrong-id':identity+=1
    if method=='starknet_blockNumber':value=42
    elif method=='starknet_getBlockWithTxHashes':
     owner.block_reads=getattr(owner,'block_reads',0)+1;value={'status':'ACCEPTED_ON_L2','block_number':42,'block_hash':hex(8 if mode=='changed-fence'and owner.block_reads>=2 else 7),'parent_hash':'0x6','timestamp':1,'transactions':[]}
    elif method=='starknet_call':value=felts
    else:raise AssertionError(method)
    return {'jsonrpc':'2.0','id':identity,'result':value}
   return response
  output['starknet_cases']=[]
  for mode in ['correct','wrong-id','changed-fence']:
   with Peer(starknet(mode))as left,Peer(starknet(mode))as right:
    chain=values['chains']['votefixture'];chain.update(protocol='starknet',chainId='SN_SEPOLIA',nativeToken={'denom':contract,'decimals':18,'symbol':'TEST'},interchainGasPaymaster='0x'+'00'*32,rpcUrls=[{'http':left.url}]);(config/'public.json').write_text(json.dumps(values));fixture.update(state_urls=[left.url,right.url],required=2,expect_quorum=mode=='correct');path.write_text(json.dumps(fixture));case=json.loads(evm.run([args.driver.resolve(),path]));case['kind']=mode;case['requests']=[left.requests,right.requests]
    if mode=='correct':assert case['physical_rpc_completions']==8 and case['ready']==2 and case['requests']==[4,4],case
    elif mode=='wrong-id':assert case['physical_rpc_completions']==2 and case['ready']==0 and case['mismatched_ids']==2 and case['requests']==[1,1],case
    else:assert case['physical_rpc_completions']==8 and case['ready']==0 and case['changed_fences']==2 and case['requests']==[4,4],case
    output['starknet_cases'].append(case)
  args.output.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({'passed':True,'hanging':9,'healthy':18,'elapsed_ms':result['elapsed_ms'],'process_wall_ms':wall_ms,'starknet_replay_cases':3}))
if __name__=='__main__':main()
