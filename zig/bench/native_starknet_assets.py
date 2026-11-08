"""Source-pinned Starknet data/CLI policy. No imports execute a CLI or use network."""
import gzip
import hashlib
import io
from pathlib import Path
import re
import stat
import struct
import tarfile
import zipfile

GIB = 1024 ** 3
SOURCE_IMAGE = 'shardlabs/starknet-devnet-rs:0.4.2'
IMAGE_DIGESTS = {
    'amd64': 'ccf8b80807c6cc5e6497681cfdeabedc' 'adcce2c69935c8bf514540726b8955d5',
    'arm64': '5a6e3b640f470fed6abb16dc1816bcba' '943a3940e4be3475d7182cef7e589935',
}
CLI_RELEASE = {
    'amd64': ('x86_64-unknown-linux-gnu', 14276764),
    'arm64': ('aarch64-unknown-linux-gnu', 13389575),
}
# Official TLS assets actually observed2026-11-07; publisher digest fields null.
CLI_OBSERVED = {'amd64': {'bytes': 42077936, 'sha256': '7d946b2b155831941f69cce42ce95a71' '7f92d7950ac79db8e45f140d2e80877b', 'archive_sha256': '4217ccd75c11627e513e1c6e4395b4df' 'fdebe2b8a7494bc989e93c2b885b8be3'}, 'arm64': {'bytes': 39418704, 'sha256': '35c856fcd128b40723c8d310fd7044b5' '4cfd0f384306c5ac0858d0a3e03081fc', 'archive_sha256': '175c95f6a19f078340706886ecea18b7' '370030518a8d8717795dcf82e862e506'}}
CONTRACT_NAME = 'hyperlane-starknet-v0.3.9.zip'
CONTRACT_URL = 'https://github.com/hyperlane-xyz/hyperlane-starknet/releases/download/v0.3.9/' + CONTRACT_NAME
CONTRACT_BYTES = 10829931
CONTRACT_SHA = '5303a50baf47b5c3cc30274cf4b6dcba' 'fbeb8425010fc3bf54854f5d1bd38667'
MEMBER_SHA = '594307d5fbc39e65770f4a20429d0b35' 'e34ec02893580a72e7b1bfaf9aae826e'
CHECKSUM_NAME = 'hyperlane-starknet-v0.3.9.CHECKSUM'
CHECKSUM_URL = CONTRACT_URL.replace(CONTRACT_NAME, CHECKSUM_NAME)
CHECKSUM_SHA = '1c567654967a6e6f58741ae84a3fbe59' 'd46c0743a397e99c5fb5b6fcd0c7c301'
COMMAND = ['--state-archive-capacity', 'full', '--block-generation-on', '5', '--seed', '0']


def require(value, message):
    if not value: raise ValueError(message)


def pin(path):
    row = path.lstat()
    require(path.is_absolute() and stat.S_ISREG(row.st_mode) and row.st_nlink == 1, 'Regular unaliased Starknet input required')
    with path.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': row.st_size, 'sha256': digest}


def checked(row):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Closed Starknet artifact descriptor required')
    path = Path(row['path'])
    require('..' not in path.parts and pin(path) == row, 'Starknet artifact changed')
    return path


def validate_policy(prerequisites, architecture):
    require(architecture in CLI_RELEASE, 'Explicit Linux architecture required')
    cli = prerequisites['native_cli']; target, size = CLI_RELEASE[architecture]
    require(set(cli) == {'name', 'architecture', 'source_url', 'bytes', 'sha256', 'archive'}, 'Exact Starkli executable/archive policy required')
    require(cli['name'] == 'starkli' and cli['architecture'] == architecture and cli['source_url'] == f'https://github.com/xJonathanLEI/starkli/releases/download/v0.4.1/starkli-{target}.tar.gz', 'Source Starkli0.4.1 GNU platform differs')
    require(type(cli['bytes']) is int and 64 <= cli['bytes'] <= 128 * 1024 ** 2 and isinstance(cli['sha256'], str) and re.fullmatch('[0-9a-f]{64}', cli['sha256']), 'Actual reviewed Linux CLI digest is required; no Darwin alias or invented hash')
    require(cli['bytes'] == CLI_OBSERVED[architecture]['bytes'] and cli['sha256'] == CLI_OBSERVED[architecture]['sha256'], 'Exact observed official Linux CLI member differs')
    archive = cli['archive']
    require(set(archive) == {'bytes', 'sha256', 'publisher_digest', 'member'} and archive['bytes'] == size and archive['sha256'] == CLI_OBSERVED[architecture]['archive_sha256'] and archive['publisher_digest'] is None and archive['member'] == './starkli', 'Reviewed exact archive bytes/computed digest/member required; no publisher digest was supplied')
    image = prerequisites['starknet_devnet']
    require(set(image) == {'schema', 'architecture', 'source_image', 'image_id', 'canonical_digest'} and type(image['schema']) is int and image['schema'] == 2 and image['architecture'] == architecture and image['source_image'] == SOURCE_IMAGE, 'Source devnet0.4.2 portable image policy required')
    require(re.fullmatch('sha256:[0-9a-f]{64}', image['image_id']) and image['canonical_digest'] == 'shardlabs/starknet-devnet-rs@sha256:' + IMAGE_DIGESTS[architecture], 'Actual daemon config ID and official platform RepoDigest must be separately bound')
    require(prerequisites['starknet_contracts'] == {'release': '0.3.9', 'source_url': CONTRACT_URL, 'bytes': CONTRACT_BYTES, 'sha256': CONTRACT_SHA, 'publisher_checksum_url': CHECKSUM_URL, 'publisher_checksum_bytes': 96, 'publisher_checksum_sha256': CHECKSUM_SHA, 'member_count': 558, 'member_sha256': MEMBER_SHA}, 'Closed Source contract release differs')
    return cli['source_url']


def parse_cli_version(raw):
    # Official v0.4.1 main.rs27 VERSION_STRING and165-174 --version:
    # package version + parenthesized short build commit, printed bare.
    # Qualified actual stdout is16B/SHA72c23169...; no name-prefix/strip fallback.
    require(type(raw) is bytes and raw == b'0.4.1 (b4223ee)\n', 'Exact Source Starkli0.4.1/b4223ee stdout required')
    return {'version': '0.4.1', 'build_commit': 'b4223ee'}


def cli_member(raw, policy):
    require(len(raw) == policy['archive']['bytes'] and hashlib.sha256(raw).hexdigest() == policy['archive']['sha256'], 'Reviewed CLI archive differs')
    # Bounded decompression followed by strict single-member USTAR parsing. No
    # concatenated tar, PAX/GNU metadata, links, paths, or hidden trailing bytes.
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream: expanded = stream.read(128 * 1024 ** 2 + 1)
    require(len(expanded) <= 128 * 1024 ** 2 and len(expanded) % 512 == 0, 'CLI archive expanded bound/alignment')
    require(len(expanded) >= 1536 and expanded[:100].split(b'\0', 1)[0] == b'./starkli' and expanded[156:157] in (b'0', b'\0'), 'Closed regular root Starkli member required')
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        members = archive.getmembers()
        require(len(members) == 1 and members[0].name == './starkli' and members[0].isreg() and not members[0].pax_headers and members[0].offset == 0 and members[0].offset_data == 512, 'Only one direct executable member is accepted')
        row = members[0]; require(row.size == policy['bytes'], 'Actual CLI size differs')
        end = 512 + ((row.size + 511) // 512) * 512
        require(len(expanded) >= end + 1024 and not any(expanded[512 + row.size:]), 'Nonzero padding/trailing second archive rejected')
        body = archive.extractfile(row).read()
    require(hashlib.sha256(body).hexdigest() == policy['sha256'], 'Actual Linux CLI hash differs')
    machine = {'amd64': 62, 'arm64': 183}[policy['architecture']]
    require(body[:7] == b'\x7fELF\x02\x01\x01' and int.from_bytes(body[18:20], 'little') == machine and int.from_bytes(body[16:18], 'little') in (2, 3), 'Actual GNU Linux CLI ELF required')
    return body


def contract_members(raw, checksum):
    require(len(raw) == CONTRACT_BYTES and hashlib.sha256(raw).hexdigest() == CONTRACT_SHA, 'Source contracts ZIP differs')
    require(len(checksum) == 96 and hashlib.sha256(checksum).hexdigest() == CHECKSUM_SHA, 'Published contract checksum differs')
    require(checksum.decode('ascii').split() == [CONTRACT_SHA, CONTRACT_NAME], 'Published checksum does not name exact release')
    result = {}; total = 0; folded = set()
    with zipfile.ZipFile(io.BytesIO(raw)) as source:
        rows = source.infolist(); require(len(rows) == 558, 'Closed contract member count')
        for row in rows:
            require(re.fullmatch('[A-Za-z0-9._-]+', row.filename) and row.filename not in ('.', '..') and row.filename.lower() not in folded and not row.is_dir() and not row.flag_bits & 1 and stat.S_IFMT(row.external_attr >> 16) in (0, stat.S_IFREG), 'Contract path/link/alias/encryption rejected')
            folded.add(row.filename.lower()); total += row.file_size
            require(total <= 128 * 1024 ** 2 and row.file_size <= 32 * 1024 ** 2, 'Closed contract expanded bound')
            result[row.filename] = source.read(row)
    digest = hashlib.sha256()
    for name, data in sorted(result.items()): digest.update(name.encode() + b'\0' + str(len(data)).encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    require(digest.hexdigest() == MEMBER_SHA, 'Source contract member digest differs')
    return result


def materialize_contracts(archive, checksum, root):
    files = contract_members(checked(archive).read_bytes(), checked(checksum).read_bytes())
    require(not root.exists() and not root.is_symlink(), 'Exclusive Starknet contract copy required')
    (root / 'contracts').mkdir(parents=True, mode=0o700)
    for name, source in [(CONTRACT_NAME, archive), (CHECKSUM_NAME, checksum)]:
        destination = root / name
        with destination.open('xb') as stream: stream.write(checked(source).read_bytes())
        destination.chmod(0o600)
    result = {}
    for name, data in sorted(files.items()):
        destination = root / 'contracts' / name
        with destination.open('xb') as stream: stream.write(data)
        destination.chmod(0o600); result[name] = pin(destination)
    return {'schema': 1, 'scenario': 'starknet', 'source_release': '0.3.9', 'root': str(root / 'contracts'), 'archive': pin(root / CONTRACT_NAME), 'publisher_checksum': pin(root / CHECKSUM_NAME), 'files': result}


def read_contracts(bundle):
    require(set(bundle) == {'schema', 'scenario', 'source_release', 'root', 'archive', 'publisher_checksum', 'files'} and bundle['schema'] == 1 and bundle['scenario'] == 'starknet' and bundle['source_release'] == '0.3.9', 'Exact Starknet contract bundle required')
    expected = contract_members(checked(bundle['archive']).read_bytes(), checked(bundle['publisher_checksum']).read_bytes())
    root = Path(bundle['root']); require(root.is_absolute() and not root.is_symlink() and root.resolve(strict=True) == root, 'Canonical contract root required')
    require(set(bundle['files']) == set(expected) == {p.name for p in root.iterdir()}, 'Missing/extra contract member')
    for name, data in expected.items():
        path = checked(bundle['files'][name]); require(path == root / name and path.stat().st_mode & 0o111 == 0 and path.read_bytes() == data, 'Contract data changed/aliased/executable')
    return bundle


def image_inspect(rows, policy):
    require(isinstance(rows, list) and len(rows) == 2, 'Image ID AND actual Source tag inspections required')
    require(all(row.get('Id') == policy['image_id'] and row.get('Os') == 'linux' and row.get('Architecture') == policy['architecture'] and policy['canonical_digest'] in row.get('RepoDigests', []) and not row.get('Config', {}).get('Volumes') for row in rows), 'Source tag/platform/digest/config differs or introduces unaccounted volumes')
    return rows


def resolve_system_dso(candidates, name, architecture):
    """Select one canonical native ELF from a possibly multiarch ldconfig row.

    This only selects by bounded ELF header. cli_loader still verifies every
    dynamic table, SONAME, interpreter and search-path edge before admission.
    """
    require(architecture in {'amd64', 'arm64'} and re.fullmatch('[A-Za-z0-9_.+-]{1,128}', name), 'Exact native DSO lookup required')
    require(isinstance(candidates, (set, list, tuple)) and 0 < len(candidates) <= 16, 'Bounded native DSO candidates required')
    machine = {'amd64': 62, 'arm64': 183}[architecture]
    native = set()
    for candidate in candidates:
        path = Path(candidate).resolve(strict=True)
        row = path.stat()
        require(stat.S_ISREG(row.st_mode) and 64 <= row.st_size <= 512 * 1024 ** 2, 'Bounded regular system DSO required')
        with path.open('rb') as stream: header = stream.read(64)
        require(len(header) == 64 and header[:4] == b'\x7fELF' and header[4] in (1, 2) and header[5:7] == b'\x01\x01', 'Malformed system DSO header')
        kind, actual = struct.unpack_from('<HH', header, 16)
        require(kind == 3, 'System DSO must be ET_DYN')
        if header[4] == 2 and actual == machine: native.add(path)
    require(len(native) == 1, 'Ambiguous/missing native system DSO: ' + name)
    return next(iter(native))


def cli_loader(cli, architecture, dynamic_parser, resolve):
    """Inspect real program headers, then close actual system DT_NEEDED edges.

    No assumption that an official GNU executable is dynamically linked. The
    common parser's explicit libc-only exception is a separately reviewed base
    prerequisite, never a generic allowance for DSOs with an interpreter.
    """
    machine = {'amd64': 62, 'arm64': 183}[architecture]
    with cli.open('rb') as stream:
        header = stream.read(64)
        require(len(header) == 64 and header[:7] == b'\x7fELF\x02\x01\x01' and struct.unpack_from('<H', header, 18)[0] == machine, 'Actual CLI ELF platform differs')
        kind, phoff, phsize, count = struct.unpack_from('<H', header, 16)[0], struct.unpack_from('<Q', header, 32)[0], struct.unpack_from('<H', header, 54)[0], struct.unpack_from('<H', header, 56)[0]
        require(kind in (2, 3) and phsize == 56 and 0 < count <= 1024 and 64 <= phoff <= cli.stat().st_size - count * phsize, 'CLI program-header bound')
        stream.seek(phoff); rows = [struct.unpack('<IIQQQQQQ', stream.read(56)) for _ in range(count)]
        require(all(row[2] <= cli.stat().st_size and row[5] <= cli.stat().st_size - row[2] for row in rows), 'CLI segment escaped file')
    if not any(row[0] in (2, 3) for row in rows):
        require(kind == 2 and any(row[0] == 1 and row[1] & 1 and row[3] <= struct.unpack_from('<Q', header, 24)[0] < row[3] + row[6] for row in rows), 'Static CLI entry must lie in executable load')
        return {'schema': 1, 'architecture': architecture, 'cli': pin(cli), 'interpreter': None, 'files': {}, 'graph': {'starkli': {'linkage': 'static', 'machine': machine}}}
    info = dynamic_parser(cli, machine, True)
    require(info['rpath'] is None and info['runpath'] is None, 'Unreviewed CLI search-path override')
    interpreter = Path(info['interpreter']).resolve(strict=True)
    require(interpreter.name in {'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1'}, 'Actual native system interpreter required')
    graph = {'starkli': info}; files = {}; pending = [*info['needed'], interpreter.name]
    allowed = {'libc.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'libm.so.6', 'libresolv.so.2', 'libstdc++.so.6', 'libssl.so.3', 'libcrypto.so.3', 'libssl.so.1.1', 'libcrypto.so.1.1', interpreter.name}
    while pending:
        name = pending.pop()
        if name in files: continue
        require(name in allowed and len(files) < 32, 'Unknown/excessive actual CLI loader dependency')
        path = interpreter if name == interpreter.name else resolve(name).resolve(strict=True)
        options = {'system_libc_interpreter': interpreter} if name == 'libc.so.6' else {}
        value = dynamic_parser(path, machine, **options)
        require(value['rpath'] is None and value['runpath'] is None and value['soname'] in (None, name), 'Unreviewed system loader search path/SONAME')
        files[name] = pin(path); graph[name] = value; pending.extend(value['needed'])
    return {'schema': 1, 'architecture': architecture, 'cli': pin(cli), 'interpreter': pin(interpreter), 'files': files, 'graph': graph}


def validate_cli_loader(graph, cli, architecture, parser=None):
    if parser is None: parser = elf_dynamic
    require(set(graph) == {'schema', 'architecture', 'cli', 'interpreter', 'files', 'graph'} and graph['schema'] == 1 and graph['architecture'] == architecture and graph['cli'] == pin(cli), 'Actual CLI loader descriptor differs')
    for row in graph['files'].values(): checked(row)
    if graph['interpreter'] is not None: checked(graph['interpreter'])
    rebuilt = cli_loader(cli, architecture, parser, lambda name: checked(graph['files'][name]))
    require(rebuilt == graph, 'Actual CLI loader closure changed')
    return graph


# Read-only parser derived from the historical CW packet, kept independent:
# CW static CLI readiness does not depend on this dynamic loader API.
def elf_dynamic(path,machine,executable=False,*,system_libc_interpreter=None):
    """Read ELF64 program/dynamic tables without ldd, loader or input execution."""
    metadata=path.lstat();require(stat.S_ISREG(metadata.st_mode) and 64<=metadata.st_size<=128*1024**2,'Bounded regular Linux ELF required')
    size=metadata.st_size
    with path.open('rb') as stream:
        header=stream.read(64)
        require(header[:7]==b'\x7fELF\x02\x01\x01' and header[7] in (0,3),'Linux ELF64 little-endian required')
        kind,actual,version=struct.unpack_from('<HHI',header,16);entry,phoff=struct.unpack_from('<QQ',header,24);ehsize,phsize,count=struct.unpack_from('<HHH',header,52)
        require(actual==machine and version==1 and kind in ({2,3} if executable else {3}) and ehsize==64 and phsize==56 and 1<=count<=1024 and phoff>=64 and phoff+phsize*count<=size,'ELF platform/header/type differs')
        stream.seek(phoff);table=stream.read(phsize*count);loads=[];dynamic=[];interpreters=[]
        for index in range(count):
            tag,flags,offset,virtual,physical,length,memory,alignment=struct.unpack_from('<IIQQQQQQ',table,index*phsize)
            require(offset<=size and length<=size-offset,'ELF segment escaped file')
            if tag==1:require(memory>=length,'Invalid PT_LOAD');loads.append((virtual,offset,length,memory,flags))
            if tag==2:dynamic.append((offset,length))
            if tag==3:
                require(1<length<=4096,'ELF interpreter bound');stream.seek(offset);raw=stream.read(length);require(raw.endswith(b'\0') and b'\0' not in raw[:-1],'Interpreter termination')
                value=raw[:-1].decode('ascii');require(value.startswith('/') and '..' not in Path(value).parts and '\n' not in value,'Unsafe interpreter');interpreters.append(value)
        require(loads and len(dynamic)==1 and len(interpreters)<=1,'Missing/duplicate ELF load/dynamic/interpreter tables')
        if executable:require(bool(interpreters) and system_libc_interpreter is None,'Dynamic executable interpreter required')
        if executable:require(entry and any(flags&1 and address<=entry<address+memory for address,offset,length,memory,flags in loads),'Executable entry not in executable load')
        offset,length=dynamic[0];require(length%16==0 and 16<=length<=1024*1024,'Dynamic table bound');stream.seek(offset);data=stream.read(length);values={};terminated=False
        for index in range(0,len(data),16):
            tag,value=struct.unpack_from('<qQ',data,index)
            if tag==0:terminated=True;break
            values.setdefault(tag,[]).append(value)
        require(terminated and len(values.get(5,[]))==1 and len(values.get(10,[]))==1,'ELF dynamic strings required')
        require(not any(tag in values for tag in (0x7fffffff,0x7ffffffd,0x6ffffefc,0x6ffffefb)),'Unsupported ELF filter/auxiliary/audit loader dependency')
        address=values[5][0];length=values[10][0];require(0<length<=1024*1024,'Dynamic strings bound')
        mapped=[offset+address-base for base,offset,n,m,f in loads if base<=address and address-base<=n and length<=n-(address-base)]
        require(len(mapped)==1,'Ambiguous/unmapped ELF string table');stream.seek(mapped[0]);strings=stream.read(length)
        def string(index):
            require(index<len(strings),'Dynamic string index bound');end=strings.find(b'\0',index);require(end!=-1,'Unterminated dynamic string');return strings[index:end].decode('ascii')
        needed=[string(index) for index in values.get(1,[])]
        require(len(needed)==len(set(needed)) and all(re.fullmatch('[A-Za-z0-9_.+-]+',name) for name in needed),'Duplicate/unsafe loader dependency')
        for tag in (14,15,29):require(len(values.get(tag,[]))<=1,'Duplicate SONAME/RPATH/RUNPATH')
        soname=string(values[14][0]) if 14 in values else None
        if not executable:
            if interpreters:
                require(system_libc_interpreter is not None and kind==3 and soname=='libc.so.6' and Path(interpreters[0]).resolve(strict=True)==system_libc_interpreter.resolve(strict=True),'Only system libc may embed the exact already-pinned CLI interpreter')
            if system_libc_interpreter is not None:require(kind==3 and soname=='libc.so.6','libc context cannot authorize another DSO')
        return {'machine':actual,'type':kind,'interpreter':interpreters[0] if interpreters else None,'needed':needed,'soname':soname,'rpath':string(values[15][0]) if 15 in values else None,'runpath':string(values[29][0]) if 29 in values else None}
