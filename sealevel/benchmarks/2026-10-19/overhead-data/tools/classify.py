#!/usr/bin/env python3
"""Join probe labels onto Rust/Go conformance runs and break CU down by instruction class.
Usage: classify.py <probes.json> <rust.json> <go.json> [--metric self_cu|cu] [--json out]"""
import argparse, json, statistics as st
from collections import defaultdict

def le(b): return int.from_bytes(bytes(b), "little")
DISC = {
    le([105,97,97,88,63,124,106,18]): "ism:Type",
    le([243,53,214,0,208,18,231,67]): "ism:Verify",
    le([200,65,157,12,89,255,131,216]): "ism:VerifyAccountMetas",
    le([49,24,22,218,134,132,63,155]): "ism:VerifyMetadataSpec",
    le([45,18,245,87,234,46,246,15]): "recipient:InterchainSecurityModule",
    le([190,214,218,129,67,97,4,76]): "recipient:IsmAccountMetas",
    le([33,210,5,66,196,212,239,142]): "recipient:Handle",
    le([194,141,30,82,241,41,169,52]): "recipient:HandleAccountMetas",
    le([150,230,176,162,236,96,183,171]): "GetProgramVersion",
}
ENUMS = {
    "mailbox": "Init InboxProcess InboxSetDefaultIsm InboxGetRecipientIsm OutboxDispatch OutboxGetCount OutboxGetLatestCheckpoint OutboxGetRoot GetOwner TransferOwnership ClaimProtocolFees SetProtocolFeeConfig",
    "igp": "Init InitIgp InitOverheadIgp PayForGas QuoteGasPayment TransferIgpOwnership TransferOverheadIgpOwnership SetIgpBeneficiary SetDestinationGasOverheads SetGasOracleConfigs Claim SetIgpQuoteConfig SetIgpQuoteSigner SetIgpMinIssuedAt SubmitIgpQuote CloseIgpTransientQuote CloseIgpStandingQuote GetIgpQuoteAccountMetas",
    "fee": "InitFee QuoteFee SetRemoteFeeRoute RemoveRemoteFeeRoute UpdateFeeParams SetBeneficiary TransferOwnership SetQuoteSigner SetMinIssuedAt SetWildcardQuoteSigners SubmitQuote CloseTransientQuote PruneExpiredQuotes GetQuoteAccountMetas GetSubmitQuoteAccountMetas",
    "multisig": "Initialize SetValidatorsAndThreshold GetOwner TransferOwnership",
    "validator_announce": "Init Announce",
    "test_ism": "Init SetAccept",
    "token": "Init TransferRemote EnrollRemoteRouter EnrollRemoteRouters SetDestinationGasConfigs SetInterchainSecurityModule SetInterchainGasPaymaster TransferOwnership TransferRemoteWithMemo SetFeeConfig",
    "composite": "Initialize UpdateConfig GetOwner TransferOwnership SetDomainIsm RemoveDomainIsm Pause Unpause",
    "cc": "SetCrossCollateralRouters TransferRemoteTo HandleLocal HandleLocalAccountMetas",
}
ENUMS = {k: v.split() for k, v in ENUMS.items()}
def family(prog):
    if prog.startswith("token"): return "token"
    if prog.startswith("multisig"): return "multisig"
    if prog.startswith("composite"): return "composite"
    return prog
def name_of(e, i): return e[i] if i < len(e) else f"tag{i}"
def label(prog, w0, w1, n):
    fam = family(prog)
    if n >= 8 and w0 in DISC: return DISC[w0]
    if n >= 9 and w0 == 0x0101010101010101:
        return "ix:" + name_of(ENUMS["composite" if fam == "composite" else "token"], w1 & 0xff)
    if n >= 9 and w0 == 0x0202020202020202:
        return "cc:" + name_of(ENUMS["cc"], w1 & 0xff)
    if n == 0: return "empty"
    if fam in ENUMS and fam not in ("token", "composite"):
        return name_of(ENUMS[fam], w0 & 0xff)
    return f"raw:{w0 & 0xff:#x}"

def by_prog(run_tests):
    g = defaultdict(list)
    for inv in run_tests: g[inv.get("program_id") or inv["pid"]].append(inv)
    return g

ap = argparse.ArgumentParser()
ap.add_argument("probes"); ap.add_argument("rust"); ap.add_argument("go")
ap.add_argument("--metric", default="self_cu"); ap.add_argument("--json")
a = ap.parse_args()
P = json.load(open(a.probes)); R = json.load(open(a.rust)); G = json.load(open(a.go))
names = {}
rows = []  # (prog, cls, rust, go, entry_overhead, nacc, suite, test, i)
mism = 0
for suite, s in G["suites"].items():
    for test, t in s["tests"].items():
        rt = R["suites"][suite]["tests"].get(test); pt = P.get(suite, {}).get(test)
        if not rt or pt is None: continue
        gg, rr, pp = by_prog(t["invocations"]), by_prog(rt["invocations"]), by_prog(pt)
        for pid, gl in gg.items():
            names[pid] = gl[0]["program"]
            rl, pl = rr.get(pid, []), pp.get(pid, [])
            if len(rl) != len(gl): mism += 1; continue
            for i, (gi, ri) in enumerate(zip(gl, rl)):
                pi = pl[i] if len(pl) == len(gl) else None
                cls, eo, nacc = "?", None, None
                if pi and pi["probes"] and pi["probes"][0][1] == 0xE0:
                    pr = pi["probes"][0]
                    cls = label(gi["program"], pr[2], pr[3], pr[4]); nacc = pr[5]
                    eo = pi["limit"] - pr[0]
                elif pi is not None and not pi["probes"]:
                    cls = "(not Go)"
                rows.append(dict(prog=gi["program"], pid=pid, cls=cls, r=ri[a.metric], g=gi[a.metric],
                                 eo=eo, nacc=nacc, suite=suite, test=test, i=i))
print("count-mismatch groups skipped:", mism, " rows:", len(rows))
allr = [x["g"] / x["r"] for x in rows if x["r"] > 0]
print(f"overall median ratio {st.median(allr):.4f} pairs {len(allr)}; total go/rust {sum(x['g'] for x in rows)/sum(x['r'] for x in rows):.4f}")
cls = defaultdict(list)
for x in rows: cls[(x["prog"], x["cls"])].append(x)
above = sum(1 for r in allr if r > 1.0)
out = []
for k, xs in cls.items():
    rs = [x["g"] / x["r"] for x in xs if x["r"] > 0]
    d = [x["g"] - x["r"] for x in xs]
    rest = [x["g"] / x["r"] for kk, ys in cls.items() if kk != k for x in ys if x["r"] > 0]
    out.append(dict(prog=k[0], cls=k[1], n=len(xs), rust_med=st.median(x["r"] for x in xs), go_med=st.median(x["g"] for x in xs),
                    delta_med=st.median(d), ratio_med=st.median(rs) if rs else None, n_above=sum(1 for r in rs if r > 1.0),
                    share_above=sum(1 for r in rs if r > 1.0) / above, med_without=st.median(rest),
                    rust_sum=sum(x["r"] for x in xs), go_sum=sum(x["g"] for x in xs),
                    eo_med=st.median([x["eo"] for x in xs if x["eo"] is not None]) if any(x["eo"] is not None for x in xs) else None,
                    nacc_med=st.median([x["nacc"] for x in xs if x["nacc"] is not None]) if any(x["nacc"] is not None for x in xs) else None))
out.sort(key=lambda o: -o["n_above"])
print(f"{'program':24} {'class':38} {'n':>4} {'>1':>4} {'share':>6} {'R med':>7} {'G med':>7} {'dMed':>6} {'ratio':>6} {'medW/o':>6} {'G/R sum':>7} {'entry':>6} {'acc':>4}")
for o in out:
    rm = f"{o['ratio_med']:.3f}" if o['ratio_med'] else "-"
    eo = f"{o['eo_med']:.0f}" if o['eo_med'] is not None else "-"
    na = f"{o['nacc_med']:.0f}" if o['nacc_med'] is not None else "-"
    print(f"{o['prog'][:24]:24} {o['cls'][:38]:38} {o['n']:4} {o['n_above']:4} {o['share_above']*100:5.1f}% {o['rust_med']:7.0f} {o['go_med']:7.0f} {o['delta_med']:6.0f} {rm:>6} {o['med_without']:.3f} {o['go_sum']/max(o['rust_sum'],1):7.3f} {eo:>6} {na:>4}")
if a.json: json.dump(dict(rows=rows, classes=out), open(a.json, "w"))
