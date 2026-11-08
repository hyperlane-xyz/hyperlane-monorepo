"""Actual hydrated DTO adapter; original SDK receipts.py stays unchanged."""
from pathlib import Path
import platform
import re
from receipts import checked,load,need,source_loader,storage_interop as _storage_interop
from verifier_cache import refuse_verifier_cache

def source_cohort(context_pin, loader_pin, repo, execution_commit, runtime_commit, verifier_pins):
    """Read the real Linux producer context; reuse its actual Source verifier.

    Called only at authorized Linux preflight. Importing this receipts module
    does not load the producer module or run Git. No helper execution dependency
    is manufactured for the independent TS Aleo case.
    """
    value = load(context_pin)
    need(platform.system()=='Linux'and platform.machine()=='x86_64','actual amd64 Linux consumer required')
    need(value.get('phase') == 'HYDRATED_NOT_EXECUTION_APPROVAL' and value.get('execution_source_commit') == execution_commit and value.get('runtime_source_commit') == runtime_commit, 'actual Linux hydrated cohort required')
    need(re.fullmatch('[0-9a-f]{40}', execution_commit) and re.fullmatch('[0-9a-f]{40}', runtime_commit), 'actual commit IDs required')
    # Explicit finite validation-code closure, not a caller-supplied alternate
    # CPU implementation or a cached consumer's CPU flags.
    required={'zig/integration/native_case_inputs.py','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/tools/build_cpu.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/integration/native_rows_interop.py'}
    need({str(Path(row['path']).relative_to(repo))for row in verifier_pins}==required,'exact executed verifier closure required')
    for row in verifier_pins:checked(row)
    names = {'relayer':'relayer', 'validator':'validator', 'scraper':'scraper', 'worker':'worker', 'aleo-crypto':'aleoCrypto', 'aleo-vm':'aleoVm', 'starknet':'starknetCrypto', 'regex':'regex', 'url':'url'}
    need(set(value['runtime_artifacts']) == set(names)|{'init-db'}, 'exact hydrated runtime9 plus admitted init-db required')
    need(value['runtime_artifacts']['init-db']==value['tools']['init-db'], 'hydrated init-db differs from tool authority')
    products = {names[key]: value['runtime_artifacts'][key] for key in names}
    for product in products.values(): checked(product)
    closure = load(value['compiled_input_closure'])
    need(closure.get('runtime_source_commit') == runtime_commit and closure.get('tools_source_commit') == runtime_commit and closure.get('execution_source_commit') == execution_commit and closure.get('source_unchanged') is True and closure.get('native_case_acceptance') is False, 'actual compiled/execution closure differs')
    refuse_verifier_cache(repo,verifier_pins)
    module=source_loader(loader_pin,repo)
    dispatch=module.load_module('aleo_actual_case_dispatch','zig/bench/native_case_ci.py')
    request=dispatch.read_request(checked(value['request']))
    producer=module.producer_receipt(Path(value['request']['path']),request,value['producer_receipt'],execution_commit)
    cpu=module.load_module('aleo_current_consumer_cpu','zig/tools/build_cpu.py')
    flags=cpu.cpu_flags(Path('/proc/cpuinfo').read_text(),intersection=True)
    conservative=cpu.cpu_flags(module.helper_cpu_input(producer).read_text())
    need(set(conservative)<=set(flags),'actual conservative tool CPU not covered')
    sdk_directory=Path(producer['artifacts']['sdk']['directory'])
    sdk_manifest=module.artifact(sdk_directory/'manifest.json')
    _,records,_=module.sdk_inputs(sdk_directory,sdk_manifest,value['mode'],runtime_commit,'amd64',flags)
    for name,(_,row) in records.items():
        selected=products[module.SDK_NAMES[name] if module.SDK_NAMES[name] in products else {'aleo-crypto':'aleoCrypto','aleo-vm':'aleoVm','starknet':'starknetCrypto'}[module.SDK_NAMES[name]]]
        need(selected['bytes']==row['bytes']and selected['sha256']==row['sha256'],'copied runtime differs from actual CPU-qualified payload')
    tool_loader=module.load_module('aleo_actual_case_tools','zig/bench/native_case_tools.py')
    tools=tool_loader.load_manifest(checked(value['tool_manifest']),value['tool_manifest']['sha256'],runtime_commit,62)
    need(tools==value['tools'],'actual Source-built tools changed')
    for label,mode in [('writer_safe','ReleaseSafe'),('writer_fast','ReleaseFast')]:
        _,(_,writer)=module.writer_inputs(Path(producer['artifacts'][label]['directory']),runtime_commit,mode,'amd64',flags)
        selected=value['writers'][mode]
        checked(selected);need(selected['bytes']==writer['bytes']and selected['sha256']==writer['sha256'],'actual mode writer changed')
    evidence = []
    for family in ('runtime', 'tools'):
        need(module.cohort(Path(repo), runtime_commit, execution_commit, family, evidence) == closure['scopes'][family], 'compiled runtime/tool Source changed')
    checked(loader_pin); checked(context_pin)
    for row in verifier_pins:checked(row)
    refuse_verifier_cache(repo,verifier_pins)
    return {'runtime_products': products, 'compiled_input_closure': value['compiled_input_closure'], 'actual_waited_git_checks': evidence, 'actual_consumer_CPU_flags':flags,'runtime_source_commit': runtime_commit, 'execution_source_commit': execution_commit, 'native_case_acceptance': False, 'helper_execution_dependency': False}


def storage_interop(summary_pin,context_pin,loader_pin,repo,verifier_pins):
    refuse_verifier_cache(repo,verifier_pins)
    result=_storage_interop(summary_pin,context_pin,loader_pin,repo)
    refuse_verifier_cache(repo,verifier_pins)
    return result
