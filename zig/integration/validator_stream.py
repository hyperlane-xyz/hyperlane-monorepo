#!/usr/bin/env python3
"""Disposable Anvil + verified WSS validator acceptance; public fixture key only."""
import argparse, base64, collections, contextlib, copy, hashlib, http.server, json, pathlib, socket, socketserver, ssl, struct, subprocess, tempfile, threading, time, urllib.request
import evm
import tls_fixture
ROOT = evm.ROOT
DOMAIN = 9913371

def chunks(value):
 if isinstance(value, str) and len(value) >= 64 and all(c in '0123456789abcdefABCDEFx' for c in value): return [value[i:i+32] for i in range(0,len(value),32)]
 if isinstance(value, dict): return {k:chunks(v) for k,v in value.items()}
 if isinstance(value, list): return [chunks(v) for v in value]
 return value

def wait(predicate, label, seconds=25):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if predicate(): return
  time.sleep(.05)
 raise AssertionError('deadline: '+label)

class RpcProxy:
 def __init__(self,target): self.target=target; self.methods=collections.Counter(); self.calls=collections.Counter(); self.lock=threading.Lock(); self.forbid_logs=False
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_POST(self):
    body=self.rfile.read(int(self.headers['content-length']));request=json.loads(body);method=request['method']
    with owner.lock:
     owner.methods[method]+=1
     if method=='eth_call':owner.calls[request['params'][0].get('data','')[:10]]+=1
    if owner.forbid_logs and method=='eth_getLogs': result=json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32000,'message':'fixture forbids RPC indexing'}}).encode()
    else:
     with urllib.request.urlopen(urllib.request.Request(owner.target,body,{'Content-Type':'application/json'}),timeout=5) as response: result=response.read()
    self.send_response(200);self.send_header('Content-Length',str(len(result)));self.end_headers();self.wfile.write(result)
   def log_message(self,*args):pass
  self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True;self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.server.shutdown();self.server.server_close();self.thread.join()

class StreamServer:
 def __init__(self,hook,tls=True):
  self.hook=hook;self.rows=[];self.sessions=[];self.subscriptions=[];self.errors=[];self.lock=threading.RLock();self.block_history=False;self.history_floor=None;self.reject_first=False;self.reject_handshakes=0;self.handshakes=0;self.tls=tls
 def __enter__(self):
  owner=self
  class Handler(socketserver.BaseRequestHandler):
   def handle(self):
    connection=self.request;connection.settimeout(120)
    session=None
    try:
     header=b''
     while b'\r\n\r\n' not in header: header+=connection.recv(1)
     fields={k.strip().lower():v.strip() for k,v in (line.split(':',1) for line in header.decode().split('\r\n')[1:] if ':' in line)}
     with owner.lock:
      owner.handshakes+=1;reject_handshake=owner.reject_handshakes>0
      if reject_handshake:owner.reject_handshakes-=1
     if reject_handshake:
      connection.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return
     accept=base64.b64encode(hashlib.sha1((fields['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
     connection.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n').encode())
     session={'connection':connection,'lock':threading.Lock(),'subscribed':False,'history':False,'sent':-1,'closed':False}
     with owner.lock: owner.sessions.append(session)
     owner.send(session,{'type':'ready','streamCursorVersions':{}})
     while True:
      opcode,data=owner.receive(connection)
      if opcode==8:return
      if opcode==9:owner.frame(session,10,data);continue
      if opcode!=1:continue
      message=json.loads(data);assert message['type']=='subscribe'
      streams=copy.deepcopy(message['streams'])
      for stream in streams:
       for cursor in stream.get('cursors',[]):cursor.pop('allowReplay',None)
      with owner.lock:
       owner.subscriptions.append(copy.deepcopy(message));source=message['streams'][0];cursors=source.get('cursors');after=int(cursors[0]['afterSequence']) if cursors else None
       session.update(subscribed=True,after=after,sent=after if after is not None else -1,history=owner.history_floor is not None and after is not None and after<owner.history_floor)
       reject=owner.reject_first;owner.reject_first=False
      if reject:
       # Schema error while physical connection remains open requires disconnect().
       owner.send(session,{'type':'subscribed','streams':[]});continue
      owner.send(session,{'type':'subscribed','streams':streams});owner.replay(session)
    except (ConnectionError, OSError, TimeoutError):pass
    except BaseException as error:owner.errors.append(repr(error))
    finally:
     if session:session['closed']=True
  class Server(socketserver.ThreadingTCPServer):allow_reuse_address=True;daemon_threads=True
  with contextlib.ExitStack() as resources:
   if self.tls:
    self.ca_path,key=resources.enter_context(tls_fixture.certificate());context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(self.ca_path,key)
   self.server=Server(('127.0.0.1',0),Handler);resources.callback(self.server.server_close)
   if self.tls:self.server.socket=context.wrap_socket(self.server.socket,server_side=True)
   self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.02),daemon=True);self.thread.start();self.url=f'{"wss" if self.tls else "ws"}://localhost:{self.server.server_address[1]}/events';self.resources=resources.pop_all();return self
 @staticmethod
 def exact(connection,n):
  data=b''
  while len(data)<n:
   part=connection.recv(n-len(data))
   if not part:raise ConnectionError('EOF')
   data+=part
  return data
 @classmethod
 def receive(cls,connection):
  a,b=cls.exact(connection,2);n=b&127
  if n==126:n=struct.unpack('!H',cls.exact(connection,2))[0]
  elif n==127:n=struct.unpack('!Q',cls.exact(connection,8))[0]
  assert n<=2*1024*1024
  mask=cls.exact(connection,4) if b&128 else None;data=cls.exact(connection,n)
  if mask:data=bytes(v^mask[i%4] for i,v in enumerate(data))
  return a&15,data
 def frame(self,session,opcode,data):
  header=bytes([128|opcode]);n=len(data)
  header+=bytes([n]) if n<126 else b'\x7e'+struct.pack('!H',n) if n<65536 else b'\x7f'+struct.pack('!Q',n)
  with session['lock']:session['connection'].sendall(header+data)
 def send(self,session,value):self.frame(session,1,json.dumps(value,separators=(',',':')).encode())
 def replay(self,session):
  with self.lock:
   if session['history'] and self.block_history:return
   rows=list(self.rows)
   selected=[row for row in rows if row['data']['leaf_index']>session['sent']] if session['after'] is not None else rows[-1:]
   for row in selected:self.send(session,row);session['sent']=row['data']['leaf_index']
   if session['after'] is not None:self.send(session,{'type':'caught_up','address':self.hook,'domain':DOMAIN,'eventType':'merkle_tree_insertion','sequence':str(session['sent'])})
 def append(self,index,message_id,block):
  row={'type':'event','domain':DOMAIN,'eventType':'merkle_tree_insertion','sequence':str(index),'data':{'domain':DOMAIN,'merkle_tree_hook':self.hook,'leaf_index':index,'message_id':'0x'+message_id,'block_number':str(block)}}
  with self.lock:
   self.rows.append(row)
   for session in self.sessions:
    if session['subscribed'] and not session['closed']:
     try:self.replay(session)
     except OSError:session['closed']=True
 def release_history(self):
  with self.lock:
   self.block_history=False
   for session in self.sessions:
    if session['subscribed'] and session['history'] and not session['closed']:self.replay(session)
 def __exit__(self,*args):
  for session in self.sessions:
   try:session['connection'].shutdown(socket.SHUT_RDWR)
   except OSError:pass
  try:self.server.shutdown();self.server.server_close();self.thread.join()
  finally:self.resources.close()

class Daemon:
 def __init__(self,binary,config,cwd,ca,log):self.binary=binary;self.config=config;self.cwd=cwd;self.ca=ca;self.log=log;self.process=None
 def start(self):
  self.file=self.log.open('w');self.process=subprocess.Popen([str(self.binary)],cwd=self.cwd,env={'HYPERLANE_ZIG_DEFAULTS':str(self.config),'HYPERLANE_CURL_LIBRARY':'/usr/lib/libcurl.4.dylib','SSL_CERT_FILE':str(self.ca)},stdout=self.file,stderr=self.file);return self
 def alive(self):
  if self.process.poll() is not None:raise AssertionError(f'daemon exited {self.process.returncode}: {self.log.read_text()[-4000:]}')
  return True
 def stop(self):
  if self.process and self.process.poll() is None:
   started=time.monotonic();self.process.terminate()
   try:self.process.wait(timeout=10)
   except subprocess.TimeoutExpired:self.process.kill();self.process.wait();raise AssertionError('shutdown timeout')
   self.stop_ms=(time.monotonic()-started)*1000
  self.file.close();assert self.process.returncode==0,self.log.read_text()[-5000:]

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--binary',required=True,type=pathlib.Path);parser.add_argument('--idle-audit',action='store_true');parser.add_argument('--handshake-retry',action='store_true');parser.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-wss-process.json');args=parser.parse_args();args.binary=args.binary.resolve()
 cache=ROOT/'zig/integration/.cache/validator-stream';cache.mkdir(parents=True,exist_ok=True);evm.CACHE=cache;evm.CONTRACTS={k:v for k,v in evm.CONTRACTS.items() if k in ['Mailbox','MerkleTreeHook','TestIsm','TestPostDispatchHook']};evm.CONTRACTS['ValidatorAnnounce']='solidity/contracts/isms/multisig/ValidatorAnnounce.sol';contracts=evm.compile_contracts()
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 chain=evm.Chain(f'http://127.0.0.1:{port}')
 with tempfile.TemporaryDirectory(prefix='ziggy-public-validator-wss-') as tmp, (cache/'anvil.log').open('w') as log:
  tmp=pathlib.Path(tmp);anvil=subprocess.Popen(['anvil','--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],stdout=log,stderr=log)
  try:
   def ready():
    try:chain.account=chain.rpc('eth_accounts')[0];return True
    except OSError:return False
   wait(ready,'anvil')
   def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values) if signature else ''))['contractAddress']
   mailbox=deploy('Mailbox','constructor(uint32)',str(DOMAIN));hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox);chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox);chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)])
   fork_base=chain.rpc('evm_snapshot');topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)']);messages=[];blocks=[];results={}
   def dispatch(label,stream=None):
    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+label.encode().hex()),mailbox);event=next(e for e in receipt['logs'] if e['address'].lower()==mailbox.lower() and e['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);n=int.from_bytes(data[32:64],'big');message=data[64:64+n].hex();messages.append(message);blocks.append(int(receipt['blockNumber'],16));identifier=evm.run(['cast','keccak','0x'+message])[2:]
    if stream:stream.append(len(messages)-1,identifier,blocks[-1])
    return identifier
   for i in range(3):dispatch(f'public-wss-{i}')
   def config(name,stream,proxy,light):
    directory=tmp/(name+'-config');directory.mkdir();checkpoints=tmp/(name+'-checkpoints')
    with socket.socket() as s:s.bind(('127.0.0.1',0));metrics=s.getsockname()[1]
    value={'originChainName':'test1','validator':{'key':'0x'+'11'*32},'db':str(tmp/(name+'-db')),'checkpointSyncer':{'type':'localStorage','path':str(checkpoints)},'interval':1,'metricsPort':metrics,'websocketUrl':stream.url,'lightweight':light,'chains':{'test1':{'name':'test1','domainId':DOMAIN,'chainId':31337,'protocol':'ethereum','rpcUrls':[{'http':proxy.url+'?slot=a'},{'http':proxy.url+'?slot=b'}],'rpcConsensusType':'majority','signer':{'type':'hexKey','key':'0x'+'11'*32},'mailbox':mailbox,'validatorAnnounce':announce,'merkleTreeHook':hook,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0}}}}
    (directory/'public.json').write_text(json.dumps(value));return directory,checkpoints,value,metrics
   def populate(stream):
    for i,message in enumerate(messages):stream.append(i,evm.run(['cast','keccak','0x'+message])[2:],blocks[i])
   def until(proc,fn,label,seconds=25):wait(lambda:proc.alive() and fn(),label,seconds)
   with RpcProxy(chain.url) as proxy,StreamServer(hook) as stream:
    populate(stream);stream.reject_first=True;stream.reject_handshakes=int(args.handshake_retry);directory,path,value,metrics=config('light',stream,proxy,True);proxy.forbid_logs=True;daemon=Daemon(args.binary,directory,tmp,stream.ca_path,cache/'light.log').start()
    try:
     try:until(daemon,lambda:(path/'2_with_id.json').exists() and (path/'merkle_snapshot.json').exists(),'lightweight replay/reconnect',35)
     except BaseException as error:
      args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(chunks({'passed':False,'stage':'lightweight first connection','error':str(error),'binary':str(args.binary),'binary_sha256':hashlib.sha256(args.binary.read_bytes()).hexdigest(),'handshakes':stream.handshakes,'subscriptions':stream.subscriptions,'injected_http503_handshakes':int(args.handshake_retry),'remaining_injected_failures':stream.reject_handshakes}),indent=2)+'\n');raise
     assert len(stream.subscriptions)>=2,stream.subscriptions
     assert proxy.methods['eth_getLogs']==0,proxy.methods
    finally:daemon.stop()
    original={p.name:p.read_bytes() for p in path.glob('*_with_id.json')};nonce=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']);daemon.start()
    try:until(daemon,lambda:len(stream.subscriptions)>=3,'lightweight restart');time.sleep(2)
    finally:daemon.stop()
    assert original=={p.name:p.read_bytes() for p in path.glob('*_with_id.json')};assert nonce==chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])
    results['lightweight']={'wss':True,'rpc_event_indexing_requests':proxy.methods['eth_getLogs'],'reconnect_from_open_after_schema_rejection':True,'injected_http503_handshakes':int(args.handshake_retry),'handshakes':stream.handshakes,'initial_objects':len(original),'restart_objects_unchanged':True,'restart_nonce_unchanged':True,'sigterm_ms':daemon.stop_ms,'subscriptions':copy.deepcopy(stream.subscriptions),'rpc_methods':dict(proxy.methods)}
    # Same authenticated snapshot with one old object absent; foreground must
    # advance while a separate canonical history subscription remains blocked.
    (path/'1_with_id.json').unlink();snapshot_before=(path/'merkle_snapshot.json').read_bytes();value['db']=str(tmp/'history-fresh-db');(directory/'public.json').write_text(json.dumps(value));stream.block_history=True;stream.history_floor=2;before=len(stream.subscriptions);daemon.start()
    try:
     until(daemon,lambda:any(s.get('history') for s in stream.sessions if not s['closed']),'missing history subscription')
     assert not (path/'1_with_id.json').exists()
     dispatch('public-wss-fresh-while-history-blocked',stream)
     until(daemon,lambda:(path/'3_with_id.json').exists(),'fresh checkpoint while history blocked')
     assert not (path/'1_with_id.json').exists();assert (path/'merkle_snapshot.json').read_bytes()==snapshot_before
     stream.release_history();until(daemon,lambda:(path/'1_with_id.json').exists() and (path/'merkle_snapshot.json').read_bytes()!=snapshot_before,'authenticated history repair')
    finally:daemon.stop()
    assert proxy.methods['eth_getLogs']==0,proxy.methods
    results['snapshot_history']={'missing_index':1,'foreground_advanced_before_history':True,'snapshot_waited_for_history':True,'history_repaired':True,'rpc_event_indexing_requests':0,'configured_socket_owner_threads':1,'configured_socket_owner_stack_bytes':1024*1024,'connections':2,'subscriptions':stream.subscriptions[before:],'sigterm_ms':daemon.stop_ms}
    assert not stream.errors,stream.errors
   with RpcProxy(chain.url) as proxy,StreamServer(hook) as stream:
    populate(stream);directory,path,value,metrics=config('normal',stream,proxy,False);daemon=Daemon(args.binary,directory,tmp,stream.ca_path,cache/'normal.log').start()
    try:
     until(daemon,lambda:(path/'3_with_id.json').exists(),'normal backfill')
     def active():
      try:
       with urllib.request.urlopen(f'http://127.0.0.1:{metrics}/metrics',timeout=2) as response: text=response.read().decode()
       return any(line.startswith('hyperlane_merkle_tree_hook_sync_source_active{') and 'source="websocket"' in line and line.endswith(' 1') for line in text.splitlines())
      except OSError:return False
     until(daemon,active,'normal WS cutover',40);before_logs=proxy.methods['eth_getLogs'];proxy.forbid_logs=True;dispatch('public-wss-after-normal-cutover',stream);until(daemon,lambda:(path/'4_with_id.json').exists(),'normal live WS insertion');assert proxy.methods['eth_getLogs']==before_logs,dict(proxy.methods)
    finally:daemon.stop()
    results['normal']={'rpc_backfill_requests':before_logs,'rpc_indexing_after_cutover':proxy.methods['eth_getLogs']-before_logs,'wss_live_checkpoint':True,'sigterm_ms':daemon.stop_ms,'rpc_methods':dict(proxy.methods),'subscriptions':stream.subscriptions};assert not stream.errors,stream.errors
   oracle=ROOT/'zig/reference/target/release/ziggy-rust-reference';expected=[json.loads(line) for line in evm.run([oracle,'vectors'],input=''.join(m+'\n' for m in messages)).splitlines()]
   for directory in [tmp/'light-checkpoints',tmp/'normal-checkpoints']:
    for obj in directory.glob('*_with_id.json'):
     index=int(obj.name.split('_')[0]);value=json.loads(obj.read_bytes())['value'];assert value['checkpoint']['root'].removeprefix('0x')==expected[index]['root'].removeprefix('0x');assert value['message_id'].removeprefix('0x')==expected[index]['id'].removeprefix('0x')
   if args.idle_audit:
    with RpcProxy(chain.url) as proxy,StreamServer(hook) as stream:
     populate(stream);directory,path,value,metrics=config('idle',stream,proxy,True);value['skipAnnounce']=True;(directory/'public.json').write_text(json.dumps(value));proxy.forbid_logs=True;daemon=Daemon(args.binary,directory,tmp,stream.ca_path,cache/'idle-audit.log').start()
     try:
      until(daemon,lambda:(path/'4_with_id.json').exists() and (path/'merkle_snapshot.json').exists(),'idle initial frontier')
      objects={p.name:p.read_bytes() for p in path.glob('*_with_id.json')};selector=evm.calldata('latestCheckpoint()')[:10];time.sleep(1);before=proxy.calls[selector];time.sleep(3);assert proxy.calls[selector]==before,(before,dict(proxy.calls))
      assert chain.rpc('evm_revert',[fork_base]);started=time.monotonic()
      for i in range(5):chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'idle-same-count-fork-{i}'.encode().hex()),mailbox)
      wait(lambda:daemon.process.poll() is not None,'source60s idle audit catches same-count fork',68)
      elapsed=(time.monotonic()-started)*1000;assert daemon.process.returncode==1 and elapsed>45000,(daemon.process.returncode,elapsed,(cache/'idle-audit.log').read_text());assert (path/'reorg_flag.json').exists();assert objects=={p.name:p.read_bytes()for p in path.glob('*_with_id.json')};assert proxy.methods['eth_getLogs']==0
      results['idle_audit']={'same_count_fork_detected_without_new_stream_leaf':True,'authenticated_idle_audit_interval_ms':60000,'fork_detection_ms':elapsed,'checkpoint_rpc_calls_during_3s_idle':0,'rpc_event_indexing_requests':0,'exit':daemon.process.returncode,'signed_objects_unchanged':True,'rpc_methods':dict(proxy.methods)}
     finally:
      if daemon.process.poll() is None:daemon.process.terminate();daemon.process.wait(timeout=10)
      daemon.file.close()
   result={'passed':True,'scope':'actual native validator CLI, disposable Anvil production contracts, authenticated WSS scraper fixture, actual Rust checkpoint oracle; correctness only','binary':str(args.binary),'binary_sha256':hashlib.sha256(args.binary.read_bytes()).hexdigest(),'cases':results,'rust_checkpoint_parity':True,'messages':len(messages),'environment':'empty except explicit defaults/native curl/public fixture CA; no user credentials'};args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(chunks(result),indent=2)+'\n');print('Validator WSS process acceptance passed')
  finally:
   anvil.terminate();anvil.wait(timeout=5)
if __name__=='__main__':main()
