#!/usr/bin/env python3
"""Native AWS KMS wire/concurrency + real RocksDB/local checkpoint recovery.

A loopback emulator checks the real SigV4 request and signs only public test key11
through the independent Rust k256 oracle. No live cloud access or benchmark claim.
"""
import argparse, base64, collections, hashlib, hmac, http.server, json, pathlib, subprocess, tempfile, threading, time
import evm
import relayer_process as helpers
ROOT=evm.ROOT
ARN='arn:aws:kms:us-east-1:000000000000:key/public-fixture'
class Kms:
    def __init__(self,oracle,fail_attempts=0):self.fail_attempts=fail_attempts;self.oracle=oracle;self.calls=collections.Counter();self.lock=threading.Lock();self.active=0;self.peak=0;self.errors=[]
    def signature(self,digest):
        request={'operation':'public_fixture_kms','digest':[digest[i:i+32]for i in range(0,len(digest),32)]}
        p=subprocess.run([str(self.oracle)],input=json.dumps(request)+'\n',text=True,capture_output=True,env={},timeout=10)
        if p.returncode:raise AssertionError(p.stderr)
        return json.loads(p.stdout)['expected']
    def __enter__(self):
        owner=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                raw=self.rfile.read(int(self.headers['content-length']))
                try:
                    authorization=self.headers['authorization'];parameters=dict(part.strip().split('=',1)for part in authorization.removeprefix('AWS4-HMAC-SHA256 ').split(','));scope='20261105/us-east-1/kms/aws4_request'
                    assert parameters['Credential']=='PUBLICFIXTURE/'+scope
                    names=parameters['SignedHeaders'].split(';');headers=''.join(name+':'+ ' '.join(self.headers[name].split())+'\n'for name in names)
                    canonical='POST\n/\n\n'+headers+'\n'+parameters['SignedHeaders']+'\n'+hashlib.sha256(raw).hexdigest()
                    signing=b'AWS4public-fixture'
                    for part in ['20261105','us-east-1','kms','aws4_request']:signing=hmac.new(signing,part.encode(),hashlib.sha256).digest()
                    message='AWS4-HMAC-SHA256\n20261105T120000Z\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
                    assert hmac.compare_digest(parameters['Signature'],hmac.new(signing,message.encode(),hashlib.sha256).hexdigest())
                    request=json.loads(raw);target=self.headers['x-amz-target'];status=200
                    if target.endswith('GetPublicKey'):
                        assert request['KeyId']=='alias/public-fixture';fixture=owner.signature('00'*32)
                        with owner.lock:owner.calls['GetPublicKey']+=1
                        response={'KeyId':ARN,'KeySpec':'ECC_SECG_P256K1','KeyUsage':'SIGN_VERIFY','SigningAlgorithms':['ECDSA_SHA_256'],'PublicKey':base64.b64encode(bytes.fromhex(''.join(fixture['public_key_der']))).decode()}
                    else:
                        assert target.endswith('Sign')and request['KeyId']==ARN and request['SigningAlgorithm']=='ECDSA_SHA_256'and request['MessageType']=='DIGEST'
                        digest=base64.b64decode(request['Message']);assert len(digest)==32
                        with owner.lock:owner.active+=1;owner.peak=max(owner.peak,owner.active);owner.calls[digest.hex()]+=1;attempt=owner.calls[digest.hex()]
                        try:
                            time.sleep(.05)
                            if attempt<=owner.fail_attempts:status=500;response={'__type':'KMSInternalException','message':'injected public fixture transient failure'}
                            else:
                                fixture=owner.signature(digest.hex())
                                response={'KeyId':ARN,'SigningAlgorithm':'ECDSA_SHA_256','Signature':base64.b64encode(bytes.fromhex(''.join(fixture['signature_der']))).decode()}
                        finally:
                            with owner.lock:owner.active-=1
                    body=json.dumps(response).encode();self.send_response(status);self.send_header('Content-Type','application/x-amz-json-1.1');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
                except Exception as error:
                    with owner.lock:owner.errors.append(type(error).__name__+':'+str(error))
                    body=b'{"error":"public fixture rejected request"}';self.send_response(500);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def log_message(self,*args):pass
        class Server(http.server.ThreadingHTTPServer):daemon_threads=True
        self.server=Server(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_port}';return self
    def __exit__(self,*args):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--driver',type=pathlib.Path,default=ROOT/'zig/zig-out/bin/validator-parallel-http-integration');p.add_argument('--oracle',type=pathlib.Path,default=ROOT/'rust/main/target/release/ziggy-evm-oracle');p.add_argument('--fail-sign-attempts',type=int,choices=range(7),default=0);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-parallel-http-integration.json');args=p.parse_args();driver=helpers.pin(args.driver,'validator-parallel-http');oracle=helpers.pin(args.oracle,'public-key11-kms-oracle')
    with tempfile.TemporaryDirectory(prefix='ziggy-public-validator-concurrency-')as directory,Kms(oracle,args.fail_sign_attempts)as kms:
        root=pathlib.Path(directory);config=root/'public.json';objects=root/'objects';address='0x'+'00'*19+'01'
        config.write_text(json.dumps({'originChainName':'parallelfixture','validator':{'type':'aws','id':'alias/public-fixture','region':'us-east-1'},'checkpointSyncer':{'type':'localStorage','path':str(objects)},'chains':{'parallelfixture':{'name':'parallelfixture','domainId':3999999999,'chainId':31337,'protocol':'ethereum','rpcUrls':[{'http':'http://127.0.0.1:1'}],'mailbox':address,'merkleTreeHook':address,'validatorAnnounce':address,'interchainGasPaymaster':address,'blocks':{'reorgPeriod':0}}}}))
        fixture=root/'fixture.json';fixture.write_text(json.dumps({'marker':'ziggy-public-validator-concurrency-v1','config_path':str(config),'db_path':str(root/'db'),'kms_endpoint':kms.url,'curl_library':'/usr/lib/libcurl.4.dylib'}))
        result=subprocess.run([str(driver),str(fixture)],cwd=ROOT,env={},text=True,capture_output=True,timeout=30)
        exhausted=None
        if args.fail_sign_attempts==6:
            assert result.returncode!=0 and 'KmsHttpStatus'in result.stderr,(result.returncode,result.stderr)
            exhausted={digest:count for digest,count in kms.calls.items()if digest!='GetPublicKey'}
            assert len(exhausted)==4 and set(exhausted.values())=={6},exhausted
            assert not list(objects.glob('*_with_id.json'))
            kms.fail_attempts=0
            result=subprocess.run([str(driver),str(fixture)],cwd=ROOT,env={},text=True,capture_output=True,timeout=30)
        if result.returncode:raise AssertionError((result.stderr,kms.errors))
        value=json.loads(result.stdout);assert value['published']==8 and value['replayed']==0 and value['native_parallel_capability']
        assert not kms.errors,kms.errors
        signatures={digest:count for digest,count in kms.calls.items()if digest!='GetPublicKey'}
        expected={digest:((7 if digest in exhausted else 1)if exhausted is not None else args.fail_sign_attempts+1)for digest in signatures}
        assert len(signatures)==8 and signatures==expected and kms.calls['GetPublicKey']==(2 if exhausted is not None else 1),dict(kms.calls)
        assert 2<=kms.peak<=4,kms.peak
        references=[json.loads(line)for line in evm.run([ROOT/'zig/reference/target/release/ziggy-rust-reference','vectors'],input=''.join(message.removeprefix('0x')+'\n'for message in value['message_encodings'])).splitlines()]
        for index,reference in enumerate(references):
            checkpoint=json.loads((objects/f'{index}_with_id.json').read_text());assert checkpoint['value']['checkpoint']['root'].removeprefix('0x')==reference['root'].removeprefix('0x')and checkpoint['value']['message_id'].removeprefix('0x')==reference['id'].removeprefix('0x')
        artifact={'passed':True,'scope':__doc__,'driver_sha256_chunks':helpers.sha(driver),'oracle_sha256_chunks':helpers.sha(oracle),'checkpoints':8,'configured_concurrency':4,'observed_native_kms_overlap':kms.peak,'public_key_requests':kms.calls['GetPublicKey'],'signature_requests':sum(signatures.values()),'injected_failures_per_digest':args.fail_sign_attempts,'exhausted_same_identity_attempts':6 if exhausted is not None else None,'exhausted_unsigned_digests':len(exhausted)if exhausted is not None else 0,'recovered_same_db_after_exhaustion':exhausted is not None,'all_sigv4_requests_verified':True,'roots_message_ids_match_production_rust':True,'restart_new_signature_requests':0,'digest_counts':[{'digest_chunks':helpers.chunks(digest),'calls':count}for digest,count in signatures.items()]}
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(artifact,indent=2)+'\n');print(json.dumps({'passed':True,'concurrency':kms.peak,'signature_requests':sum(signatures.values()),'retry_failures':args.fail_sign_attempts,'restart_new_signatures':0}))
if __name__=='__main__':main()
