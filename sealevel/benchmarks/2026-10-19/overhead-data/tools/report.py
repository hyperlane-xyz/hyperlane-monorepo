#!/usr/bin/env python3
"""Go vs Rust summary tables. Usage: report.py <probes.json> rust=<json>... go=<json>..."""
import json, sys, statistics as st
from collections import defaultdict
import os
HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(sys.argv[1]))
runs = [a.split('=', 1) for a in sys.argv[2:]]
R = {k: json.load(open(v)) for k, v in runs if not k.startswith('go')}
G = {k: json.load(open(v)) for k, v in runs if k.startswith('go')}
exec(open(os.path.join(HERE, 'labels.py')).read())
SKIP = {'spl_token', 'spl_token_2022', 'spl_associated_token_account', 'test_send_receiver'}
def groups(run):
    out = {}
    for s, x in run['suites'].items():
        for t, y in x['tests'].items():
            g = defaultdict(list)
            for i in y['invocations']: g[i['program_id']].append(i)
            for pid, l in g.items(): out[(s, t, pid)] = l
    return out
lab = {}
for s, tests in P.items():
    for t, invs in tests.items():
        g = defaultdict(list)
        for i in invs: g[i['pid']].append(i)
        for pid, l in g.items(): lab[(s, t, pid)] = l
def pairs(r, g, metric='cu'):
    rg, gg = groups(r), groups(g)
    out = []
    for k, gl in gg.items():
        rl = rg.get(k)
        if not rl or len(rl) != len(gl) or gl[0]['program'] in SKIP: continue
        pl = lab.get(k)
        for i, (a, b) in enumerate(zip(rl, gl)):
            cls = '?'
            if pl and len(pl) == len(gl) and pl[i]['probes'] and pl[i]['probes'][0][1] == 0xE0:
                pr = pl[i]['probes'][0]; cls = label(b['program'], pr[2], pr[3], pr[4])
            out.append((b['program'], cls, a[metric], b[metric]))
    return out
def pct(x):  # ratio -> "+9%" / "-29%"
    return f"{(x-1)*100:+.0f}%"
HOT = {('mailbox','OutboxDispatch'):'dispatch', ('mailbox','InboxProcess'):'process',
       ('token','ix:TransferRemote'):'transfer_remote (synthetic)', ('token_collateral','ix:TransferRemote'):'transfer_remote (collateral)',
       ('token_native','ix:TransferRemote'):'transfer_remote (native)', ('token_cross_collateral','cc:TransferRemoteTo'):'transfer_remote_to (cc)',
       ('token','recipient:Handle'):'handle (synthetic)', ('igp','PayForGas'):'IGP pay_for_gas', ('fee','QuoteFee'):'fee quote',
       ('multisig_ism_message_id','ism:Verify'):'multisig verify', ('composite_ism','ism:Verify'):'composite verify'}
for rk in R:
    print(f"\n### vs {rk}")
    print("| Go run | pairs | per-call median | p90 | total CU |")
    for gk in G:
        p = pairs(R[rk], G[gk])
        rs = [b / a for _, _, a, b in p if a > 0]
        q = sorted(rs)
        print(f"| {gk} | {len(p)} | {pct(st.median(rs))} | {pct(q[int(0.9*(len(q)-1))])} | {pct(sum(b for *_, b in p)/sum(a for _, _, a, _ in p))} |")
    print("\nper program total CU:")
    progs = sorted({x[0] for x in pairs(R[rk], G[list(G)[0]])})
    print("| program | " + " | ".join(G) + " |")
    for pr in progs:
        row = []
        for gk in G:
            p = [x for x in pairs(R[rk], G[gk]) if x[0] == pr]
            row.append(pct(sum(x[3] for x in p) / sum(x[2] for x in p)))
        print(f"| {pr} | " + " | ".join(row) + " |")
    print("\nhot paths (median CU, Go vs Rust):")
    print("| path | n | Rust | " + " | ".join(G) + " |")
    for (pr, cls), name in HOT.items():
        cells = []; rmed = None; n = 0
        for gk in G:
            p = [x for x in pairs(R[rk], G[gk]) if x[0] == pr and x[1] == cls]
            if not p: cells.append('-'); continue
            n = len(p); rmed = st.median(x[2] for x in p); gmed = st.median(x[3] for x in p)
            cells.append(f"{gmed:,.0f} ({pct(gmed/rmed)})")
        print(f"| {name} | {n} | {rmed:,.0f} | " + " | ".join(cells) + " |" if rmed else f"| {name} | - |")
