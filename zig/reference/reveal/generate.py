#!/usr/bin/env python3
"""Regenerate independent UR helpers from actual Rust bodies and Solana SDK."""
import argparse,copy,hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
HERE=pathlib.Path(__file__).resolve().parent
DEST=ROOT/'zig/src/agents/destination/fixtures/reveal.jsonl'
SOURCE=ROOT/'rust/main/chains/hyperlane-sealevel/src/universal_router_reveal.rs'
def chunks(value):
 value=value.hex()if isinstance(value,bytes)else value
 return[value[i:i+32]for i in range(0,len(value),32)]
def key(byte):return chunks(bytes([byte])*32)
def num(value):return str(value)
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');args=parser.parse_args();cases=[]
 def add(kind,name,value):cases.append(dict(kind=kind,name=name,input=value))
 # Program IDs are public source constants, decoded with the existing SDK reference.
 alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
 def base58(text):
  value=0
  for c in text:value=value*58+alphabet.index(c)
  return chunks(value.to_bytes(32,'big'))
 token=base58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');token22=base58('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');wsol=base58('So11111111111111111111111111111111111111112')
 for current,spacing in[(0,1),(1,1),(-1,1),(59,1),(60,1),(-60,1),(-61,1),(12345,8),(-12345,8),(2147483647,32767),(-2147483648,32767),(0,0),(0,-1)]:add('tick',f'tick-{current}-{spacing}',dict(current=num(current),spacing=num(spacing),pool=key(5)))
 for origin,token_program in[(0,token),(1,token),(4294967295,token22)]:add('pda',f'pda-{origin}',dict(program=key(9),origin=num(origin),sender=key(2),user_salt=key(5),commitment=key(3),owner=key(6),mint=key(4),token_program=token_program))
 # These do not derive expected values in Python: Rust production core hashes and
 # k256 sign public fixture key11. Arrays just avoid credential-shaped long text.
 for size in[0,32,97]:add('ccs',f'ccs-{size}',dict(sender=chunks(bytes([3])*20),commitment=chunks(bytes([11])*size),url='https://ccs.fixture/base/calldata'))
 def request(count=15):
  accounts=[dict(pubkey=key(i+1),is_signer=False,is_writable=True)for i in range(count)]
  if count>11:accounts[11]['pubkey']=token
  if count>14:accounts[14]['pubkey']=key(4)
  if count>23:accounts[23]['pubkey']=token
  return dict(program=key(9),origin='1',sender=key(2),user_salt=key(5),recipient=key(6),salt=key(3),data=chunks(b'route'),accounts=accounts,pool_data=None)
 add('build','degraded-15',request())
 add('close','degraded-close',request())
 add('build','degraded-14-no-close',request(14))
 add('close','degraded-14-reject',request(14))
 for name,tick,spacing,reverse,native in[('forward',240,8,False,False),('negative',-1,8,False,False),('reverse',240,8,True,False),('wsol',-481,8,False,True),('minimum',-2147483648,32767,False,False),('maximum',2147483647,32767,True,False)]:
  value=request(24);pool=bytearray(273)
  for offset,byte in[(9,31),(73,4),(105,33),(137,34),(169,35),(201,36)]:pool[offset:offset+32]=bytes([byte])*32
  if native:pool[105:137]=bytes.fromhex(''.join(wsol))
  pool[235:237]=spacing.to_bytes(2,'little',signed=True);pool[269:273]=tick.to_bytes(4,'little',signed=True)
  value['pool_data']=chunks(bytes(pool))
  if reverse:value['accounts'][14]['pubkey']=key(33)
  add('build','clmm-'+name,value);add('close','clmm-close-'+name,copy.deepcopy(value))
 value=request(24);value['pool_data']=chunks(bytes(272));add('build','truncated-pool',value)
 value=request(24);add('build','absent-pool',value)
 binary=ROOT/'rust/main/target/release/ziggy-reveal-reference'
 run=subprocess.run([str(binary)],input=''.join(json.dumps(v)+'\n'for v in cases),text=True,capture_output=True,cwd=ROOT,env={},check=True,timeout=90)
 rows=[json.loads(v)for v in run.stdout.splitlines()];assert len(rows)==len(cases)
 data=''.join(json.dumps(v,separators=(',',':'))+'\n'for v in rows)
 if args.check:assert DEST.read_text()==data,'actual Rust reveal fixture changed'
 else:DEST.parent.mkdir(parents=True,exist_ok=True);DEST.write_text(data)
 def sha(path):return chunks(hashlib.sha256(path.read_bytes()).hexdigest())
 raw=SOURCE.read_text();spans=[]
 for start,end in[("const RAYDIUM_CLMM_PROGRAM:","async fn fetch_clmm_pool_state("),("async fn fetch_clmm_pool_state(","// Mirrors reveal.mjs"),("#[allow(clippy::arithmetic_side_effects)]\nfn get_tick_array_start_index","/// Configuration for automated UR reveal submission"),("#[derive(Deserialize, Debug)]\nstruct CcsGetResponse","/// If `message` looks like a UR COMMIT"),("fn derive_fee_payer_pda(","// PendingSwap layout"),("async fn build_instruction(","#[cfg(test)]\nmod tests")]:
  begin=raw.index(start);finish=raw.index(end,begin);spans.append(dict(first_line=raw[:begin].count('\n')+1,last_line=raw[:finish].count('\n')+1,sha256_chunks=chunks(hashlib.sha256(raw[begin:finish].encode()).hexdigest())))
 meta=dict(scope='Actual unmodified Rust production helper bodies + Solana SDK legacy compiler. RPC fixture returns injected account bytes. Minimal RevealContext exposes only fields read by production build_instruction. No live CCS, chain, simulation, transaction broadcast or durable runner acceptance.',source=str(SOURCE.relative_to(ROOT)),source_sha256_chunks=sha(SOURCE),extraction_spans=spans,reference_sha256_chunks=sha(HERE/'src/main.rs'),lock_sha256_chunks=sha(HERE/'Cargo.lock'),binary_sha256_chunks=sha(binary),fixtures=len(rows),fixture_sha256_chunks=sha(DEST),public_signing_keys='Ed25519 seed7; secp256k1 key11 only',transaction_wrapper='Solana SDK compute limit then price0 then actual source instructions; blockhash repeated8; SDK Transaction::new with seed7. This is a transparent reference wrapper around production instruction helpers, not an invocation of production submit_reveal.')
 if not args.check:(HERE/'provenance.json').write_text(json.dumps(meta,indent=2)+'\n')
 print(f'Checked {len(rows)} actual Rust UR helper / Solana SDK fixtures')
if __name__=='__main__':main()
