#!/usr/bin/env python3
"""Production role parser oracle; disposable cwd + explicit env only, no credentials."""
import argparse,gzip,json,pathlib,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[3]
BASE={"validator":{"originChainName":"ethereum","validator":{"key":"0x"+"11"*32},"checkpointSyncer":{"type":"localStorage","path":"/tmp/public-fixture"}},"relayer":{"relayChains":"ethereum"},"scraper":{"chainsToScrape":"ethereum","db":"postgresql://localhost/disposable"}}
def merge(a,b):
 out=dict(a)
 for k,v in b.items():out[k]=merge(out[k],v) if isinstance(v,dict) and isinstance(out.get(k),dict) else v
 return out
def cases():
 yield "relayer-default","relayer",{}, {},[]
 yield "relayer-deduplicate","relayer",{"relayChains":"ethereum,ethereum"},{},[]
 yield "relayer-multiple-vms","relayer",{"relayChains":"ethereum,solanamainnet,kyve,tron,radix,starknet"},{},[]
 yield "relayer-technical-stacks","relayer",{"relayChains":"arbitrum,base,abstract,ethereum"},{},[]
 yield "known-stack-overrides-config","relayer",{"chains":{"ethereum":{"technicalStack":"opstack"}}},{},[]
 for name,fields in [ ("local-false",{"allowLocalCheckpointSyncers":False}), ("local-true",{"allowLocalCheckpointSyncers":True}), ("decoy-cache-flag",{"allowContractCallCaching":False}), ("minimum-policy",{"gasPaymentEnforcement":[{"type":"minimum","payment":"123"}]}),("minimum-missing-payment",{"gasPaymentEnforcement":[{"type":"minimum"}]}),("quote-policy",{"gasPaymentEnforcement":[{"type":"onChainFeeQuoting","gasFraction":" 1 / 2 "}]}),("zero-denominator",{"gasPaymentEnforcement":[{"type":"onChainFeeQuoting","gasFraction":"1/0"}]}),("empty-policy",{"gasPaymentEnforcement":[]}),("string-policy",{"gasPaymentEnforcement":'[ {"type":"none","matchingList":[{"originDomain":"1"}]} ]'}),("matching-invalid-json",{"whitelist":"invalid-json"}),("matching-unknown-field",{"whitelist":[{"unknown":1}]}),("retry-zero",{"maxMessageRetries":0}),("rates-zero",{"relayApiRateLimitMaxRequests":0}),("poll-zero",{"runtimeDenylistPollIntervalSecs":0}),("deny-invalid",{"runtimeDenylistUrl":"ftp://example.com/file"}),("identity-wrong-vm",{"chains":{"ethereum":{"identity":{"key":"0x"+"11"*32}}}}),("invalid-known-id",{"chains":{"ethereum":{"domainId":2}}}),("invalid-block-object",{"chains":{"ethereum":{"blocks":None}}}),("hex-integer",{"metricsPort":"0x2382"}),("underscore-integer",{"metricsPort":"9_090"}),("index-negative",{"chains":{"ethereum":{"index":{"from":"-10"}}}}),("rpc-override",{"chains":{"ethereum":{"customRpcUrls":"https://example.com"}}}),("default-signer",{"defaultSigner":{"type":"hexKey","key":"0x"+"11"*32}}),("bad-default-signer",{"defaultSigner":{"type":"node"}})]:yield name,"relayer",fields,{},[]
 for name,rule in [('scalar-domain-hex',{'originDomain':'0x1'}),('array-domain-hex',{'originDomain':['0x1']}),('scalar-domain-decimal',{'originDomain':'1'}),('array-domain-decimal',{'originDomain':['1',2]}),('scalar-domain-plus',{'originDomain':'+1'}),('array-domain-plus',{'originDomain':['+1']}),('scalar-domain-underscore',{'originDomain':'1_000'}),('array-domain-underscore',{'originDomain':['1_000']}),('scalar-domain-max',{'originDomain':'4294967295'}),('array-domain-overflow',{'originDomain':['4294967296']}),('regex-explicit-null',{'bodyRegex':None}),('regex-null-with-domain',{'bodyRegex':None,'originDomain':1}),('regex-empty-string',{'bodyRegex':''})]:yield name,'relayer',{'whitelist':[rule]},{},[]
 for chain in ["ethereum","solanamainnet","kyve","tron","starknet","radix"]:yield "validator-"+chain,"validator",{"originChainName":chain},{},[]
 for name,fields,args in [("light-bare",{"websocketUrl":"wss://example.com"},["--lightweight"]),("typo-bare",{"websocketUrl":"wss://example.com"},["--leightweigt"]),("light-no-ws",{"lightweight":True},[]),("conflict-alias",{"lightweight":True,"leightweigt":False,"websocketUrl":"wss://example.com"},[]),("interval-override",{"interval":"4","chains":{"ethereum":{"index":{"interval":7}}}},[]),("interval-chain",{"chains":{"ethereum":{"index":{"interval":7}}}},[]),("max-zero",{"maxSignConcurrency":0},[]),("max-boundary",{"maxSignConcurrency":1000},[]),("max-overflow",{"maxSignConcurrency":1001},[]),("single",{"chains":{"ethereum":{"rpcConsensusType":"single"}}},[]),("removed-rpcs",{"chains":{"ethereum":{"additionalQuorumRpcUrls":[]}}},[])]:yield name,"validator",fields,{},args
 yield "scraper-default","scraper",{}, {},[]
 yield "scraper-overrides","scraper",{"dbMaxConnections":0,"dbAcquireTimeoutMillis":123}, {},[]
 yield "cli-env-precedence","relayer",{"maxMessageRetries":1},{"HYP_MAXMESSAGERETRIES":"2"},["--maxMessageRetries=3"]
def chunk(v):
 if isinstance(v,str) and len(v.removeprefix('0x'))==64 and all(c in '0123456789abcdefABCDEF' for c in v.removeprefix('0x')):return {"__chunks__":[v[i:i+32] for i in range(0,len(v),32)]}
 if isinstance(v,dict):return {k:chunk(x) for k,x in v.items()}
 if isinstance(v,list):return [chunk(x) for x in v]
 return v
def main():
 p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.add_argument('--oracle',type=pathlib.Path,default=ROOT/'rust/main/target/release/ziggy-settings-oracle');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/src/settings/fixtures/roles.jsonl');args=p.parse_args();rows=[]
 with tempfile.TemporaryDirectory(prefix='ziggy-public-settings-') as d:
  cwd=pathlib.Path(d);shutil.copytree(ROOT/'rust/main/config',cwd/'config')
  for name,role,override,environment,arguments in cases():
   values=merge(BASE[role],override);path=cwd/'override.json';path.write_text(json.dumps(values));env={'FIXTURE_ROLE':role,'CONFIG_FILES':str(path),**environment}
   result=subprocess.run([str(args.oracle.resolve()),*arguments],cwd=cwd,env=env,capture_output=True,text=True,check=True);expected=json.loads(result.stdout.splitlines()[-1]);rows.append(chunk(dict(name=name,role=role,overrides=values,environment=environment,arguments=arguments,expected=expected)))
 content=''.join(json.dumps(r,separators=(',',':'))+'\n' for r in rows)
 compressed=args.output.with_name(args.output.name+'.gz')
 if args.check:
  if gzip.decompress(compressed.read_bytes()).decode()!=content:raise SystemExit('Production role fixtures differ')
  if args.output.exists()and args.output.read_text()!=content:raise SystemExit('Local raw role fixture differs')
 else:
  args.output.write_text(content);compressed.write_bytes(gzip.compress(content.encode(),mtime=0))
 print(f'Checked {len(rows)} production role fixtures' if args.check else f'Generated {len(rows)} production role fixtures')
if __name__=='__main__':main()
