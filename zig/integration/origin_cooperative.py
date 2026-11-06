#!/usr/bin/env python3
"""Real scheduled cooperative EVM origin, three streams and Rust DB restart proof.

Disposable Anvil/repository contracts; public test data only. Correctness evidence,
not a Rust-versus-Zig benchmark or production deployment.
"""
from __future__ import annotations
import argparse, json, pathlib, shutil, subprocess, tempfile, time, urllib.error
import evm
import relayer_process as helpers
ROOT = evm.ROOT

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', type=pathlib.Path, default=ROOT/'zig/zig-out/bin/origin-cooperative-integration')
    parser.add_argument('--oracle', type=pathlib.Path, default=ROOT/'rust/main/target/release/ziggy-rocks-oracle')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT/'zig/bench/results/evm-origin-cooperative-integration.json')
    parser.add_argument('--keep-fixture', type=pathlib.Path)
    args = parser.parse_args()
    driver = helpers.pin(args.driver, 'origin-cooperative-integration')
    contracts = helpers.compile_contracts()
    with tempfile.TemporaryDirectory(prefix='ziggy-public-origin-cooperative-') as directory:
        temporary = pathlib.Path(directory)
        chain = evm.Chain(f'http://127.0.0.1:{helpers.port()}')
        with (temporary/'anvil.log').open('w') as log:
            node = subprocess.Popen(['anvil','--host','127.0.0.1','--port',chain.url.rsplit(':',1)[1],'--chain-id','31337','--silent'],cwd=ROOT,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    if node.poll() is not None: raise AssertionError('Anvil exited')
                    try: chain.account = chain.rpc('eth_accounts')[0]; break
                    except (ConnectionError,urllib.error.URLError): time.sleep(.05)
                else: raise AssertionError('Anvil readiness deadline')
                def deploy(name, signature=None, *values):
                    return chain.send('0x'+contracts[name]+(evm.abi(signature,*values) if signature else ''))['contractAddress']
                mailbox = deploy('Mailbox','constructor(uint32)',str(helpers.ORIGIN))
                hook = deploy('MerkleTreeHook','constructor(address)',mailbox)
                ism = deploy('TestIsm')
                required = deploy('TestPostDispatchHook')
                chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox)
                igp = deploy('InterchainGasPaymaster')
                chain.send(evm.calldata('initialize(address,address)',chain.account,chain.account),igp)
                oracle = deploy('StorageGasOracle')
                chain.send(evm.calldata('setRemoteGasData((uint32,uint128,uint128))',f'({helpers.DESTINATION},10000000000,1)'),oracle)
                chain.send(evm.calldata('setDestinationGasConfigs((uint32,(address,uint96))[])',f'[({helpers.DESTINATION},({oracle},0))]'),igp)
                topic = evm.run(['cast','keccak','Dispatch(address,uint32,bytes32,bytes)'])
                messages = []
                for index in range(3):
                    receipt = chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)',str(helpers.DESTINATION),'0x'+'00'*12+chain.account[2:],'0x'+f'cooperative-origin-{index}'.encode().hex()),mailbox)
                    event = next(v for v in receipt['logs'] if v['address'].lower()==mailbox.lower() and v['topics'][0]==topic)
                    raw = bytes.fromhex(event['data'][2:]); wire = raw[64:64+int.from_bytes(raw[32:64],'big')]
                    identity = evm.run(['cast','keccak','0x'+wire.hex()]); messages.append('0x'+wire.hex())
                    chain.receipt(chain.rpc('eth_sendTransaction',[{'from':chain.account,'to':igp,'data':evm.calldata('payForGas(bytes32,uint32,uint256,address)',identity,str(helpers.DESTINATION),'100000',chain.account),'value':hex(100000),'gas':'0xe00000'}]))
                with helpers.RpcProxy(chain) as proxy:
                    fixture = {'rpc_url':proxy.url,'origin_domain':helpers.ORIGIN,'origin_mailbox':mailbox,'origin_hook':hook,'origin_igp':igp,'state_dir':str(temporary),'messages':messages,'curl_library':'/usr/lib/libcurl.4.dylib'}
                    path = temporary/'fixture.json'; path.write_text(json.dumps(fixture))
                    runs = []
                    probes = []
                    for _ in range(2):
                        result = subprocess.run([str(driver),str(path)],cwd=ROOT,env={},text=True,capture_output=True,timeout=45)
                        if result.returncode: raise AssertionError(result.stderr[-6000:])
                        run = json.loads(result.stdout)
                        assert run['passed'] and run['messages']==3 and run['gas_payments']==3 and run['historical_proofs']==3 and run['suspended_read_continuations']>0,run
                        runs.append(run)
                        probe = helpers.rust_probe(args.oracle.resolve(),temporary/'origin-db',3)
                        for row in probe['messages']:
                            assert row['present'] and row['insertion_id_chunks']==row['id_chunks'],row
                            assert row['payment']=={'payment':'100000','gas_amount':'100000'},row
                        probes.append(probe)
                    assert probes[0]==probes[1],probes
                    rust = evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(m.removeprefix('0x')+'\n'for m in messages))
                    vectors = [json.loads(line)for line in rust.splitlines()]
                    for row, vector in zip(probes[0]['messages'],vectors):
                        assert ''.join(row['id_chunks'])==vector['id'].removeprefix('0x')
                    artifact = {'passed':True,'scope':__doc__,'driver_sha256_chunks':helpers.sha(driver),'native_manifest':'zig/native/rocks/out-final/manifest.json','first':runs[0],'reopen':runs[1],'rust_readback':probes[0],'restart_payment_dedup':True,'rpc_methods':dict(proxy.methods),'rust_source_message_id_parity':True,'source':'actual agents/origin_tasks.zig + evm_origin.zig + native RocksDB + repository Solidity logs'}
                    args.output.parent.mkdir(parents=True,exist_ok=True); args.output.write_text(json.dumps(artifact,indent=2)+'\n')
                    print(json.dumps({'passed':True,'streams':3,'suspensions':[r['suspended_read_continuations']for r in runs],'restart_payment_dedup':True}))
            finally:
                node.terminate()
                try: node.wait(timeout=5)
                except subprocess.TimeoutExpired: node.kill(); node.wait()
                if args.keep_fixture:
                    args.keep_fixture.mkdir(parents=True,exist_ok=True); shutil.copytree(temporary,args.keep_fixture,dirs_exist_ok=True)
if __name__=='__main__': main()
