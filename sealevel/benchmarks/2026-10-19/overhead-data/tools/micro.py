import re,sys
from collections import defaultdict
pend=None; ev=[]
for line in open(sys.argv[1]):
    m=re.search(r"Program consumption: (\d+) units remaining",line)
    if m: pend=int(m.group(1)); continue
    m=re.search(r"Program log: 0xe2, (0x[0-9a-f]+), ",line)
    if m: ev.append((pend,int(m.group(1),16)))
open_={}; res=defaultdict(list)
for rem,i in ev:
    if i & 0x100:
        b=i&0xff
        if b in open_: res[b].append(open_.pop(b)-rem)
    elif i>=0x20: open_[i]=rem
names={0x20:'empty bracket (K)',0x21:'svm.CreateProgramAddress (5 seeds)',0x22:'svm.NewSeeds encode',0x23:'solana.CreateAddress raw',0x24:'svm.KeyIs match',0x25:'[32]byte == [32]byte',0x26:'svm.MinimumBalance',0x27:'solana.Rent raw',0x28:'Msg + Pubkey + Emit',0x29:'borsh Writer 8x U64',0x2a:'borsh Reader 8x U64',0x2b:'svm.Key copy',0x2c:'Writer.Bytes32',0x2d:'svm.FindProgramAddress'}
names.update(dict(a.split('=',1) for a in sys.argv[2:]) if False else {})
K=min(res[0x20])
for b in sorted(res):
    v=sorted(res[b]); print(f"{names.get(b,hex(b)):40} raw {v[len(v)//2]:6}  net {v[len(v)//2]-K:6}  min {v[0]-K:6} n={len(v)}")
