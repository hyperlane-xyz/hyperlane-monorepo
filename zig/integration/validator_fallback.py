#!/usr/bin/env python3
"""Actual classic-fallback Role RPC behavior on disposable Solidity/Anvil.

Before/after role-level request accounting, not whole-agent throughput. Explicit
majority/quorum behavior is verified by the separate full validator integration.
"""
import argparse, contextlib, json, pathlib, subprocess, tempfile, time, urllib.error
import evm
import relayer_process as helpers
ROOT=evm.ROOT

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/zig-validator-integration')
    parser.add_argument('--after',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/zig-validator-integration-fallback')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-classic-fallback.json')
    args=parser.parse_args()
    binaries={name:helpers.pin(path,f'validator-fallback-{name}')for name,path in [('before',args.before),('after',args.after)]}
    contracts=helpers.compile_contracts()
    with tempfile.TemporaryDirectory(prefix='ziggy-public-validator-fallback-')as directory:
        temporary=pathlib.Path(directory);chain=evm.Chain(f'http://127.0.0.1:{helpers.port()}')
        with (temporary/'anvil.log').open('w')as log:
            node=subprocess.Popen(['anvil','--host','127.0.0.1','--port',chain.url.rsplit(':',1)[1],'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:chain.account=chain.rpc('eth_accounts')[0];break
                    except (ConnectionError,urllib.error.URLError):time.sleep(.05)
                else:raise AssertionError('Anvil readiness deadline')
                def deploy(name,signature=None,*values):return chain.send('0x'+contracts[name]+(evm.abi(signature,*values)if signature else''))['contractAddress']
                mailbox=deploy('Mailbox','constructor(uint32)',str(helpers.ORIGIN));hook=deploy('MerkleTreeHook','constructor(address)',mailbox);ism=deploy('TestIsm');required=deploy('TestPostDispatchHook');announce=deploy('ValidatorAnnounce','constructor(address)',mailbox)
                chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox)
                topic=evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)']);messages=[]
                for i in range(3):
                    receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)',str(helpers.DESTINATION),'0x'+'00'*12+chain.account[2:],'0x'+f'fallback-{i}'.encode().hex()),mailbox)
                    event=next(v for v in receipt['logs']if v['address'].lower()==mailbox.lower()and v['topics'][0]==topic);data=bytes.fromhex(event['data'][2:]);messages.append(data[64:64+int.from_bytes(data[32:64],'big')].hex())
                expected=[json.loads(line)for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(m+'\n'for m in messages)).splitlines()]
                cases={}
                for name,failed in [('before',False),('after',False),('error_rotation',True)]:
                    binary=binaries['after'if failed else name]
                    with contextlib.ExitStack()as stack:
                        peers=[stack.enter_context(helpers.RpcProxy(chain,delay=(.010*i if failed else 0),fail_method=('eth_call'if failed and i==0 else None)))for i in range(3)]
                        root=temporary/name;root.mkdir();config=root/'config';config.mkdir();checkpoints=root/'checkpoints'
                        value={'originChainName':'test1','validator':{'key':'0x'+'11'*32},'checkpointSyncer':{'type':'localStorage','path':str(checkpoints)},'chains':{'test1':{'name':'test1','domainId':helpers.ORIGIN,'chainId':31337,'protocol':'ethereum','rpcConsensusType':'fallback','rpcUrls':[{'http':p.url}for p in peers],'mailbox':mailbox,'merkleTreeHook':hook,'validatorAnnounce':announce,'interchainGasPaymaster':required,'blocks':{'reorgPeriod':0},'index':{'from':0,'interval':1}}}}
                        (config/'public.json').write_text(json.dumps(value));fixture={'marker':'ziggy-public-validator-integration-v1','config_dir':str(config),'db_path':str(root/'db'),'curl_library':'/usr/lib/libcurl.4.dylib','steps':1,'rpc_timeout_ms':20000};path=root/'fixture.json'
                        def run(steps):
                            fixture['steps']=steps;path.write_text(json.dumps(fixture));result=subprocess.run([str(binary),str(path)],cwd=ROOT,env={},text=True,capture_output=True,timeout=45)
                            if result.returncode:raise AssertionError(result.stderr[-6000:])
                            return json.loads(result.stdout)
                        initial=run(1);assert initial['announcement_pending']and initial['configured_slots']==1,initial
                        initial_counts=[dict(p.methods)for p in peers]
                        chain.send(''.join(initial['announcement_calldata']),announce)
                        signed=run(6);assert signed['checkpoint_signatures']==3 and signed['latest']==2,signed
                        for i,reference in enumerate(expected):
                            checkpoint=json.loads((checkpoints/f'{i}_with_id.json').read_text());assert checkpoint['value']['checkpoint']['root'].removeprefix('0x')==reference['root'].removeprefix('0x')
                        counts=[dict(p.methods)for p in peers];data_peers=[i for i,methods in enumerate(counts)if methods.get('eth_call',0)>0]
                        signed_data_peers=[i for i,methods in enumerate(counts)if methods.get('eth_call',0)>initial_counts[i].get('eth_call',0)]
                        initial_data_peers=[i for i,methods in enumerate(initial_counts)if methods.get('eth_call',0)>0]
                        if name=='after':assert len(initial_data_peers)==1 and len(signed_data_peers)==1,(initial_counts,counts)
                        if failed:assert counts[0].get('eth_call',0)>0 and counts[1].get('eth_call',0)>0 and counts[2].get('eth_call',0)==0,counts
                        cases[name]={'physical_rpc_methods':counts,'total_requests':sum(sum(p.values())for p in counts),'checkpoint_data_peers':data_peers,'per_role_data_peers':[initial_data_peers,signed_data_peers],'checkpoint_objects':3,'source_rust_roots_match':True,'configured_checkpoint_voting_slots':1}
                result={'passed':True,'scope':__doc__,'binaries':{name:{'sha256_chunks':helpers.sha(path)}for name,path in binaries.items()},'cases':cases,'source_behavior':'checkpoint_consensus null: bounded startup chain-ID readiness, then one priority healthy checkpoint endpoint; next only after actual error','explicit_consensus_unchanged':True}
                args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({name:case['total_requests']for name,case in cases.items()}))
            finally:
                node.terminate()
                try:node.wait(timeout=5)
                except subprocess.TimeoutExpired:node.kill();node.wait()
if __name__=='__main__':main()
