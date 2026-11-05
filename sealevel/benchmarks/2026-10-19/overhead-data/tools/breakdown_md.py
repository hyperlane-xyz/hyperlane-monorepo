import json, statistics as st, sys
from collections import defaultdict
C = json.load(open(sys.argv[1]))
rows = [r for r in C['rows'] if r['prog'] not in ('spl_token','spl_token_2022','spl_associated_token_account','test_send_receiver')]
allrows = C['rows']
def cat(prog, cls):
    c = cls.split(':')[-1]
    hot = {'OutboxDispatch','InboxProcess','TransferRemote','TransferRemoteTo','Handle','HandleLocal','PayForGas','QuoteFee','Verify','SubmitQuote','SubmitIgpQuote','Announce'}
    if c in hot: return 'hot path'
    if 'AccountMetas' in c or c in ('Type','VerifyMetadataSpec','InterchainSecurityModule','GetOwner','GetProgramVersion','InboxGetRecipientIsm','QuoteGasPayment','OutboxGetCount','OutboxGetRoot','OutboxGetLatestCheckpoint') : return 'query / simulation'
    if c.startswith('Init') or c == 'Initialize': return 'init (fixture setup)'
    return 'admin'
pct = lambda x: f"{(x-1)*100:+.0f}%"
ratios = [r['g']/r['r'] for r in allrows if r['r'] > 0]
above = [r for r in allrows if r['r'] > 0 and r['g']/r['r'] > 1]
print(f"All {len(ratios)} pairs: per-call median {pct(st.median(ratios))}; {len(above)} pairs above 1.0.\n")
print("| category | invocations | above Rust | share of the above-Rust pairs | median Go vs Rust | total Go vs Rust |")
print("|---|---:|---:|---:|---:|---:|")
g = defaultdict(list)
for r in rows: g[cat(r['prog'], r['cls'])].append(r)
for k in ['init (fixture setup)','admin','query / simulation','hot path']:
    xs = g[k]; rs=[x['g']/x['r'] for x in xs if x['r']>0]; ab=sum(1 for v in rs if v>1)
    print(f"| {k} | {len(xs)} | {ab} | {ab/len(above)*100:.0f}% | {pct(st.median(rs))} | {pct(sum(x['g'] for x in xs)/sum(x['r'] for x in xs))} |")
other=[r for r in allrows if r not in rows]; rs=[x['g']/x['r'] for x in other if x['r']>0]
print(f"| SPL / test programs (same ELF both sides) | {len(other)} | {sum(1 for v in rs if v>1)} | {sum(1 for v in rs if v>1)/len(above)*100:.0f}% | {pct(st.median(rs))} | {pct(sum(x['g'] for x in other)/sum(x['r'] for x in other))} |")
print("\nTop classes by above-Rust pairs:\n")
print("| program | instruction | n | above Rust | share | Rust median | Go median | median delta | median Go vs Rust | category |")
print("|---|---|---:|---:|---:|---:|---:|---:|---:|---|")
cls = defaultdict(list)
for r in rows: cls[(r['prog'], r['cls'])].append(r)
out=[]
for k, xs in cls.items():
    rs=[x['g']/x['r'] for x in xs if x['r']>0]; ab=sum(1 for v in rs if v>1)
    out.append((ab, k, xs, rs))
out.sort(key=lambda t: -t[0])
for ab, k, xs, rs in out[:int(sys.argv[2]) if len(sys.argv)>2 else 25]:
    rm=st.median(x['r'] for x in xs); gm=st.median(x['g'] for x in xs); d=st.median(x['g']-x['r'] for x in xs)
    print(f"| {k[0]} | {k[1]} | {len(xs)} | {ab} | {ab/len(above)*100:.1f}% | {rm:,.0f} | {gm:,.0f} | {d:+,.0f} | {pct(st.median(rs))} | {cat(*k)} |")
