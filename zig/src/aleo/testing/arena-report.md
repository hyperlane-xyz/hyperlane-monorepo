# Arena ownership variant check

Original: `agents/scraper/aleo.zig` Factory copied `arena` into the return value
before allocating owned worker paths. If allocation adds another arena block,
the returned owner misses that block; further allocation using copied state can
also overwrite later allocations. Allocator-backed factory test reproduced a leak.

Four confirmed sites, medium severity/high confidence, all in newly added Aleo
code and fixed before integration:

- Factory worker path duplication: moved both allocations before owner copy.
- Scraper Batch `toOwnedSlice`: finalized list before owner copy.
- Event Indexer `toOwnedSlice`: same correction.
- Announcement program name duplication: allocated before owner copy.

Search covered all `zig/src`, then inspected allocator aliases and returned arena
owners in storage/cloud/Tron/Starknet/endpoint modules. Original literal return
pattern identified the factory; abstract allocation-after-copy pattern found all
four sites. A broad450-character multiline search also crossed into the next
function in EVM announcement/Cosmos locations code (two false positives). Those
owners performed their allocations before copying and required no changes.
Other returned fields in storage/identity parsers only read decoded data and do
not allocate after the copy.

`python3 zig/src/aleo/testing/audit_arenas.py` is a CI-ready narrow regression guard;
it scans one return initializer and fails on direct allocator operations after
an arena field copy. It does not prove arbitrary helper calls allocation-free.
Focused allocation-backed factory test verifies the actual ownership fix.
