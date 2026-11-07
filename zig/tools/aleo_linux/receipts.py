"""Aleo Linux receipt boundaries. Importing performs no IO or execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat

GIB = 1024**3
PRODUCTS = {'relayer', 'validator', 'scraper', 'worker', 'aleoCrypto', 'aleoVm', 'starknetCrypto', 'regex', 'url'}


def need(value, message):
    if not value:
        raise ValueError(message)


def unique(pairs):
    out = {}
    for key, value in pairs:
        need(key not in out, 'duplicate JSON key')
        out[key] = value
    return out


def decode(raw, limit=8*1024**2):
    need(isinstance(raw, bytes) and len(raw) <= limit, 'bounded JSON bytes required')
    return json.loads(raw, object_pairs_hook=unique)


def checked(pin):
    need(isinstance(pin, dict) and set(pin) == {'path', 'bytes', 'sha256'}, 'exact file pin required')
    path = Path(pin['path'])
    need(path.is_absolute() and '..' not in path.parts and path.resolve(strict=True) == path, 'canonical pin path required')
    need(type(pin['bytes']) is int and 0 <= pin['bytes'] <= GIB and re.fullmatch('[0-9a-f]{64}', pin['sha256']), 'bounded pin required')
    # No lexical symlink aliases, including intermediate components.
    for item in [path, *path.parents]:
        need(not item.is_symlink(), 'symlink input forbidden')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size == pin['bytes'], 'pin file type/size changed')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        after = os.fstat(fd)
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'input changed while hashing')
        lexical = path.stat(follow_symlinks=False)
        need((lexical.st_dev, lexical.st_ino) == (before.st_dev, before.st_ino) and digest == pin['sha256'], 'input replaced or hash changed')
    finally:
        os.close(fd)
    return path


def load(pin, limit=8*1024**2):
    need(type(limit)is int and 0<limit<=32*1024**2,'bounded metadata limit required')
    path = checked(pin)
    value = decode(path.read_bytes(),limit)
    checked(pin)
    return value


def files(rows, label):
    need(isinstance(rows, list) and 0 < len(rows) <= 100_000, label + ' nonempty bounded closure required')
    need(len({row['path'] for row in rows}) == len(rows), label + ' duplicate path')
    for row in rows:
        checked(row)
    return rows


def actual_checks(rows, names):
    need(isinstance(rows, list) and {row.get('name') for row in rows} == names and len(rows) == len(names), 'exact actual check set required')
    for row in rows:
        need(row.get('actual_parent_wait') is True and type(row.get('exit_code')) is int and row['exit_code'] == 0, 'actual successful parent wait required')
        checked(row['stdout']); checked(row['stderr'])


def source_copies(rows, staged):
    need(isinstance(rows,list)and len(rows)==len(staged),'every staged SDK Source needs an actual origin')
    need({row['staged']['path']for row in rows}=={row['path']for row in staged},'staged SDK Source coverage differs')
    for row in rows:
        need(set(row)=={'origin','staged'}and row['staged']in staged,'exact Source copy binding required')
        checked(row['origin']);checked(row['staged'])
        need((row['origin']['bytes'],row['origin']['sha256'])==(row['staged']['bytes'],row['staged']['sha256']),'staged SDK Source differs from actual checked Source')


def sdk_receipt(pin, node_pin, sdk_entry, execution_commit, owner_pin):
    value = load(pin,32*1024**2)
    need(value.get('kind') == 'aleo-linux-js-sdk-build-v1' and value.get('schema') == 1 and value.get('platform') == 'linux-x86_64', 'actual Linux SDK receipt required')
    need(value.get('source_commit') == execution_commit and value.get('node') == node_pin and value.get('network_denied_for_import') is True, 'SDK cohort/Node/import sandbox differs')
    need(value.get('passed') is True and value.get('source_unchanged') is True,'actual SDK compile/import checks required')
    checked(node_pin)
    for key in ('source_files', 'outputs', 'dependency_payloads'):
        rows = files(value.get(key), 'SDK ' + key)
        count_key='dependency_payload_count'if key=='dependency_payloads'else key+'_count'
        bytes_key='dependency_payload_bytes'if key=='dependency_payloads'else key+'_bytes'
        need(value.get(count_key) == len(rows) and value.get(bytes_key) == sum(row['bytes'] for row in rows), 'SDK closure count/bytes differs')
    need(sdk_entry in value['outputs'], 'SDK actual import entry missing')
    source_copies(value.get('source_origins'),value['source_files'])
    from worker_catalog import catalog
    worker=value['worker_policy'];rows=worker['allowed_worker_files']
    need(all(row in value['dependency_payloads']for row in rows),'SDK Worker target outside actual dependency payload closure')
    need(catalog([row for row in rows if Path(row['path']).name=='node-polyfill.js'],[row for row in rows if Path(row['path']).name=='worker.js'])==worker,'actual SDK Worker catalog differs')
    actual_checks(value.get('checks'), {'utils_compile', 'provider_compile', 'aleo_compile', 'driver_typecheck', 'isolated_import'})
    from sdk_provision import service_receipt
    service_receipt(pin,owner_pin,'build')
    need(value.get('SDK_proof_or_node_credit') is False, 'build/import is not a proof')
    return value


def source_loader(pin, repo):
    path=checked(pin)
    need(path==Path(repo)/'zig/integration/native_case_inputs.py','actual qualified Source verifier required')
    spec=importlib.util.spec_from_file_location('aleo_linux_source_inputs',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def storage_interop(summary_pin, context_pin, loader_pin, repo):
    """Reuse ACTUAL Linux safe/fast summary and consumer verifier, no Mac aliases."""
    value=load(summary_pin);context=load(context_pin)
    need(value.get('accepted_component_source_and_actual_Zig_storage_interop') is True and value.get('family_chain_SDK_finality_delivery_elapsed600_acceptance') is False,'actual Linux storage component required')
    need(set(value['modes'])=={'safe','fast'},'both actual storage modes required')
    raw_results={label:value['modes'][label]['raw_result']for label in ('safe','fast')}
    module=source_loader(loader_pin,repo)
    # Recomputes product/tool/source bindings, every actual parent wait and
    # old-first command timestamp, plus all current stopped DB byte hashes.
    need(module.interop_summary(context,raw_results,Path(repo))==value,'actual Linux interop summary differs')
    for raw_pin in raw_results.values():
        raw=load(raw_pin)
        need(raw.get('aleo_process_row_null_target_with_prepared_resolved_target') is True and raw.get('wrong_resolved_recipient_family_control') is True,'actual Aleo row/Prepared authority evidence required')
    checked(loader_pin);checked(summary_pin);checked(context_pin)
    return value


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
    need(set(value['runtime_artifacts']) == set(names), 'exact runtime9 required')
    products = {names[key]: row for key, row in value['runtime_artifacts'].items()}
    for product in products.values(): checked(product)
    closure = load(value['compiled_input_closure'])
    need(closure.get('runtime_source_commit') == runtime_commit and closure.get('tools_source_commit') == runtime_commit and closure.get('execution_source_commit') == execution_commit and closure.get('source_unchanged') is True and closure.get('native_case_acceptance') is False, 'actual compiled/execution closure differs')
    module=source_loader(loader_pin,repo)
    request=load(value['request'])
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
    return {'runtime_products': products, 'compiled_input_closure': value['compiled_input_closure'], 'actual_waited_git_checks': evidence, 'actual_consumer_CPU_flags':flags,'runtime_source_commit': runtime_commit, 'execution_source_commit': execution_commit, 'native_case_acceptance': False, 'helper_execution_dependency': False}


def clock_bridge(owner_deadline, before, after, node):
    need(all(type(x) is int and x > 0 for x in (owner_deadline, before, after, node)) and before <= after < owner_deadline and owner_deadline-before <= 10800*10**9, 'original unexpired Python3h deadline required')
    return {'deadline_python_ns': owner_deadline, 'deadline_monotonic_ns': str(node + owner_deadline-after), 'uncertainty_ns': after-before}
