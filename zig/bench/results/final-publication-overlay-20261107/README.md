# Evidence publication overlay

Eleven historical public JSON payloads are preserved here as lossless,
deterministic gzip. [hashes.json](hashes.json) binds each original path, raw
length and hash to its gzip. SHA values use two ordered32-character chunks.
Run `python3 -I -B verify.py` to check every gzip and decoded original without
restoring files or importing a fixture.

| Payload | Historical source |
| --- | --- |
| [01](01/canonical.json.gz) | d51-v12 relayer process result |
| [02](02/canonical.json.gz) | v3 relayer process result |
| [03](03/canonical.json.gz) | v4 relayer process result |
| [04](04/canonical.json.gz) | v5 relayer process result |
| [05](05/canonical.json.gz) | Safe fixture rollup manifest |
| [06](06/canonical.json.gz) | Native row reader manifest |
| [07](07/canonical.json.gz) | Relayer command provenance |
| [08](08/canonical.json.gz) | Starknet chain-ID discovery manifest |
| [09](09/canonical.json.gz) | Legacy WSS subscription diagnostic |
| [10](10/canonical.json.gz) | WSS gas bootstrap diagnostic manifest |
| [11](11/canonical.json.gz) | WSS gas bootstrap diagnostic verification |

Results retain their original success, failure and partial-proof scope. Packaging
adds no test, native-family, benchmark or performance acceptance. Older binaries,
source commits and failed attempts remain historical evidence.

[publication-overlay.json](publication-overlay.json) lists53 private payloads
omitted from publication: runtime signer configs, actual task PG tokens, raw
signed RPC request bodies and container environment/argv. Known public fixture
signer scalars are omitted too. Every original stays unchanged locally. Public
Hyperlane message bytes remain evidence; they are distinct from signed RPC
requests. [privacy-audit.json](privacy-audit.json) records field-level checks
without secret values. This does not declare that older archives contain no keys.

Sealed older manifests remain unchanged and may reference private bodies. Their
original completeness descriptors do not imply that every body is published.
The rollup's environment field contains only an explicit reviewed14-field build
tool/library/parameter-path map, not role/container credentials.

Ten public raw mirrors were ignored after exact gzip roundtrips. Command metadata
is published separately as the adjacent `relayer-final-commands.json.gz` and
`validator-final-commands.json.gz` files. Their two raw paths were removed only
from the index; local bytes and inodes remain unchanged. No live reader required
a source change. See [command metadata](../command-metadata.md).

For restoration, choose a NEW private destination, concatenate the two SHA chunks,
verify the compressed hash, decompress the selected payload, then verify its raw
length/hash. No existing local raw path needs rewriting. Normal secret checks
and commit hooks remain mandatory; no bypass is part of this packaging.
