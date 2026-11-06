#!/usr/bin/env python3
"""Refresh known-domain stack tags using production Rust, preserving IDs/aliases."""
import argparse,json,pathlib,re,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
def main():
 p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.add_argument('--oracle',type=pathlib.Path,default=ROOT/'rust/main/target/release/ziggy-settings-oracle');args=p.parse_args()
 path=ROOT/'zig/src/settings/known_domains.zig';text=path.read_text();ids=[int(v)for v in re.findall(r'\.id = (\d+)',text)]
 result=subprocess.run([str(args.oracle.resolve()),'--domain-stacks'],input=json.dumps(ids),text=True,capture_output=True,check=True,env={})
 stacks={v['id']:v['stack']for v in json.loads(result.stdout)}
 content=re.sub(r'(\.id = (\d+), \.protocol = \.\w+)(?:, \.technical_stack = \.\w+)?',lambda m:m[1]+', .technical_stack = .'+stacks[int(m[2])],text)
 if args.check:
  if content!=text:raise SystemExit('Known domain stacks differ from production Rust')
 else:path.write_text(content)
 print(f'Checked {len(ids)} production known-domain stack tags')
if __name__=='__main__':main()
