#!/usr/bin/env python3
"""Exclusive CU attribution from bracket probes (p2) per instruction class.
Usage: attrib.py <p2-probes.json> <classes-self.json from classify.py>"""
import json, sys, statistics as st
from collections import defaultdict
CAT = {0x1: "decode_ix", 0x2: "fetch(dec)", 0x3: "store(enc)", 0x4: "pda_find", 0x5: "pda_create",
       0x6: "cpi", 0x7: "rent", 0x8: "log", 0x9: "clock"}
P = json.load(open(sys.argv[1])); C = json.load(open(sys.argv[2]))
lab = {(r["suite"], r["test"], r["pid"], r["i"]): r for r in C["rows"]}
K = []
per = defaultdict(lambda: defaultdict(list))
for suite, tests in P.items():
    for test, invs in tests.items():
        cnt = defaultdict(int)
        for inv in invs:
            i = cnt[inv["pid"]]; cnt[inv["pid"]] += 1
            pr = inv["probes"]
            if len(pr) < 2 or pr[0][1] != 0xE0: continue
            r = lab.get((suite, test, inv["pid"], i))
            if not r: continue
            if pr[1][1] == 0xE2 and pr[1][2] == 0: K.append(pr[0][0] - pr[1][0])
    break
k = st.median(K) if K else 0
print("probe cost K (median E0->P0):", k, "n", len(K))
for suite, tests in P.items():
    for test, invs in tests.items():
        cnt = defaultdict(int)
        for inv in invs:
            i = cnt[inv["pid"]]; cnt[inv["pid"]] += 1
            pr = inv["probes"]
            r = lab.get((suite, test, inv["pid"], i))
            if not r or len(pr) < 2 or pr[0][1] != 0xE0: continue
            acc = defaultdict(float)
            acc["entry"] = inv["limit"] - pr[0][0]
            stack = []
            for a, b in zip(pr, pr[1:]):
                d = a[0] - b[0] - k
                top = stack[-1] if stack else "body"
                acc[top] += d
                if b[1] == 0xE2 and b[2] != 0:
                    cid = b[2] & 0xff
                    if b[2] & 0x100:
                        name = CAT.get(cid, hex(cid))
                        while stack and stack[-1] != name: stack.pop()
                        if stack: stack.pop()
                    else:
                        stack.append(CAT.get(cid, hex(cid)))
                if b[1] == 0xE1:
                    acc["exit"] = b[0] - (inv["limit"] - inv["cu"])
            acc["cpi"] -= inv["child_cu"]
            acc["probe_n"] = len(pr)
            key = (r["prog"], r["cls"])
            for kk, v in acc.items(): per[key][kk].append(v)
            per[key]["_go"].append(r["g"]); per[key]["_rust"].append(r["r"])
cols = ["entry", "decode_ix", "fetch(dec)", "store(enc)", "pda_find", "pda_create", "cpi", "rent", "log", "clock", "body", "exit"]
cls_order = sorted(per, key=lambda kk: -len(per[kk]["_go"]) * (st.median(per[kk]["_go"]) - st.median(per[kk]["_rust"])))
print(f"{'program':22} {'class':30} {'n':>4} {'Rust':>6} {'Go':>6} {'d':>6} | " + " ".join(f"{c[:9]:>9}" for c in cols))
out = []
for kk in cls_order:
    v = per[kk]; n = len(v["_go"])
    med = {c: (st.median(v[c] + [0] * (n - len(v[c]))) if v.get(c) else 0) for c in cols}
    rm, gm = st.median(v["_rust"]), st.median(v["_go"])
    out.append(dict(prog=kk[0], cls=kk[1], n=n, rust=rm, go=gm, **med))
    print(f"{kk[0][:22]:22} {kk[1][:30]:30} {n:4} {rm:6.0f} {gm:6.0f} {gm-rm:6.0f} | " + " ".join(f"{med[c]:9.0f}" for c in cols))
json.dump(out, open("/tmp/hm1-probe/conf/attrib.json", "w"), indent=1)
