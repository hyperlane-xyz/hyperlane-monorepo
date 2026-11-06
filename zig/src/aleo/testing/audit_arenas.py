#!/usr/bin/env python3
"""Flag a copied arena followed by allocation in the same return initializer."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[4]
# Constrain the search to one semicolon-free return initializer; the original
# broad multiline window crossed function boundaries and produced false matches.
initializer = re.compile(r"return\s+\.\{(?P<body>[^;]+?)\};", re.S)
copy = re.compile(r"\.arena\s*=\s*[A-Za-z_][A-Za-z_0-9]*\s*,")
allocation = re.compile(r"\btry\s+[A-Za-z_][A-Za-z_0-9]*\.(?:dupe|alloc|create|realloc|toOwnedSlice)\s*\(")
failures = []
for path in (root / "zig/src").rglob("*.zig"):
    if "target" in path.parts:
        continue
    text = path.read_text()
    for found in initializer.finditer(text):
        owner = copy.search(found["body"])
        if owner and allocation.search(found["body"][owner.end():]):
            failures.append(f"{path.relative_to(root)}:{text.count(chr(10), 0, found.start()) + 1}: allocation after copied arena")
if failures:
    print("\n".join(failures))
    sys.exit(1)
print("Arena return ownership pattern: clear")
