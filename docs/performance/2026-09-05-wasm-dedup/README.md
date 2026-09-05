# Preserve NCC WASM deduplication after chunk renaming

## Problem

NCC can swap `aleo_wasm.wasm` and `aleo_wasm1.wasm` when the module graph changes. After the lazy LiFi import change in #9483, the Rebalancer bundle emitted those names in the opposite order from an unchanged Keyfunder bundle. The payloads remained identical, but the Docker build's same-filename comparison retained both extra copies.

## Solution

After the existing same-name deduplication, compare remaining regular `*.wasm` files against the canonical Rebalancer WASM files. Replace byte-identical files with relative symlinks while retaining each service's original filename. Skip existing symlinks and missing globs. Abort packaging if removing a duplicate or creating its replacement link fails.

Cross-name matching applies only to WASM. JavaScript workers and native addons retain the existing rules because their paths can affect module resolution.

## Performance evidence

Local Node 24.13.0 / NCC 0.38.4 bundles:

- Rebalancer: `d8e5fcdf0001b415c61b81c2dbb3688e8c304cc1` (#9483).
- Keyfunder: `c566d54e83cd122a5f4c34f3a44dd24a59bcfffa` (#9466), unchanged by this PR.

Running the actual Docker deduplication loop against these two bundles reduced retained regular-file bytes from **146,567,218 to 105,157,126**, saving **41,410,092 bytes (28.3%)**. Two additional relative symlinks replaced WASM copies of 20,704,991 and 20,705,101 bytes. Resolved payload hashes stayed identical; see `comparison.json`.

This is a two-bundle packaging fixture, with the other five service directories empty. It is not a measured full-image size, compressed layer size, runtime latency, or production improvement. Filename assignment depends on NCC's module graph; if all names already align, the fallback saves zero additional bytes. Existing same-name deduplication remains active.

## Validation

`python3 -m unittest discover -s scripts/tests -p test_ncc_wasm_dedup.py -v`

Five tests execute the production shell loop extracted from `typescript/Dockerfile`, using the same `sh -c` error mode. They cover missing globs, different payloads, same-name deduplication, idempotence, renamed twins, exclusion of cross-name JavaScript/native files, and a failed `ln` that must abort packaging.

The actual Keyfunder bundle also completed an offline fake-chain job in the parent, deduplicated, and relocated symlink-preserving layouts. The configured chain was skipped for funding; construction still exercised the provider, test wallet, and IGP. All three jobs exited 0 with zero network attempts. A preload blocked Node sockets and fetch; no signing or transactions occurred. Reading both WASM symlinks reproduced the original SHA-256 hashes.

No full Docker build or deployment was performed. Local artifacts contain macOS native addons; Linux native packaging and the complete seven-service image remain CI/deployment validation boundaries. Docker already preserves the existing relative symlinks when copying the services directory.

## Reproduce the byte comparison

Build both input service bundles with their ordinary `pnpm ... build` / `pnpm ... bundle` commands at the revisions above. Save the parent Dockerfile with `git show d8e5fcdf:typescript/Dockerfile > /tmp/parent.Dockerfile`. From the repository root, use the same helper as the tests:

```python
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, 'scripts/tests')
from test_ncc_wasm_dedup import SERVICES, deduplicate

inputs = {
    'rebalancer': Path('/path/to/rebalancer/bundle'),
    'keyfunder': Path('/path/to/keyfunder/bundle'),
}
for dockerfile in [Path('/tmp/parent.Dockerfile'), Path('typescript/Dockerfile')]:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for service in SERVICES:
            if service in inputs:
                shutil.copytree(inputs[service], root / service, symlinks=True)
            else:
                (root / service).mkdir()
        deduplicate(root, dockerfile)
        retained = sum(p.stat().st_size for p in root.rglob('*')
                       if p.is_file() and not p.is_symlink())
        print(dockerfile, retained)
```
