#!/usr/bin/env python3
"""Matched actual Rust/Zig EVM validator daemons, disposable Anvil/public keys only.

No production endpoints, credentials, environment inheritance or database writes.
Counts application JSON-RPC POSTs including retries; deployment/trace generation
bypasses the proxy. Timings include startup announcement, indexing, DB and signing.
"""
import argparse,collections,contextlib,hashlib,http.server,json,os,pathlib,platform,shutil,signal,socket,statistics,subprocess,sys,tempfile,threading,time,urllib.request
from datetime import datetime,timezone
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'integration'))
import evm
import inventory
ROOT=evm.ROOT
sys.path.insert(0,str(ROOT))
from zig.integration import validator as validator_fixture

def digest(path):
 value=hashlib.sha256(path.read_bytes()).hexdigest();return [value[:32],value[32:]]
def pin_binary(path,name):
 before=digest(path);pinned=ROOT/'zig/bench/.cache/validator-binaries'/before[0]/name;pinned.parent.mkdir(parents=True,exist_ok=True)
 if pinned.exists():
  if digest(pinned)!=before:raise RuntimeError('pinned binary digest mismatch')
 else:shutil.copy2(path,pinned)
 if digest(pinned)!=before or digest(path)!=before:raise RuntimeError('binary changed while pinning; wait for build completion')
 return pinned

def source_inventory():
 entries={};excluded={'target','.zig-cache','zig-out','.git','node_modules','__pycache__','.cache'}
 roots=['zig/src','rust/main/agents/validator','rust/main/hyperlane-base','rust/main/hyperlane-core','rust/main/.cargo']
 for root in roots:
  for directory,subdirs,files in os.walk(ROOT/root):
   subdirs[:]=sorted(x for x in subdirs if not inventory.pruned(x))
   for name in sorted(files):
    path=pathlib.Path(directory)/name
    if path.suffix in {'.zig','.rs','.toml','.lock','.json','.jsonl','.gz','.py','.h','.c'} and not (path.suffix != '.gz' and pathlib.Path(str(path)+'.gz').exists()):entries[str(path.relative_to(ROOT))]=digest(path)
 for name in ['zig/build.zig','zig/build.zig.zon','rust/main/Cargo.lock','rust/main/Cargo.toml','zig/bench/validator.py','zig/integration/validator.py']:
  path=ROOT/name
  if path.exists():entries[name]=digest(path)
 return entries
def daemon_environment(name, config, url_library):
 env={'HYPERLANE_ZIG_DEFAULTS':str(config),'HYPERLANE_CURL_LIBRARY':'/usr/lib/libcurl.4.dylib'}
 if name=='zig':env['HYPERLANE_URL_LIBRARY']=url_library['pinned_path']
 return env

class CountingProxy:
 def __init__(self,target):self.target=target;self.counts=collections.Counter();self.lock=threading.Lock()
 def snapshot(self):
  with self.lock:return dict(self.counts)
 def __enter__(self):
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def do_POST(self):
    data=self.rfile.read(int(self.headers.get('content-length','0')))
    try:
     decoded=json.loads(data);requests=decoded if isinstance(decoded,list)else[decoded]
     with owner.lock:
      for request in requests:owner.counts[request.get('method','invalid')]+=1
     with urllib.request.urlopen(urllib.request.Request(owner.target,data,{'Content-Type':'application/json'}),timeout=25)as response:body=response.read();status=response.status
     self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    except (OSError,ValueError):self.close_connection=True
   def log_message(self,*args):pass
  class Server(http.server.ThreadingHTTPServer):
   daemon_threads=True
   def handle_error(self,request,client_address):
    if isinstance(sys.exc_info()[1],(ConnectionResetError,BrokenPipeError)):return
    super().handle_error(request,client_address)
  self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
 def __exit__(self,*args):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
class MeasuredProcess:
 def __init__(self,binary,cwd,env):
  self.out=tempfile.TemporaryFile();self.err=tempfile.TemporaryFile();self.start_ns=time.perf_counter_ns();self.p=subprocess.Popen([str(binary)],cwd=cwd,env=env,stdout=self.out,stderr=self.err);self.usage=None;self.status=None
 def thread_snapshot(self):
  if sys.platform=='darwin':
   value=subprocess.run(['ps','-M','-p',str(self.p.pid)],text=True,capture_output=True)
   return max(0,len([line for line in value.stdout.splitlines()if line.strip()])-1)if value.returncode==0 else None
  if sys.platform.startswith('linux'):
   try:return int(next(line.split(':',1)[1]for line in pathlib.Path(f'/proc/{self.p.pid}/status').read_text().splitlines()if line.startswith('Threads:')))
   except(OSError,StopIteration,ValueError):return None
  return None
 def poll(self):
  if self.usage is None:
   pid,status,usage=os.wait4(self.p.pid,os.WNOHANG)
   if pid:self.status=os.waitstatus_to_exitcode(status);self.p.returncode=self.status;self.usage=usage
  return self.status
 def logs(self):
  self.out.seek(0);self.err.seek(0);return (self.out.read()+self.err.read()).decode(errors='replace')[-12000:]
 def stop(self):
  started=time.perf_counter_ns()
  if self.poll()is None:self.p.send_signal(signal.SIGTERM)
  until=time.monotonic()+30
  while self.poll()is None and time.monotonic()<until:time.sleep(.01)
  if self.poll()is None:self.p.kill();_,status,self.usage=os.wait4(self.p.pid,0);self.status=os.waitstatus_to_exitcode(status);self.p.returncode=self.status
  self.end_ns=time.perf_counter_ns();self.shutdown_ms=(self.end_ns-started)/1e6
  return dict(exit_code=self.status,user_seconds=self.usage.ru_utime,system_seconds=self.usage.ru_stime,max_rss_bytes=self.usage.ru_maxrss if sys.platform=='darwin'else self.usage.ru_maxrss*1024,process_wall_seconds=(self.end_ns-self.start_ns)/1e9,shutdown_ms=self.shutdown_ms)
 def close(self):self.out.close();self.err.close()
def filesystem_usage(directory):
 logical=allocated=files=0
 for path in directory.rglob('*'):
  if path.is_file() and not path.is_symlink():
   info=path.stat();logical+=info.st_size;allocated+=getattr(info,'st_blocks',0)*512;files+=1
 return {'files':files,'logical_bytes':logical,'allocated_bytes':allocated,'scope':'after process shutdown, includes RocksDB WAL/SST/info logs; stronger Zig graceful-close and publication durability may differ from Rust SIGTERM'}
def checkpoint_objects(directory,count):
 try:
  objects=[json.loads((directory/f'{i}_with_id.json').read_text())for i in range(count)]
  if int((directory/'index.json').read_text())<count-1:return None
  snapshot=json.loads((directory/'merkle_snapshot.json').read_text())
  if snapshot['index']<count-1:return None
  return objects
 except (OSError,ValueError,KeyError):return None

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--rust',type=pathlib.Path,default=ROOT/'rust/main/target/release/validator');p.add_argument('--zig',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/validator');p.add_argument('--url-library',type=pathlib.Path,required=True);p.add_argument('--zig-mode',choices=['ReleaseSafe','ReleaseFast'],default='ReleaseSafe');p.add_argument('--consensus',choices=['majority','quorum','fallback'],default='majority');p.add_argument('--samples',type=int,default=5);p.add_argument('--catchup',type=int,default=32);p.add_argument('--steady',type=int,default=8);p.add_argument('--steady-interval-ms',type=int,default=1000);p.add_argument('--deadline',type=float,default=90);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/whole-validator-initial');p.add_argument('--team-idle',action='store_true');p.add_argument('--profile',choices=['rust','zig','both']);p.add_argument('--check-metrics',action='store_true');p.add_argument('--rust-build-description',default='production cargo --release with .cargo tokio_unstable; no target-cpu override');p.add_argument('--telemetry-description',default='Rust includes tracing/Prometheus/Tokio task metrics; Zig telemetry is incomplete');args=p.parse_args();args.rust=args.rust.resolve();args.zig=args.zig.resolve();args.output=args.output.resolve();args.output.mkdir(parents=True,exist_ok=True)
 if args.samples<1 or args.catchup<1 or args.steady<1:raise ValueError('positive sample/trace counts required')
 url_library=validator_fixture.url_dependency(args.url_library,ROOT/'zig/bench/.cache/validator-url')
 evm.CACHE=ROOT/'zig/integration/.cache/whole-validator';evm.CACHE.mkdir(parents=True,exist_ok=True);evm.CONTRACTS={k:v for k,v in evm.CONTRACTS.items()if k in ['Mailbox','MerkleTreeHook','TestIsm','TestPostDispatchHook']};evm.CONTRACTS['ValidatorAnnounce']='solidity/contracts/isms/multisig/ValidatorAnnounce.sol';contracts=evm.compile_contracts()
 metadata=dict(started_at_utc=datetime.now(timezone.utc).isoformat(),scope='Actual EVM validator daemons, common two-endpoint '+args.consensus+'/local hex signer/LocalStorage trace; excludes other VMs, cloud, websocket, lightweight; telemetry parity incomplete',host=platform.platform(),zig_optimize=args.zig_mode,rust_build=args.rust_build_description,load_average_before=os.getloadavg(),team_compilers_idle=args.team_idle,shared_host='Other user workloads remain; no exclusive-host claim',trace={'catchup_dispatches':args.catchup,'steady_dispatches':args.steady,'steady_pacing':'fixed elapsed-time arrival schedule independent of signing completion','steady_interval_ms':args.steady_interval_ms,'domain':9913371,'poll_interval_seconds':1,'index_interval_seconds':1,'max_sign_concurrency':50,'rpc_endpoints':2,'consensus':args.consensus},durability={'rust':'production RocksDB options; LocalStorage uses tokio::fs::write without explicit file/directory fsync or atomic rename','zig':'per-transition RocksDB WAL fsync; LocalStore atomic rename + file/directory fsync'},binaries={n:{'path':str(b.relative_to(ROOT)if b.is_relative_to(ROOT)else b),'bytes':b.stat().st_size,'sha256_chunks':digest(b)}for n,b in [('rust',args.rust),('zig',args.zig)]},git_head=evm.run(['git','rev-parse','HEAD']),raw_samples=[])
 metadata['url_library']=url_library
 metadata['feature_gaps']=[args.telemetry_description,'maxSignConcurrency50 supplied identically; Zig native-safe publication uses a bounded persistent thread pool, Rust uses async join_all; thread snapshots and RSS recorded','Zig uses stronger fsync/atomic-publication policy; Rust production LocalStorage uses direct writes','Rust default SIGTERM terminates process; Zig drains worker then exits0; shutdown latency reported separately']
 metadata['configuration_loading']={'rust':'production loader reads ./config/*.json from disposable process cwd','zig':'HYPERLANE_ZIG_DEFAULTS explicitly selects the same disposable config directory','environment':'original Rust environment retained; explicit URL library added only to Zig child; no inherited credentials'}
 metadata['source_inventory_sha256_chunks']=source_inventory()
 metadata['source_inventory_scope']='files at harness start; binary hashes identify executed artifacts; source may include concurrent edits made after compilation'
 metadata['source_inventory_sha256_chunks']['zig/reference/src/main.rs']=digest(ROOT/'zig/reference/src/main.rs')
 metadata['native_publication_pool']={'worker_stack_bytes':256*1024,'maximum_workers':50,'allocation':'lazy persistent pool, no more workers than pending batch/configured ceiling; actual process thread snapshots recorded'}
 metadata['signature_observation']='published checkpoint objects verified; internal signing-call attempts are not instrumented'
 metadata['storage_tradeoff']='Zig currently persists a1032-byte Borsh frontier per observed index in addition to history/guards; Rust validator replay uses cached insertion leaves and sampled frontiers. Filesystem usage reported for actual trace; no large-history storage equivalence claim.'
 pinned={name:pin_binary(binary,name)for name,binary in [('rust',args.rust),('zig',args.zig)]}
 metadata['active_compilers_before']=evm.run(['ps','-axo','pid,etime,pcpu,comm'])
 def persist():
  (args.output/'validator.json').write_text(json.dumps(metadata,indent=2)+'\n')
 persist()
 for sample in range(args.samples):
  for name in (['rust','zig']if sample%2==0 else['zig','rust']):
   with tempfile.TemporaryDirectory(prefix='ziggy-public-whole-validator-')as temp:
    temp=pathlib.Path(temp)
    with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    chain=evm.Chain(f'http://127.0.0.1:{port}');log=(temp/'anvil.log').open('w');anvil=subprocess.Popen(['anvil','--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
    daemon=None
    try:
     for _ in range(100):
      try:chain.account=chain.rpc('eth_accounts')[0];break
      except OSError:time.sleep(.05)
     else:raise RuntimeError('Anvil readiness deadline')
     def deploy(k,signature=None,*v):return chain.send('0x'+contracts[k]+(evm.abi(signature,*v)if signature else''))['contractAddress']
     mailbox=deploy('Mailbox','constructor(uint32)','9913371');hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox);chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox);chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)])
     messages=[];topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)'])
     def dispatch(index):
      receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'whole-validator-public-{index}'.encode().hex()),mailbox);event=next(x for x in receipt['logs']if x['address'].lower()==mailbox.lower()and x['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);length=int.from_bytes(data[32:64],'big');messages.append(data[64:64+length].hex());return time.perf_counter_ns()
     for i in range(args.catchup):dispatch(i)
     with CountingProxy(chain.url)as first,CountingProxy(chain.url)as second:
      config=temp/'config';config.mkdir();checkpoints=temp/'checkpoints';
      with socket.socket()as metrics_socket:metrics_socket.bind(('127.0.0.1',0));metrics_port=metrics_socket.getsockname()[1]
      value={'originChainName':'test1','db':str(temp/'db'),'interval':1,'maxSignConcurrency':50,'metricsPort':metrics_port if args.check_metrics else 0,'tracing':{'level':'error','fmt':'json'},'validator':{'type':'hexKey','key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoints)},'skipAnnounce':False,'chains':{'test1':{'name':'test1','domainId':9913371,'chainId':31337,'protocol':'ethereum','rpcUrls':[{'http':first.url},{'http':second.url}],'rpcConsensusType':args.consensus,'signer':{'type':'hexKey','key':'0x'+'11'*32},'mailbox':mailbox,'validatorAnnounce':announce,'merkleTreeHook':hook,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0,'estimateBlockTime':1},'index':{'from':0,'interval':1,'chunk':1999}}}};(config/'public.json').write_text(json.dumps(value))
      env=daemon_environment(name,config,url_library);daemon=MeasuredProcess(pinned[name],temp,env)
      profile=None
      if args.profile in [name,'both']:profile=subprocess.Popen(['/usr/bin/sample',str(daemon.p.pid),'5','1','-file',str(args.output/f'{name}-{sample}.sample.txt')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
      def wait(count):
       until=time.monotonic()+args.deadline
       while time.monotonic()<until:
        if daemon.poll()is not None:raise RuntimeError(f'{name} exited{daemon.status}: {daemon.logs()}')
        objects=checkpoint_objects(checkpoints,count)
        if objects is not None:return time.perf_counter_ns(),objects
        time.sleep(.005)
       raise RuntimeError(f'{name} checkpoint{count-1} deadline: {daemon.logs()}')
      caught,objects=wait(args.catchup);threads_after_catchup=daemon.thread_snapshot();catchup_ms=(caught-daemon.start_ns)/1e6;startup_rpc=[first.snapshot(),second.snapshot()];latencies=[];metrics=None
      if args.check_metrics:
       with urllib.request.urlopen(f'http://127.0.0.1:{metrics_port}/metrics',timeout=5)as response:
        body=response.read(8*1024*1024);assert response.status==200 and b'hyperlane_'in body
        metrics={'passed':True,'requests':1,'bytes':len(body),'hyperlane_help_families':body.count(b'# HELP hyperlane_')}

      emitted=[None]*args.steady;observed=[None]*args.steady;dispatch_errors=[]
      def produce():
       try:
        for j in range(args.steady):
         due=caught+(j+1)*args.steady_interval_ms*1_000_000
         time.sleep(max(0,(due-time.perf_counter_ns())/1e9));emitted[j]=dispatch(args.catchup+j)
       except Exception as error:dispatch_errors.append(error)
      producer=threading.Thread(target=produce);producer.start();steady_deadline=time.monotonic()+args.deadline+args.steady*args.steady_interval_ms/1000
      try:
       while any(x is None for x in observed):
        if daemon.poll()is not None:raise RuntimeError(f'{name} exited{daemon.status}: {daemon.logs()}')
        if dispatch_errors:raise dispatch_errors[0]
        for j in range(args.steady):
         if emitted[j]is not None and observed[j]is None and checkpoint_objects(checkpoints,args.catchup+j+1)is not None:observed[j]=time.perf_counter_ns()
        if time.monotonic()>steady_deadline:raise RuntimeError(f'{name} steady checkpoint deadline: {daemon.logs()}')
        time.sleep(.005)
      finally:producer.join(timeout=30)
      objects=checkpoint_objects(checkpoints,args.catchup+args.steady);assert objects is not None
      latencies=[max(0,(signed-sent)/1e6)for signed,sent in zip(observed,emitted)];dispatch_offsets=[(sent-caught)/1e6 for sent in emitted]
      finished=time.perf_counter_ns();threads_after_steady=daemon.thread_snapshot();total_rpc=[first.snapshot(),second.snapshot()];measurements=daemon.stop();
      if profile is not None:profile.wait(timeout=15)
      nonce=int(chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']),16)
      if measurements['exit_code']not in [0,-signal.SIGTERM]:raise RuntimeError(f'{name} failed shutdown: {daemon.logs()}')
      # Validation/reference work is outside process lifetime/timing.
      rust_vectors=[json.loads(line)for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(m+'\n'for m in messages)).splitlines()]
      for i,(obj,expected)in enumerate(zip(objects,rust_vectors)):
       assert obj['value']['checkpoint']['index']==i and obj['value']['checkpoint']['mailbox_domain']==9913371
       assert obj['value']['checkpoint']['merkle_tree_hook_address'].removeprefix('0x')=='00'*12+hook[2:].lower()
       assert obj['value']['checkpoint']['root'].removeprefix('0x')==expected['root']and obj['value']['message_id'].removeprefix('0x')==expected['id']
      digests=[json.loads(line)['digest']for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','checkpoint-digests'],input=''.join(json.dumps(o)+'\n'for o in objects)).splitlines()]
      requests=[{'operation':'recover','digest':h,'r':f"{int(o['signature']['r'],16):064x}",'s':f"{int(o['signature']['s'],16):064x}",'v':hex(o['signature']['v'])}for o,h in zip(objects,digests)]
      recovered=[json.loads(line)['expected']['signer']for line in evm.run([ROOT/'zig/reference/evm/target/release/ziggy-evm-oracle'],input=''.join(json.dumps(r)+'\n'for r in requests)).splitlines()];assert all(a==evm.TEST_SIGNER[2:]for a in recovered)
      row=dict(implementation=name,sample=sample,order=len(metadata['raw_samples']),catchup_ms=catchup_ms,steady_ms=(finished-caught)/1e6,freshness_ms=latencies,dispatch_offsets_ms=dispatch_offsets,measurements=measurements,rpc_startup=startup_rpc,rpc_total=total_rpc,canonical_checkpoint_count=len(objects),signatures_verified=len(recovered),announcement_account_nonce=nonce,metrics_probe=metrics,storage={'database':filesystem_usage(temp/'db'),'checkpoint_objects':filesystem_usage(checkpoints)},thread_snapshots={'after_catchup':threads_after_catchup,'after_steady':threads_after_steady,'scope':'process thread snapshots; not continuous peak sampling'},load_average=os.getloadavg());metadata['raw_samples'].append(row);persist();print(name,sample,round(catchup_ms,1),'ms catchup',round(statistics.median(latencies),1),'ms median freshness',flush=True)
    except Exception as error:
     metadata['failure']={'implementation':name,'sample':sample,'message_chunks':[str(error)[i:i+32]for i in range(0,len(str(error)),32)]};persist();raise
    finally:
     if daemon:
      if daemon.usage is None:daemon.stop()
      daemon.close()
     anvil.terminate()
     try:anvil.wait(timeout=5)
     except subprocess.TimeoutExpired:anvil.kill();anvil.wait()
     log.close()
 metadata['load_average_after']=os.getloadavg();metadata['finished_at_utc']=datetime.now(timezone.utc).isoformat();metadata['active_compilers_after']=evm.run(['ps','-axo','pid,etime,pcpu,comm']);metadata['summary']={}
 for name in ['rust','zig']:
  rows=[r for r in metadata['raw_samples']if r['implementation']==name];fresh=[v for r in rows for v in r['freshness_ms']];metadata['summary'][name]={'median_catchup_ms':statistics.median(r['catchup_ms']for r in rows),'median_freshness_ms':statistics.median(fresh),'max_freshness_ms':max(fresh),'median_cpu_seconds':statistics.median(r['measurements']['user_seconds']+r['measurements']['system_seconds']for r in rows),'median_max_rss_bytes':statistics.median(r['measurements']['max_rss_bytes']for r in rows),'median_rpc_total':statistics.median(sum(sum(s.values())for s in r['rpc_total'])for r in rows),'median_process_wall_seconds':statistics.median(r['measurements']['process_wall_seconds']for r in rows),'median_steady_ms':statistics.median(r['steady_ms']for r in rows),'median_shutdown_ms':statistics.median(r['measurements']['shutdown_ms']for r in rows)}
 persist()
if __name__=='__main__':main()
