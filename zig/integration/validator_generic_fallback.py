#!/usr/bin/env python3
"""Generic classic-fallback state-read accounting on the native Tron HTTP bridge.

Real Role/indexing/RocksDB/signing/publication; local repository Solidity state.
Not a Tron consensus client or whole-agent throughput benchmark.
"""
import argparse, contextlib, json, pathlib, subprocess, tempfile, time, urllib.error
import evm
import generic_validator as generic
import relayer_process as helpers
ROOT=evm.ROOT

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/generic-validator-integration')
    parser.add_argument('--after',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/generic-validator-integration-fallback')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-generic-classic-fallback.json')
    args=parser.parse_args();binaries={name:helpers.pin(path,f'generic-validator-fallback-{name}')for name,path in [('before',args.before),('after',args.after)]};contracts=helpers.compile_contracts()
    with tempfile.TemporaryDirectory(prefix='ziggy-public-generic-fallback-')as directory:
        temporary=pathlib.Path(directory);chain=evm.Chain(f'http://127.0.0.1:{helpers.port()}')
        with (temporary/'anvil.log').open('w')as log:
            node=subprocess.Popen(['anvil','--host','127.0.0.1','--port',chain.url.rsplit(':',1)[1],'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:chain.account=chain.rpc('eth_accounts')[0];break
                    except (ConnectionError,urllib.error.URLError):time.sleep(.05)
                else:raise AssertionError('Anvil readiness deadline')
                def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
                domain=3999999999;mailbox=deploy('Mailbox','constructor(uint32)',str(domain));hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox)
                chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox)
                topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)']);messages=[]
                for i in range(3):
                    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+chain.account[2:],'0x'+f'generic-fallback-{i}'.encode().hex()),mailbox)
                    event=next(v for v in receipt['logs']if v['address'].lower()==mailbox.lower()and v['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);messages.append(data[64:64+int.from_bytes(data[32:64],'big')].hex())
                expected=[json.loads(line)for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(m+'\n'for m in messages)).splitlines()];cases={}
                for name,failed in [('before',False),('after',False),('error_rotation',True)]:
                    binary=binaries['after'if failed else name]
                    with generic.TronGateway(chain)as left,generic.TronGateway(chain)as right:
                        if failed:right.delay=.005
                        root=temporary/name;root.mkdir();config=root/'config';config.mkdir();checkpoints=root/'checkpoints'
                        value={'originChainName':'nativefixture','validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoints)},'chains':{'nativefixture':{'name':'nativefixture','domainId':domain,'chainId':31337,'protocol':'tron','rpcConsensusType':'fallback','rpcUrls':[{'http':left.url}],'walletUrls':[{'http':left.url+'/wallet'}],'walletSolidityUrls':[{'http':left.url+'/walletsolidity'},{'http':right.url+'/walletsolidity'}],'mailbox':mailbox,'merkleTreeHook':hook,'validatorAnnounce':announce,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0,'interval':1}}}}
                        (config/'public.json').write_text(json.dumps(value));fixture={'marker':'ziggy-public-generic-validator-integration-v1','config_dir':str(config),'db_path':str(root/'db'),'curl_library':'/usr/lib/libcurl.4.dylib','steps':1,'rpc_timeout_ms':20000};path=root/'fixture.json'
                        def run(steps):
                            fixture['steps']=steps;path.write_text(json.dumps(fixture));result=subprocess.run([str(binary),str(path)],cwd=ROOT,env={},text=True,capture_output=True,timeout=45)
                            if result.returncode:raise AssertionError(result.stderr[-6000:])
                            return json.loads(result.stdout)
                        initial=run(1);assert initial['announcement_pending'],initial
                        signed=json.loads(bytes.fromhex(''.join(initial['announcement_calldata']).removeprefix('0x')));chain.send(evm.calldata('announce(address,string,bytes)',signed['value']['validator'],signed['value']['storage_location'],signed['serialized_signature']),announce)
                        baselines=[gateway.selectors.get(gateway.tree_selector,0)for gateway in [left,right]]
                        if failed:left.fail_tree_after=baselines[0]+2
                        completed=run(12);assert completed['checkpoint_signatures']==3 and completed['latest']==2,completed
                        for i,reference in enumerate(expected):assert json.loads((checkpoints/f'{i}_with_id.json').read_text())['value']['checkpoint']['root'].removeprefix('0x')==reference['root'].removeprefix('0x')
                        reads=[gateway.selectors.get(gateway.tree_selector,0)-base for gateway,base in zip([left,right],baselines)]
                        if name=='after':assert min(reads)<=1 and max(reads)>=6,reads
                        if failed:assert left.tree_failures>0 and reads[0]<=3 and reads[1]>=6,(reads,left.tree_failures)
                        cases[name]={'checkpoint_tree_reads':reads,'http_paths':[gateway.requests for gateway in [left,right]],'actual_tree_failures':left.tree_failures,'checkpoint_objects':3,'rust_roots_match':True,'configured_voting_slots':1}
                artifact={'passed':True,'scope':__doc__,'binaries':{name:{'sha256_chunks':helpers.sha(path)}for name,path in binaries.items()},'cases':cases,'source_behavior':'normal null-consensus: one protocol-authenticated frontier readiness round then one retained primary; rotate on actual error only; explicit quorum remains full fanout'}
                args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(artifact,indent=2)+'\n');print(json.dumps({name:case['checkpoint_tree_reads']for name,case in cases.items()}))
            finally:
                node.terminate()
                try:node.wait(timeout=5)
                except subprocess.TimeoutExpired:node.kill();node.wait()
if __name__=='__main__':main()
