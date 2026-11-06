#!/usr/bin/env python3
"""Sustained read-only Ethereum capture using native Zig + production Rust oracle.

Only the task's publicnode endpoint is accepted. Local proxy rejects signing,
publication, broadcast and every RPC method outside the explicit read set.
Touch --pause-file to pause between bounded windows; remove it to resume.
"""
import argparse,collections,hashlib,http.server,json,pathlib,shutil,signal,subprocess,tempfile,threading,time,urllib.parse,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path(__file__).resolve().parents[2]
class EndpointError(Exception):pass
def chunks(value):return[value[i:i+32]for i in range(0,len(value),32)]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=pathlib.Path,required=True);p.add_argument('--binary',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/hyperlane-zig');p.add_argument('--oracle',type=pathlib.Path,default=ROOT/'zig/reference/target/release/ziggy-rust-reference');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/ethereum-shadow-sustained');p.add_argument('--pause-file',type=pathlib.Path,default=ROOT/'zig/integration/.cache/shadow-paused');p.add_argument('--interval',type=float,default=30);p.add_argument('--max-blocks',type=int,default=16);args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 cfg=json.loads(args.config.read_text());remote=urllib.parse.urlsplit(cfg['rpc_url'])
 if remote.scheme!='https'or remote.hostname!='ethereum-rpc.publicnode.com'or remote.query or remote.username or remote.password:raise ValueError('Expected credential-free task public Ethereum RPC')
 if cfg['chain_id']!=1 or cfg['domain']!=1 or not cfg.get('merkle_tree_hook')or args.max_blocks<1 or args.max_blocks>64 or args.interval<10:raise ValueError('Expected bounded Ethereum fixture')
 nonce_selector=subprocess.check_output(['cast','sig','nonce()'],text=True).strip();count_selector=subprocess.check_output(['cast','sig','count()'],text=True).strip();allowed_contracts={cfg['mailbox'].lower():nonce_selector,cfg['merkle_tree_hook'].lower():count_selector}
 stopping=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopping.set());signal.signal(signal.SIGINT,lambda *_:stopping.set());counts=collections.Counter();failures=collections.Counter();lock=threading.Lock()
 def rpc(method,params):
  with lock:counts[method]+=1
  body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
  try:
   with urllib.request.urlopen(urllib.request.Request(cfg['rpc_url'],body,{'Content-Type':'application/json','User-Agent':'hyperlane-zig-shadow/0.1'}),timeout=20)as response:value=json.load(response)
   if value.get('jsonrpc')!='2.0'or value.get('id')!=1 or 'error'in value:raise EndpointError('RpcEnvelopeError')
   return value['result']
  except Exception as err:
   with lock:failures[type(err).__name__+(':'+str(err.code)if isinstance(err,urllib.error.HTTPError)else'')]+=1
   raise
 class Handler(http.server.BaseHTTPRequestHandler):
  protocol_version='HTTP/1.1'
  def do_POST(self):
   body=self.rfile.read(int(self.headers.get('content-length','0')))
   try:
    request=json.loads(body);method=request['method'];params=request['params']
    if method not in ['eth_chainId','eth_getBlockByNumber','eth_getLogs','eth_call']:raise RuntimeError('ForbiddenReadOnlyMethod')
    if method=='eth_getLogs'and params[0]['address'].lower()not in allowed_contracts:raise RuntimeError('UnexpectedLogContract')
    if method=='eth_call'and allowed_contracts.get(params[0]['to'].lower())!=params[0]['data']:raise RuntimeError('UnexpectedContractRead')
    value=rpc(method,params);response=json.dumps({'jsonrpc':'2.0','id':request['id'],'result':value}).encode();self.send_response(200)
   except Exception as err:
    response=json.dumps({'error':type(err).__name__}).encode();self.send_response(502)
   self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
  def log_message(self,*args):pass
 class Server(http.server.ThreadingHTTPServer):
  daemon_threads=True
  def handle_error(self,*args):pass
 server=Server(('127.0.0.1',0),Handler);thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True);thread.start()
 data=args.binary.read_bytes();binary_hash=hashlib.sha256(data).hexdigest();pinned=ROOT/'zig/integration/.cache/shadow-binaries'/binary_hash[:32]/'hyperlane-zig';pinned.parent.mkdir(parents=True,exist_ok=True)
 if not pinned.exists():pinned.write_bytes(data);pinned.chmod(0o755)
 if hashlib.sha256(pinned.read_bytes()).hexdigest()!=binary_hash:raise RuntimeError('PinnedBinaryMismatch')
 start=time.monotonic();paused_seconds=0;next_block=None;last_header=None;last_nonce=None;last_insertion=None;known_ids=set();state={'scope':'Sustained contiguous finalized Ethereum read-only capture + Rust codec/ID/count parity; no signing/storage leases/publication/broadcast; not full-agent parity','started_at_utc':datetime.now(timezone.utc).isoformat(),'endpoint_host':remote.hostname,'chain_id':1,'domain':1,'binary_sha256_chunks':chunks(binary_hash),'windows':[],'endpoint_failures':{},'rpc_methods':{},'paused':False,'fatal':None,'captured_blocks':0,'dispatches':0,'insertions':0,'unmatched_initial_insertions':0}
 def save():
  with lock:state.update(rpc_methods=dict(counts),endpoint_failures=dict(failures))
  state['elapsed_wall_seconds']=time.monotonic()-start;state['active_observation_seconds']=state['elapsed_wall_seconds']-paused_seconds;state['latest_update_utc']=datetime.now(timezone.utc).isoformat();(args.output/'observation.json').write_text(json.dumps(state,indent=2)+'\n')
 try:
  with tempfile.TemporaryDirectory(prefix='ziggy-public-shadow-')as temp:
   temp=pathlib.Path(temp);save()
   while not stopping.is_set():
    if args.pause_file.exists():
     began=time.monotonic();state['paused']=True;save()
     while args.pause_file.exists()and not stopping.wait(.25):pass
     paused_seconds+=time.monotonic()-began;state['paused']=False;save();continue
    began=time.monotonic()
    try:
     head=int(rpc('eth_getBlockByNumber',['finalized',False])['number'],16)
     if next_block is None:next_block=max(1,head-7)
     if next_block<=head:
      to=min(head,next_block+args.max_blocks-1);capture={**cfg,'rpc_url':f'http://127.0.0.1:{server.server_port}','from_block':next_block,'to_block':to,'max_blocks':args.max_blocks};path=temp/'capture.json';path.write_text(json.dumps(capture));run=subprocess.run([str(pinned),'shadow',str(path)],capture_output=True,text=True,timeout=90,env={})
      if run.returncode:
       if 'RpcHttpStatus'in run.stderr or 'RequestDeadlineExceeded'in run.stderr or 'CaptureAheadOfFinality'in run.stderr:raise EndpointError('NativeCaptureUnavailable')
       raise RuntimeError('ZigCaptureFailed')
      report=json.loads(run.stdout)
      if report['from_block']!=next_block or report['to_block']!=to:raise RuntimeError('CaptureRangeChanged')
      if last_header is not None and report['headers'][0]['parent_hash']!=last_header:raise RuntimeError('CrossWindowHeaderGap')
      def contract_count(address,selector,height):return int(rpc('eth_call',[{'to':address,'data':selector},hex(height)]),16)
      before_nonce=contract_count(cfg['mailbox'],nonce_selector,next_block-1);after_nonce=contract_count(cfg['mailbox'],nonce_selector,to);before_tree=contract_count(cfg['merkle_tree_hook'],count_selector,next_block-1);after_tree=contract_count(cfg['merkle_tree_hook'],count_selector,to)
      if last_nonce is not None and before_nonce!=last_nonce:raise RuntimeError('CrossWindowNonceGap')
      if last_insertion is not None and before_tree!=last_insertion:raise RuntimeError('CrossWindowInsertionGap')
      if after_nonce-before_nonce!=len(report['messages'])or after_tree-before_tree!=len(report['insertions']):raise RuntimeError('MissingEventsAgainstContractCounts')
      encoded=[message['encoded_hex'].removeprefix('0x')for message in report['messages']]
      reference=subprocess.run([str(args.oracle.resolve()),'vectors'],input=''.join(m+'\n'for m in encoded),capture_output=True,text=True,check=True,timeout=30);values=[json.loads(line)for line in reference.stdout.splitlines()]
      if len(values)!=len(encoded):raise RuntimeError('RustVectorCountMismatch')
      for i,(message,value)in enumerate(zip(report['messages'],values)):
       if bytes(message['id']).hex()!=value['id']or encoded[i]!=value['encoded']or int.from_bytes(bytes.fromhex(encoded[i])[1:5],'big')!=before_nonce+i:raise RuntimeError('RustMessageParityMismatch')
       known_ids.add(tuple(message['id']))
      for i,insertion in enumerate(report['insertions']):
       if insertion['index']!=before_tree+i:raise RuntimeError('InsertionSequenceMismatch')
       if tuple(insertion['message_id'])not in known_ids:state['unmatched_initial_insertions']+=1
      after=rpc('eth_getBlockByNumber',[hex(to),False])
      if bytes.fromhex(after['hash'][2:])!=bytes(report['headers'][-1]['hash']):raise RuntimeError('PostCountHashFenceChanged')
      window=len(state['windows']);(args.output/f'window-{window:06}.json').write_text(json.dumps(report,indent=2)+'\n');state['windows'].append({'from_block':next_block,'to_block':to,'finalized_height':head,'dispatches':len(encoded),'insertions':len(report['insertions']),'nonce_before':before_nonce,'nonce_after':after_nonce,'tree_before':before_tree,'tree_after':after_tree,'rust_parity':True,'seconds':time.monotonic()-began});state['captured_blocks']+=len(report['headers']);state['dispatches']+=len(encoded);state['insertions']+=len(report['insertions']);last_header=report['headers'][-1]['hash'];last_nonce=after_nonce;last_insertion=after_tree;next_block=to+1;print(json.dumps(state['windows'][-1]),flush=True)
     save()
    except (EndpointError,OSError,TimeoutError,subprocess.TimeoutExpired,urllib.error.URLError)as err:
     state['last_transport_error']=type(err).__name__;save()
    except Exception as err:
     state['fatal']=type(err).__name__+':'+str(err)[:120];save();raise
    stopping.wait(max(0,args.interval-(time.monotonic()-began)))
 finally:
  state['finished_at_utc']=datetime.now(timezone.utc).isoformat();save();server.shutdown();server.server_close();thread.join(timeout=2)
if __name__=='__main__':main()
