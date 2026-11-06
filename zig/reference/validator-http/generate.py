#!/usr/bin/env python3
"""Generate exact production validator Axum route fixtures; no live services."""
import argparse, gzip, hashlib, json, pathlib, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
DESTINATION=ROOT/'zig/src/agents/validator/fixtures/http.jsonl'
def chunks(text):return[text[i:i+32]for i in range(0,len(text),32)]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check',action='store_true');args=p.parse_args();cases=[]
 def add(path,**extra):cases.append(dict(method='GET',path=path,**extra))
 add('/ready');add('/ready',actions=[['waiting','']]);add('/ready',actions=[['ready','merkle_tree_hook.tree']])
 add('/ready',actions=[['blocked','b'],['blocked','a'],['blocked','a'],['waiting',''],['ready','unrelated']])
 add('/ready',actions=[['blocked','b'],['blocked','a'],['ready','a']]);add('/ready',actions=[['blocked','a'],['ready','a']])
 for path in ['/eigen/node','/eigen/node/','/eigen/node/services','/eigen/node/services/unknown/health','/eigen/node/health','/missing']:add(path)
 for observed,processed in [(42,30),(42,34),(42,41),(42,50)]:add('/eigen/node/health',observed=observed,processed=processed)
 cases.extend([dict(method='POST',path='/eigen/node'),dict(method='HEAD',path='/eigen/node'),dict(method='HEAD',path='/ready')])
 rows=[dict(index=0,byte=7,block=123),dict(index=2,byte=8,block=None)]
 add('/merkle_tree_insertions?leaf_index_start=0&leaf_index_end=2',insertions=rows)
 add('/merkle_tree_insertions?leaf_index_start=1&leaf_index_end=2',insertions=rows)
 for query in ['leaf_index_start=0&leaf_index_end=0','leaf_index_start=2&leaf_index_end=1','leaf_index_end=2','leaf_index_start=0&leaf_index_start=1&leaf_index_end=2','leaf_index_start=0&leaf_index_end=2_0','leaf_index_start=0&leaf_index_end=0x2','leaf_index_start=0&leaf_index_end=4294967296','leaf_index_start=%2B0&leaf_index_end=2']:
  add('/merkle_tree_insertions?'+query,insertions=rows)
 binary=ROOT/'rust/main/target/release/ziggy-validator-http-reference'
 result=subprocess.run([str(binary)],input=''.join(json.dumps(v)+'\n'for v in cases),text=True,capture_output=True,cwd=ROOT,env={},check=True,timeout=60)
 responses=[json.loads(line)for line in result.stdout.splitlines()];assert len(responses)==len(cases)
 lines=[]
 for case,expected in zip(cases,responses):
  # Rust Instant duration is nondeterministic. All other fields are exact; the
  # port separately tests deterministic monotonic duration/maxima with a clock.
  body=json.dumps(expected.pop('body_json'),separators=(',',':'))if expected['body_json']is not None else expected.pop('body_text')
  expected.pop('body_text',None);expected['body_utf8_chunks']=chunks(body or'')
  lines.append(json.dumps({'input':case,'expected':expected},separators=(',',':')))
 data='\n'.join(lines)+'\n'
 compressed=DESTINATION.with_name(DESTINATION.name+'.gz')
 if args.check:
  assert gzip.decompress(compressed.read_bytes()).decode()==data,'production HTTP fixtures differ'
  if DESTINATION.exists():assert DESTINATION.read_text()==data,'local raw HTTP fixture differs'
 else:
  DESTINATION.write_text(data);compressed.write_bytes(gzip.compress(data.encode(),mtime=0))
 print(f'Checked {len(cases)} production Axum validator routes')
if __name__=='__main__':main()
