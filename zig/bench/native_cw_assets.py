#!/usr/bin/env python3
"""Closed CW release data and exact static Linux ELF admission. Never execute an input."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import zipfile

WASM_URL='https://github.com/hyperlane-xyz/cosmwasm/releases/download/v0.0.6/wasm_codes.zip'
WASM_BYTES=1640623
WASM_SHA='5b0b3b76ef5daf8a69cbc4ee1e9762d3'+'c9108127842343bd59cd68862ed0aa9c'
WASM_MEMBER_SHA='df340d9c357fea6e44a402a68e061ba3'+'484db11e00e19b11ebb282a8b698b7a7'
CLI_RELEASE={
 'amd64':{'source_url':'https://github.com/osmosis-labs/osmosis/releases/download/v20.5.0/osmosisd-20.5.0-linux-amd64','bytes':72612632,'sha256':'f9ff6176e32499f22b20288c71dbc8025'+'56eb5399baef23de164fe6158a55a69'},
 'arm64':{'source_url':'https://github.com/osmosis-labs/osmosis/releases/download/v20.5.0/osmosisd-20.5.0-linux-arm64','bytes':67363240,'sha256':'99359257ff81d21b55b685924a74473d'+'532cbc5af196a672a784bf13dad06d26'},
}
CLI_CHECKSUM_URL='https://github.com/osmosis-labs/osmosis/releases/download/v20.5.0/sha256sum.txt'
CLI_CHECKSUM_BYTES=390
CLI_CHECKSUM_SHA='0d9d136fe46a7c7dcf49df1ed80cbbde'+'86c1e9cf25aacb5fba260836b786a7aa'


def require(value,message):
    if not value:raise ValueError(message)


def pin(path):
    row=path.lstat();require(stat.S_ISREG(row.st_mode) and row.st_nlink==1,'Regular unaliased CW data required')
    with path.open('rb') as stream:sha=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':row.st_size,'sha256':sha}


def closed_zip(raw,maximum_bytes,maximum_members):
    """Validate every member, including unselected module files, before copying."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows=archive.infolist();seen=set();total=0;result={}
        require(0<len(rows)<=maximum_members,'CW archive member bound')
        for row in rows:
            path=PurePosixPath(row.filename);mode=row.external_attr>>16
            require(row.filename and not path.is_absolute() and '\\' not in row.filename and str(path)==row.filename and all(part not in {'.','..',''} for part in path.parts),'Unsafe CW archive path')
            require(row.filename not in seen and not row.flag_bits&1 and not row.is_dir() and stat.S_IFMT(mode) in (0,stat.S_IFREG),'CW link/directory/duplicate/encrypted member')
            seen.add(row.filename);total+=row.file_size
            require(total<=maximum_bytes and row.file_size<=maximum_bytes,'CW expanded byte bound')
            result[row.filename]=archive.read(row)
        return result


def wasm_members(raw):
    require(len(raw)==WASM_BYTES and hashlib.sha256(raw).hexdigest()==WASM_SHA,'CW archive differs from Source v0.0.6')
    files=closed_zip(raw,64*1024**2,21)
    require(len(files)==21 and all(re.fullmatch('[A-Za-z0-9._-]+',name) for name in files) and 'checksums.txt' in files and sum(name.endswith('.wasm') for name in files)==20,'Closed flat20-WASM/checksum set required')
    digest=hashlib.sha256()
    for name,data in sorted(files.items()):digest.update(name.encode()+b'\0'+str(len(data)).encode()+b'\0'+hashlib.sha256(data).hexdigest().encode()+b'\n')
    require(digest.hexdigest()==WASM_MEMBER_SHA,'CW member digest differs from Source')
    declared={}
    for line in files['checksums.txt'].decode().splitlines():
        parts=line.split();require(len(parts)==2 and parts[1] not in declared and parts[1] in files and parts[1].endswith('.wasm') and re.fullmatch('[0-9a-f]{64}',parts[0]),'Malformed/duplicate bundled WASM checksum')
        require(hashlib.sha256(files[parts[1]]).hexdigest()==parts[0],'Bundled WASM checksum mismatch');declared[parts[1]]=parts[0]
    require(set(declared)=={name for name in files if name.endswith('.wasm')},'Incomplete bundled WASM checksums')
    require(all(data.startswith(b'\x00asm\x01\x00\x00\x00') for name,data in files.items() if name.endswith('.wasm')),'Invalid actual WASM version/header')
    return files


def static_cli(path,architecture):
    """Admit exact official self-contained ELF bytes; never load or execute them."""
    require(architecture in CLI_RELEASE,'Known static CLI architecture required')
    expected=CLI_RELEASE[architecture];row=pin(path)
    require(row['bytes']==expected['bytes'] and row['sha256']==expected['sha256'],'Exact official static CLI bytes differ')
    machine={'amd64':62,'arm64':183}[architecture];size=row['bytes']
    require(64<=size<=128*1024**2,'Bounded official static CLI required')
    with path.open('rb') as stream:
        header=stream.read(64)
        require(header[:7]==b'\x7fELF\x02\x01\x01' and header[7] in (0,3),'Linux ELF64 little-endian required')
        kind,actual,version=struct.unpack_from('<HHI',header,16);entry,phoff=struct.unpack_from('<QQ',header,24);ehsize,phsize,count=struct.unpack_from('<HHH',header,52)
        require(kind==2 and actual==machine and version==1 and entry!=0,'Exact static ET_EXEC native platform/entry required')
        require(ehsize==64 and phsize==56 and 1<=count<=1024 and phoff>=64 and phoff+phsize*count<=size,'Static CLI program-header bound')
        stream.seek(phoff);table=stream.read(phsize*count);loads=[]
        for index in range(count):
            tag,flags,offset,virtual,physical,length,memory,alignment=struct.unpack_from('<IIQQQQQQ',table,index*phsize)
            require(offset<=size and length<=size-offset,'Static CLI segment escaped file')
            require(tag not in (2,3),'Static CLI must have no PT_DYNAMIC or PT_INTERP')
            if tag==1:
                require(memory>=length,'Static CLI invalid PT_LOAD')
                loads.append((virtual,length,memory,flags))
        require(loads and any(flags&1 and address<=entry<address+length for address,length,memory,flags in loads),'Static CLI entry outside file-backed executable load')
    return {'schema':1,'architecture':architecture,'artifact':row,'ELF':{'class':64,'endianness':'little','machine':machine,'type':kind,'entry':entry,'program_headers':count,'load_segments':len(loads),'PT_DYNAMIC_count':0,'PT_INTERP_count':0},'native_code_executed':False}


def validate_cli_policy(policy,architecture):
    expected=CLI_RELEASE[architecture]
    require(set(policy)=={'name','architecture','source_url','bytes','sha256'} and policy['name']=='osmosisd' and policy['architecture']==architecture and policy['source_url']==expected['source_url'] and policy['bytes']==expected['bytes'] and policy['sha256']==expected['sha256'],'Exact reviewed official Source20.5.0 raw CLI required')
    return expected['source_url']


def published_cli_checksums(raw):
    require(len(raw)==CLI_CHECKSUM_BYTES and hashlib.sha256(raw).hexdigest()==CLI_CHECKSUM_SHA,'Official Osmosis checksum size/hash differs')
    rows={}
    for line in raw.decode('ascii').splitlines():
        parts=line.split();require(len(parts)==2 and re.fullmatch('[0-9a-f]{64}',parts[0]) and parts[1] not in rows,'Invalid published Osmosis checksum row');rows[parts[1]]=parts[0]
    expected={Path(row['source_url']).name for row in CLI_RELEASE.values()};expected|={name+'.tar.gz' for name in expected}
    require(set(rows)==expected and all(rows[Path(row['source_url']).name]==row['sha256'] for row in CLI_RELEASE.values()),'Official Osmosis checksum closure differs');return rows


def validate_policy(prerequisites,architecture):
    require(architecture in CLI_RELEASE,'Native CW architecture required')
    validate_cli_policy(prerequisites['native_cli'],architecture)
    require(type(prerequisites['wasm_bundle'].get('schema')) is int,'CW bundle schema must be an integer')
    require(prerequisites['registry_commit'] is None,'CW must not claim a TypeScript registry')
    require(prerequisites['wasm_bundle']=={'schema':1,'source_release':'v0.0.6','source_url':WASM_URL,'bytes':WASM_BYTES,'sha256':WASM_SHA,'member_count':21,'member_digest':WASM_MEMBER_SHA,'publisher_checksum':None},'Exact Source CW bundle policy required')
    require(set(prerequisites)=={'local_checkout_build','hpack','registry_commit','native_cli','wasm_bundle'} and prerequisites['local_checkout_build'] is True,'Static CW policy has no external loader/module or extra fields')


def materialize_wasm(raw,destination):
    files=wasm_members(raw)
    require(destination.is_absolute() and not destination.exists() and not destination.is_symlink(),'New owned CW data root required')
    destination.mkdir(mode=0o700);root=destination/'contracts';root.mkdir(mode=0o700);archive=destination/'wasm_codes.zip'
    with archive.open('xb') as stream:stream.write(raw)
    archive.chmod(0o600);rows={}
    for name,data in sorted(files.items()):
        path=root/name
        with path.open('xb') as stream:stream.write(data)
        path.chmod(0o600);rows[name]=pin(path)
    return {'schema':1,'scenario':'cosmwasm','source_release':'v0.0.6','root':str(root),'archive':pin(archive),'publisher_checksum':None,'files':rows}


def read_wasm_bundle(bundle):
    require(set(bundle)=={'schema','scenario','source_release','root','archive','publisher_checksum','files'} and type(bundle['schema']) is int and bundle['schema']==1 and bundle['scenario']=='cosmwasm' and bundle['source_release']=='v0.0.6' and bundle['publisher_checksum'] is None,'Exact CW helper bundle schema required')
    archive=Path(bundle['archive']['path']);require(pin(archive)==bundle['archive'] and not archive.stat().st_mode&0o111,'CW archive changed or executable')
    raw=archive.read_bytes();files=wasm_members(raw);root=Path(bundle['root'])
    require(root.is_absolute() and root.resolve(strict=True)==root and root.is_dir() and set(bundle['files'])==set(files) and {path.name for path in root.iterdir()}==set(files),'Closed canonical CW tree required')
    for name,data in files.items():
        path=root/name;require(pin(path)==bundle['files'][name] and path==Path(bundle['files'][name]['path']) and not path.stat().st_mode&0o111 and path.read_bytes()==data,'CW member path/bytes/mode changed')
    return raw


