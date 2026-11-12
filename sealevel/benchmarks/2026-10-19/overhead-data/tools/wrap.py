#!/usr/bin/env python3
"""wrap.py file func id : SCRATCH probe wrapper around a top-level Go func."""
import re, sys
path, name, pid = sys.argv[1], sys.argv[2], int(sys.argv[3], 0)
s = open(path).read()
m = re.search(r"^func " + re.escape(name) + r"(\[[^\]]*(?:\[[^\]]*\][^\]]*)*\])?\((.*?)\)\s*(.*?)\s*\{\s*$", s, re.M)
if not m: sys.exit(f"no func {name} in {path}")
tparams, params, results = m.group(1) or "", m.group(2), m.group(3).strip()
inner = name[0].lower() + name[1:] + "__probe"
s = s[:m.start()] + s[m.start():].replace("func " + name, "func " + inner, 1)
# arg names
args = []
for part in [p.strip() for p in params.split(",") if p.strip()]:
    toks = part.split()
    args.append(toks[0])
targs = ""
if tparams:
    names = [t.strip().split()[0] for t in re.split(r",(?![^\[]*\])", tparams[1:-1])]
    targs = "[" + ", ".join(names) + "]"
res = results
if res.startswith("("): res = res[1:-1]
nres = 0 if not res else len([r for r in re.split(r",(?![^\[]*\])", res) if r.strip()])
rv = ", ".join(f"r{i}" for i in range(nres))
call = f"{inner}{targs}({', '.join(args)})"
body = f"\tsolana.ProbeCU({pid:#x})\n"
if nres:
    body += f"\t{rv} := {call}\n\tsolana.ProbeCU({pid|0x100:#x})\n\treturn {rv}\n"
else:
    body += f"\t{call}\n\tsolana.ProbeCU({pid|0x100:#x})\n"
s += f"\n// SCRATCH CU PROBE\nfunc {name}{tparams}({params}) {results} {{\n{body}}}\n"
if '"gosvm/solana"' not in s:
    s = re.sub(r"^import \(", 'import (\n\t"gosvm/solana"', s, count=1, flags=re.M) if re.search(r"^import \(", s, re.M) else re.sub(r"^(package \w+)$", r'\1\n\nimport "gosvm/solana"', s, count=1, flags=re.M)
open(path, "w").write(s)
print("wrapped", name, "in", path)
