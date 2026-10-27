#!/usr/bin/env python3
"""Parse conformance suite logs with scratch Log64+CU probes.
Usage: probes.py <logdir> <out.json>
Per test: invocations in invoke order (only those with 'consumed'), each with
probes = [[remaining, w0..w4], ...] in order."""
import json, os, re, sys
INV = re.compile(r"Program (\w+) invoke \[(\d+)\]")
CONS = re.compile(r"Program (\w+) consumed (\d+) of (\d+) compute units")
END = re.compile(r"Program (\w+) (success|failed)")
REM = re.compile(r"Program consumption: (\d+) units remaining")
L64 = re.compile(r"Program log: (0x[0-9a-f]+), (0x[0-9a-f]+), (0x[0-9a-f]+), (0x[0-9a-f]+), (0x[0-9a-f]+)$")
TEST = re.compile(r'"event": "started", "name": "([^"]+)"')
def parse(path):
    tests = {}; cur = None; stack = []; pend = None
    for line in open(path, errors="replace"):
        m = TEST.search(line)
        if m:
            cur = []; tests[m.group(1)] = cur; stack = []; continue
        if cur is None or "Program " not in line: continue
        m = INV.search(line)
        if m:
            d = int(m.group(2))
            while stack and len(stack) >= d: stack.pop()
            inv = {"pid": m.group(1), "depth": d, "cu": None, "limit": None, "probes": [], "ok": None, "child_cu": 0, "parent": stack[-1] if stack else None}
            cur.append(inv); stack.append(inv); continue
        m = REM.search(line)
        if m:
            pend = int(m.group(1)); continue
        m = L64.search(line)
        if m and stack:
            stack[-1]["probes"].append([pend] + [int(x, 16) for x in m.groups()]); pend = None; continue
        m = CONS.search(line)
        if m and stack and stack[-1]["pid"] == m.group(1):
            stack[-1]["cu"] = int(m.group(2)); stack[-1]["limit"] = int(m.group(3))
            if stack[-1]["parent"] is not None: stack[-1]["parent"]["child_cu"] += int(m.group(2))
            continue
        m = END.search(line)
        if m and stack and stack[-1]["pid"] == m.group(1):
            stack[-1]["ok"] = m.group(2) == "success"; stack.pop(); continue
    for t in tests:
        tests[t] = [i for i in tests[t] if i["cu"] is not None]
        for i in tests[t]: i.pop("parent", None)
    return tests
out = {}
for f in sorted(os.listdir(sys.argv[1])):
    if f.endswith(".log"):
        out[f[:-4].replace("__", "/")] = parse(os.path.join(sys.argv[1], f))
json.dump(out, open(sys.argv[2], "w"))
print(sum(len(v) for s in out.values() for v in s.values()), "invocations")
