#!/usr/bin/env python3
"""Production PackedMerkle kernels. Team-idle timing still shares the host."""
import argparse,json,os,pathlib,platform,random,statistics,subprocess,sys,time
from datetime import datetime,timezone
import run as common
ROOT=common.ROOT
CASES=[('packed_ingest',8192,0),('packed_ingest',131072,0),('packed_proof_latest',20000,4096),('packed_proof_latest',20000,65536),('packed_proof_historical',20000,4096),('packed_proof_historical',20000,65536)]
def requests():
 rows=[]
 for n in [1,2,3,255,256,257,511,512,513,4095,4096,4097,65535,65536,65537]:
  pairs={(0,0),(0,n-1),((n-1)//2,n-1),(n-1,n-1),(n//4,n//2),(n//2,n//2)}
  rows += [dict(leaves=n,leaf_index=i,root_index=r) for i,r in sorted(pairs,key=lambda p:(p[1],p[0]))]
 return rows

def chunks(v):
 if isinstance(v,str) and len(v)==64 and all(c in '0123456789abcdef' for c in v):return [v[:32],v[32:]]
 if isinstance(v,list):return [chunks(x) for x in v]
 if isinstance(v,dict):return {k:chunks(x) for k,x in v.items()}
 return v

def main():
 p=argparse.ArgumentParser();p.add_argument('--zig',required=True);p.add_argument('--sysroot');p.add_argument('--optimize',choices=['ReleaseSafe','ReleaseFast'],default='ReleaseSafe');p.add_argument('--samples',type=int,default=9);p.add_argument('--build-only',action='store_true');p.add_argument('--skip-build',action='store_true');p.add_argument('--only-differential',action='store_true');p.add_argument('--output',type=pathlib.Path);args=p.parse_args()
 out=args.output or ROOT/'zig/bench/results'/('packed-'+args.optimize.lower());out.mkdir(parents=True,exist_ok=True)
 common.command([sys.executable,ROOT/'zig/tools/fixture_pack.py','restore-locks'])
 rust=ROOT/'zig/reference/target/release/packed-prover';zig=ROOT/'zig/bench/.cache'/('zig-prover-'+args.optimize);zig.parent.mkdir(parents=True,exist_ok=True)
 env=os.environ.copy();env['RUSTFLAGS']='-C target-cpu=native'
 zcmd=[args.zig,'build-exe','zig/src/prover_bench.zig','-O',args.optimize,'-mcpu=native','-lc',f'-femit-bin={zig}'];
 if args.sysroot:zcmd+=['--sysroot',args.sysroot,'-L/usr/lib']
 if not args.skip_build:
  for name,cmd in [('rust',['cargo','+1.98.0','build','--manifest-path','zig/reference/Cargo.toml','--release','--locked','--bin','packed-prover','-j2']),('zig',zcmd)]:
   result=common.command(cmd,env=env);(out/(name+'-build.log')).write_text(result.stdout+result.stderr)
 sourcefiles=['zig/reference/src/packed_prover.rs','zig/reference/Cargo.toml','zig/reference/Cargo.lock','rust/main/agents/relayer/src/prover/packed.rs','rust/main/hyperlane-core/src/accumulator/merkle.rs','rust/main/hyperlane-core/src/accumulator/incremental.rs','zig/src/prover_bench.zig','zig/src/relayer/prover.zig','zig/src/protocol/merkle.zig','zig/bench/prover.py','zig/bench/run.py']
 metadata=dict(started_at_utc=datetime.now(timezone.utc).isoformat(),base_commit=common.git('rev-parse','HEAD'),git_status=common.git('status','--short'),host=platform.platform(),cpu=common.command(['sysctl','-n','machdep.cpu.brand_string']).stdout.strip() if sys.platform=='darwin' else platform.processor(),zig_version=common.command([args.zig,'version']).stdout.strip(),rust_version=common.command(['rustc','+1.98.0','--version']).stdout.strip(),zig_optimize=args.optimize,rustflags=env['RUSTFLAGS'],zig_command=zcmd,rust_release_overflow_checks=False,source_sha256_chunks={f:common.digest_chunks((ROOT/f).read_bytes()) for f in sourcefiles},binary_sha256_chunks={n:common.digest_chunks(b.read_bytes())for n,b in [('rust',rust),('zig',zig)]},scope='Actual production PackedMerkle CPU kernels only; excludes network, DB, signer, agent runtime; no whole-agent speedup',host_contention='Team compiler jobs paused during measurements; unrelated user workloads remained running and were not stopped',allocators={'rust':'system','zig':'std.heap.smp_allocator'})
 req=requests();data=''.join(json.dumps(x)+'\n' for x in req)
 outputs={n:[json.loads(line)for line in common.command([binary,'vectors'],input=data).stdout.splitlines()]for n,binary in [('rust',rust),('zig',zig)]}
 assert outputs['rust']==outputs['zig'],'production proof differential mismatch'
 vectors=[dict(input=r,expected=chunks(v))for r,v in zip(req,outputs['rust'])];(out/'packed-vectors.jsonl').write_text(''.join(json.dumps(v,separators=(',',':'))+'\n'for v in vectors));metadata['differential']={'queries':len(vectors),'counts':[1,2,3,255,256,257,511,512,513,4095,4096,4097,65535,65536,65537],'checks':['current root','leaf','index','all32 proof siblings','historical root','proof root independently matches production IncrementalMerkle']}
 print('Packed differential passed',len(vectors),'queries',flush=True)
 if not args.build_only and not args.only_differential:
  metadata['load_average_before']=os.getloadavg();rows=[]
  for kernel,iterations,leaves in CASES:
   warm={n:common.measured(b,kernel,iterations,leaves)for n,b in [('rust',rust),('zig',zig)]};assert warm['rust']['checksum']==warm['zig']['checksum'];raw={'rust':[],'zig':[]}
   for trial in range(args.samples):
    for name in (['rust','zig'] if trial%2==0 else ['zig','rust']):
     sample=common.measured(rust if name=='rust' else zig,kernel,iterations,leaves);assert sample['checksum']==warm[name]['checksum'];sample['trial']=trial;raw[name].append(sample)
   summary={n:dict(median_ns=statistics.median(x['ns_per_operation']for x in samples),min_ns=min(x['ns_per_operation']for x in samples),max_ns=max(x['ns_per_operation']for x in samples),stdev_ns=statistics.stdev(x['ns_per_operation']for x in samples)if len(samples)>1 else 0,median_rss_bytes=statistics.median(x['max_rss_bytes']for x in samples) if all(x['max_rss_bytes'] is not None for x in samples) else None)for n,samples in raw.items()};ratio=summary['rust']['median_ns']/summary['zig']['median_ns'];rows.append(dict(kernel=kernel,iterations=iterations,leaves=leaves,samples=raw,summary=summary,rust_over_zig=ratio));print(kernel,leaves,round(ratio,3),flush=True)
  metadata['benchmarks']=rows;metadata['load_average_after']=os.getloadavg();lines=['# Packed prover '+args.optimize,'','Team compiler-idle, shared user host. Rust/Zig>1 favors Zig; every row retained. CPU kernels, no whole-agent claim.','','| Kernel | Leaves | Rust ns/op | Zig ns/op | Rust/Zig |','| --- | ---: | ---: | ---: | ---: |'];lines += [f"| {r['kernel']} | {r['iterations'] if r['kernel']=='packed_ingest' else r['leaves']:,} | {r['summary']['rust']['median_ns']:,.1f} | {r['summary']['zig']['median_ns']:,.1f} | {r['rust_over_zig']:.3f} |"for r in rows];(out/'summary.md').write_text('\n'.join(lines)+'\n')
 metadata['finished_at_utc']=datetime.now(timezone.utc).isoformat();(out/'packed-prover.json').write_text(json.dumps(metadata,indent=2)+'\n')
if __name__=='__main__':main()
