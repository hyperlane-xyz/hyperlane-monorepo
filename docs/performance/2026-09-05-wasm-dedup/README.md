# Preserve NCC WASM deduplication after chunk renaming

## Problem

NCC can swap `aleo_wasm.wasm` and `aleo_wasm1.wasm` when the module graph changes. After the lazy LiFi import change in #9483, the Rebalancer bundle emitted those names in the opposite order from an unchanged Keyfunder bundle. The payloads remained identical, but the Docker build's same-filename comparison retained both extra copies.

## Solution

After the existing same-name deduplication, compare remaining regular `*.wasm` files against the canonical Rebalancer WASM files. Replace byte-identical files with relative symlinks while retaining each service's original filename. Skip existing symlinks and missing globs. Abort packaging if removing a duplicate or creating its replacement link fails.

Cross-name matching applies only to WASM. JavaScript workers and native addons retain the existing rules because their paths can affect module resolution.

## Two-bundle performance evidence

Local Node 24.13.0 / NCC 0.38.4 bundles:

- Rebalancer: `d8e5fcdf0001b415c61b81c2dbb3688e8c304cc1` (#9483).
- Keyfunder: `c566d54e83cd122a5f4c34f3a44dd24a59bcfffa` (#9466), unchanged by this PR.

Running the actual Docker deduplication loop against these two bundles reduced retained regular-file bytes from **146,567,218 to 105,157,126**, saving **41,410,092 bytes (28.3%)**. Two additional relative symlinks replaced WASM copies of 20,704,991 and 20,705,101 bytes. Resolved payload hashes stayed identical; see `comparison.json`.

This is a two-bundle packaging fixture, with the other five service directories empty. It is not a measured full-image size, compressed layer size, runtime latency, or production improvement. Filename assignment depends on NCC's module graph; if all names already align, the fallback saves zero additional bytes. Existing same-name deduplication remains active.

## Seven-service integration evidence

An independent combined-stack build produced all seven service bundles: 30 build tasks passed, with 23 cache hits and all seven bundle tasks rebuilt. Applying the exact old/new Docker loops reduced retained regular-file bytes from **293,115,406 to 251,705,314**, saving **41,410,092 bytes (14.13%)** across the complete local service layout.

All **108 resolved files** retained identical full SHA-256 hashes and lengths, including JavaScript and native addons. All **44 existing symlink targets** stayed unchanged. The new loop was idempotent. The only new links were `relayer/aleo_wasm.wasm` and `relayer/aleo_wasm1.wasm`, each pointing to the opposite-named Rebalancer asset. All six other services retained the same regular-byte totals.

This differs from the two-bundle fixture above: the combined source graph gave Keyfunder matching canonical filenames, while Relayer had swapped suffixes. Savings depend on emitted filenames, not on a fixed affected service. See `integration-comparison.json` for service totals and exact source heads.

The measurement remains a local macOS/NCC layout comparison, excluding symlink metadata. It is not a Linux or compressed-image size comparison, native-addon ABI validation, WASM execution test, or deployment result. No service was started during the seven-service comparison.

### Reproduce the combined source inputs

In an isolated clone, fetch the five PR heads and merge their exact recorded commits into the common base, in this order:

```sh
git fetch origin pull/9466/head pull/9467/head pull/9473/head pull/9483/head pull/9486/head
git switch -c wasm-dedup-fixture 58e16ce875e3e312ab7344810bb159a5540f253b
git merge --no-ff --no-edit c566d54e83cd122a5f4c34f3a44dd24a59bcfffa
git merge --no-ff --no-edit a4c4943e9781f1722f65f9e3818ac1dc0968d332
git merge --no-ff --no-edit 4a7b1677d72c9853e2e362b3da576a0635ded555
git merge --no-ff --no-edit d8e5fcdf0001b415c61b81c2dbb3688e8c304cc1
git merge --no-ff --no-edit bcd635d46f2afe21191df90b8e6cf65b830a1439
```

Relayer and fee-quoting remain at the common base. The measured integration commit was `ac515c7cf027cf100916c7aa1876d6b4ffe29112`; equivalent merges should reproduce source tree `37aab57cc68cf320279c62fc1be876869c1b48ea` even if merge timestamps produce a different commit ID. This integration commit is only a local fixture identifier; the five inputs above are published PR commits.

After installing frozen dependencies, run Docker's seven-service build invocation with bounded build concurrency:

```sh
pnpm turbo run bundle --concurrency=2 \
  --filter=@hyperlane-xyz/rebalancer \
  --filter=@hyperlane-xyz/warp-monitor \
  --filter=@hyperlane-xyz/ccip-server \
  --filter=@hyperlane-xyz/keyfunder \
  --filter=@hyperlane-xyz/relayer \
  --filter=@hyperlane-xyz/fee-quoting \
  --filter=@hyperlane-xyz/scraper-proxy
```

Use all seven bundle directories as `inputs` in the comparison snippet below. Compare the Dockerfile from `d8e5fcdf` against packaging source `5cb6327949c9472c56d345c1afb3cc04cf821ecc`. Hash every resolved output file, compare existing symlink targets, and rerun the new loop to verify idempotence. Subsequent documentation-only commits do not alter that shell input.

## Validation

`python3 -m unittest discover -s scripts/tests -p test_ncc_wasm_dedup.py -v`

Five tests execute the production shell loop extracted from `typescript/Dockerfile`, using the same `sh -c` error mode. They cover missing globs, different payloads, same-name deduplication, idempotence, renamed twins, exclusion of cross-name JavaScript/native files, and a failed `ln` that must abort packaging.

The actual Keyfunder bundle also completed an offline fake-chain job in the parent, deduplicated, and relocated symlink-preserving layouts. The configured chain was skipped for funding; construction still exercised the provider, test wallet, and IGP. All three jobs exited 0 with zero network attempts. A preload blocked Node sockets and fetch; no signing or transactions occurred. Reading both WASM symlinks reproduced the original SHA-256 hashes.

No local full Docker build or deployment was performed. The source commit `5cb6327949c9472c56d345c1afb3cc04cf821ecc` subsequently passed the [Node Services image build-and-push CI job](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/33942893822). That CI result does not measure before/after compressed image size or prove deployment. Local artifacts contain macOS native addons; Linux native runtime behavior remains a deployment validation boundary. Docker already preserves the existing relative symlinks when copying the services directory.

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
