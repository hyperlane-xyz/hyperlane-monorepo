"""Case-only cache refusal for the exact seven executed metadata verifiers."""
from pathlib import Path
import sys
from receipts import checked,need
VERIFIERS=frozenset({'zig/integration/native_case_inputs.py','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/tools/build_cpu.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/integration/native_rows_interop.py'})
def refuse_verifier_cache(repo,pins):
    repo=Path(repo)
    need(sys.pycache_prefix is None and sys.dont_write_bytecode is True,'case verifier requires default cache prefix and -B')
    paths=[checked(row)for row in pins]
    need(len(paths)==len(VERIFIERS)and {str(p.relative_to(repo))for p in paths}==VERIFIERS,'exact case verifier Source closure required')
    parents={p.parent for p in paths}
    need(parents=={repo/'zig'/name for name in ('integration','bench','tools')},'exact case verifier directories required')
    for directory in parents:
        cache=directory/'__pycache__'
        need(not cache.exists()and not cache.is_symlink(),'case verifier refuses unexpected bytecode cache')
    for path in paths:
        legacy=path.with_suffix('.pyc')
        need(not legacy.exists()and not legacy.is_symlink(),'case verifier refuses legacy bytecode')
