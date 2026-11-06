#!/usr/bin/env python3
"""SIGTERM during real native WAL guard ambiguity, disposable/public fixtures only."""
import argparse,hashlib,json,pathlib,socket,subprocess,tempfile,time
import evm
from validator_stream import chunks,wait
ROOT=evm.ROOT

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-guard-sigterm-process.json');args=p.parse_args();binary=args.binary.resolve();cache=ROOT/'zig/integration/.cache/validator-guard';cache.mkdir(parents=True,exist_ok=True)
 source=ROOT/'zig/integration/faults/guard_sync.c';library=cache/'guard-sync.dylib';writer=cache/'guard-sync-test';sdk='/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk';compiler=['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-isysroot',sdk];subprocess.run([*compiler,'-dynamiclib',str(source),'-o',str(library)],check=True);subprocess.run([*compiler,str(ROOT/'zig/integration/faults/guard_sync_test.c'),'-o',str(writer)],check=True)
 evm.CACHE=cache;evm.CONTRACTS={k:v for k,v in evm.CONTRACTS.items()if k in ['Mailbox','MerkleTreeHook','TestIsm','TestPostDispatchHook']};evm.CONTRACTS['ValidatorAnnounce']='solidity/contracts/isms/multisig/ValidatorAnnounce.sol';contracts=evm.compile_contracts()
 with tempfile.TemporaryDirectory(prefix='ziggy-public-validator-guard-')as temp,(cache/'anvil.log').open('w')as log:
  temp=pathlib.Path(temp);db=temp/'guard-db-0';proof=temp/'fault.json';environment={'DYLD_INSERT_LIBRARIES':str(library),'ZIGGY_GUARD_SYNC_DATABASE':str(db.resolve()),'ZIGGY_GUARD_SYNC_PROOF':str(proof.resolve())}
  db.mkdir();control=temp/'control';control.mkdir();subprocess.run([str(writer),str(control/'000001.log'),'0'],env=environment,check=True);assert not proof.exists();subprocess.run([str(writer),str(db/'000001.log'),'1'],env=environment,check=True);assert json.loads(proof.read_bytes())['real_fsync_succeeded'];proof.unlink();(db/'000001.log').unlink()
  with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  chain=evm.Chain(f'http://127.0.0.1:{port}');anvil=subprocess.Popen(['anvil','--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],stdout=log,stderr=log)
  try:
   def ready():
    try:chain.account=chain.rpc('eth_accounts')[0];return True
    except OSError:return False
   wait(ready,'anvil')
   def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
   mailbox=deploy('Mailbox','constructor(uint32)','9913371');hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox);chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox);chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)]);fork=chain.rpc('evm_snapshot')
   def dispatch(label):chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+label.encode().hex()),mailbox)
   for i in range(3):dispatch(f'guard-original-{i}')
   config=temp/'config';config.mkdir();checkpoint=temp/'checkpoints'
   with socket.socket()as s:s.bind(('127.0.0.1',0));metrics=s.getsockname()[1]
   value={'originChainName':'test1','validator':{'key':'0x'+'11'*32},'db':str(db),'checkpointSyncer':{'type':'localStorage','path':str(checkpoint)},'interval':1,'metricsPort':metrics,'chains':{'test1':{'name':'test1','domainId':9913371,'chainId':31337,'protocol':'ethereum','rpcUrls':[{'http':chain.url+'?a'},{'http':chain.url+'?b'}],'rpcConsensusType':'majority','signer':{'type':'hexKey','key':'0x'+'11'*32},'mailbox':mailbox,'validatorAnnounce':announce,'merkleTreeHook':hook,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0}}}};(config/'public.json').write_text(json.dumps(value));base={'HYPERLANE_ZIG_DEFAULTS':str(config),'HYPERLANE_CURL_LIBRARY':'/usr/lib/libcurl.4.dylib'}
   with (cache/'daemon.log').open('w')as output:
    proc=subprocess.Popen([str(binary)],cwd=temp,env={**base,**environment},stdout=output,stderr=output)
    try:
     def live(fn):
      if proc.poll()is not None:raise AssertionError((proc.returncode,(cache/'daemon.log').read_text()))
      return fn()
     wait(lambda:live(lambda:(checkpoint/'2_with_id.json').exists()),'initial checkpoints');objects={p.name:p.read_bytes()for p in checkpoint.glob('*_with_id.json')};assert len(objects)==3
     assert chain.rpc('evm_revert',[fork]);chain.rpc('anvil_setBalance',[evm.TEST_SIGNER,hex(100*10**18)])
     # Restore the public announcement lost by Anvil reversion without asking
     # the halted lane to make any fresh signature.
     announcement=json.loads((checkpoint/'announcement.json').read_bytes());location=announcement['value']['storage_location'];signature=announcement['signature'];r=int(signature['r'],0)if isinstance(signature['r'],str)else signature['r'];s=int(signature['s'],0)if isinstance(signature['s'],str)else signature['s'];v=int(signature['v']);sig='0x'+f'{r:064x}{s:064x}{v:02x}'
     expected_locations='0x'+evm.abi('constructor(string[][])',json.dumps([[location]]))
     def announcement_present():return chain.rpc('eth_call',[{'to':announce,'data':evm.calldata('getAnnouncedStorageLocations(address[])',f'[{evm.TEST_SIGNER}]')},'latest'])==expected_locations
     announcement_restored_by_daemon=announcement_present()
     if not announcement_restored_by_daemon:
      try:chain.send(evm.calldata('announce(address,string,bytes)',evm.TEST_SIGNER,location,sig),announce)
      except AssertionError:
       # The independent lane may replay its already-sealed transaction while
       # the fixture restores it. Accept only exact actual Solidity readback.
       if not announcement_present():raise
       announcement_restored_by_daemon=True
     assert announcement_present()
     nonce_before_fork=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])
     for i in range(4):dispatch(f'guard-canonical-fork-{i}')
     wait(lambda:live(proof.exists),'actual ambiguous WAL sync',20);nonce_at_pending=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest']);time.sleep(.25);assert proc.poll()is None
     assert 'ReorgGuardPersistencePending'in(cache/'daemon.log').read_text();assert objects=={p.name:p.read_bytes()for p in checkpoint.glob('*_with_id.json')}
     started=time.monotonic();proc.terminate();proc.wait(timeout=10);stop_ms=(time.monotonic()-started)*1000;assert proc.returncode==1,(proc.returncode,(cache/'daemon.log').read_text());assert 'ReorgGuardPersistencePending'in(cache/'daemon.log').read_text()
    finally:
     if proc.poll()is None:proc.kill();proc.wait()
   restarted=subprocess.run([str(binary)],cwd=temp,env=base,capture_output=True,text=True,timeout=15);(cache/'restart.log').write_text(restarted.stdout+restarted.stderr);assert restarted.returncode==1,(restarted.returncode,restarted.stderr);assert objects=={p.name:p.read_bytes()for p in checkpoint.glob('*_with_id.json')};assert (checkpoint/'reorg_flag.json').exists();nonce_after_restart=chain.rpc('eth_getTransactionCount',[evm.TEST_SIGNER,'latest'])
   args.output.write_text(json.dumps(chunks({'passed':True,'scope':'unchanged native CLI with fixture-only task-path-restricted DYLD interposer; real guard WAL fsync succeeds but reports EIO; no production fault code','binary':str(binary),'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'interposer_sha256':hashlib.sha256(library.read_bytes()).hexdigest(),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'unrelated_path_negative_control':True,'actual_guard_sync':json.loads(proof.read_bytes()),'sigterm_exit':proc.returncode,'sigterm_ms':stop_ms,'restart_exit':restarted.returncode,'restart_backend_guard_durable':True,'signed_objects_unchanged':True,'signed_objects':3,'new_checkpoint_objects_after_halt':0,'transaction_nonce_unchanged_after_pending_observed':nonce_at_pending==nonce_after_restart,'transaction_nonce_after_restart':int(nonce_after_restart,16),'snapshot_announcement_restored_by_daemon':announcement_restored_by_daemon,'nonce_qualification':'Already-sealed announcement reconciliation may finish after halt; nonce observations do not instrument fresh signing calls. Native signer-gate tests separately check zero fresh signing after the halt signal.','transaction_nonce_before_fork':int(nonce_before_fork,16),'transaction_nonce_at_pending':int(nonce_at_pending,16)}),indent=2)+'\n');print('Validator pending guard SIGTERM/restart passed')
  finally:anvil.terminate();anvil.wait(timeout=5)
if __name__=='__main__':main()
