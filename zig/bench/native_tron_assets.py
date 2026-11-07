"""Closed Linux Tron CLI/package and TRE image admission; no native execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

GIB=1024**3
SOURCE_IMAGE='tronbox/tre@sha256:f4332e11df12a9f360639a4546fd0465' '93909630fda48af00b30410c144342f0'
IMAGE_IDS={'amd64':'sha256:bf3a2b631ff2a1834530f69fcb90508c' '40970203aa1240b692223308cc90cae0','arm64':'sha256:a29467ffe0610ea009363aa2037650f0' '24d94ebd46ffa19507df97edc67bcab9'}
COMMAND=['./quickstart','v2.0.0']
CLI_POLICY={'schema':1,'name':'hyperlane','version':'45.1.0','node_version':'26.12.1','pnpm_version':'12.3.0','full_original_tsconfig':True,'EVM_solc':'0.8.33','TVM_solc':'0.8.24','owned_full_package_graph':True}
MUTABLE_REGISTRY=('test-configs/tron/chains/anvil1/addresses.yaml','test-configs/tron/chains/anvil2/addresses.yaml')
PACKAGE_ROOTS=('typescript/tsconfig', 'typescript/utils', 'solhint-plugin', 'solidity', 'typescript/provider-sdk', 'typescript/aleo-sdk', 'typescript/cosmos-types', 'typescript/cosmos-sdk', 'typescript/radix-sdk', 'typescript/forking-sdk', 'typescript/svm-sdk', 'starknet', 'typescript/starknet-sdk', 'typescript/tron-sdk', 'typescript/deploy-sdk', 'typescript/sdk', 'typescript/http-registry-server', 'typescript/metrics', 'typescript/keyfunder', 'typescript/relayer', 'typescript/rebalancer', 'typescript/infra', 'typescript/cli')
ROOT_PAYLOADS=('vectors','scripts','patches','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.nvmrc','turbo.json','.registryrc')
OPTIONAL_ROOT_PAYLOADS=('.npmrc','.pnpmfile.cjs')
MAX_FILES=200000
MAX_BYTES=4*GIB


def require(value,message):
    if not value:raise ValueError(message)


def pin(path):
    require(path.is_file()and not path.is_symlink(),'Regular nonsymlink Tron input required')
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':digest}


def checked(row):
    require(isinstance(row,dict)and set(row)=={'path','bytes','sha256'},'Exact Tron artifact descriptor required')
    path=Path(row['path']);require(path.is_absolute()and '..'not in path.parts and pin(path)==row,'Tron artifact changed');return path


def validate_policy(prerequisites,architecture):
    require(architecture in IMAGE_IDS and prerequisites['tron_cli']==CLI_POLICY and all(type(prerequisites['tron_cli'][key])is type(expected)for key,expected in CLI_POLICY.items()),'Exact Source CLI45.1.0/Node26.12.1/pnpm12.3.0/full build policy required')
    row=prerequisites['tron_tre'];require(set(row)=={'schema','architecture','source_image','canonical_digest','image_id','command','entrypoint'}and type(row['schema'])is int and row['schema']==2 and row['architecture']==architecture and row['source_image']==row['canonical_digest']==SOURCE_IMAGE and row['image_id']==IMAGE_IDS[architecture]and row['command']==COMMAND and row['entrypoint']is None,'Exact official native-platform TRE2.0.0 identity required')
    return row


def image_inspect(rows,policy):
    require(isinstance(rows,list)and len(rows)==2,'Inspect both immutable Source reference and native config ID')
    validate_policy({'tron_cli':CLI_POLICY,'tron_tre':policy},policy['architecture'])
    for row in rows:
        require(row.get('Id')==policy['image_id']and row.get('Os')=='linux'and row.get('Architecture')==policy['architecture']and SOURCE_IMAGE in row.get('RepoDigests',[])and row.get('Config',{}).get('Cmd')==COMMAND and row['Config'].get('Entrypoint')is None,'Actual TRE ID/RepoDigest/platform/entrypoint differs')
        require(not row['Config'].get('Volumes'),'Unaccounted image volumes rejected')


def cli_source(repo):
    package=json.loads((repo/'typescript/cli/package.json').read_text())
    require(package['name']=='@hyperlane-xyz/cli'and package['version']=='45.1.0'and package['scripts']['hyperlane']=='node ./dist/cli.js','Exact full CLI package/entrypoint required')
    require((repo/'typescript/cli/src/version.ts').read_text().strip()=="export const VERSION = '45.1.0';",'Do not run version:update or rewrite VERSION')
    require(json.loads((repo/'package.json').read_text())['packageManager'].split('+',1)[0]=='pnpm@12.3.0','Exact pnpm lock consumer required')
    require((repo/'.nvmrc').read_text().strip().lstrip('v')=='26.12.1','Exact actual Node prerequisite required')
    for name in ['anvil1','anvil2']:
        path=repo/'typescript/cli/test-configs/tron/chains'/name/'metadata.yaml';text=path.read_text()
        require('chainId: 3360022319'in text and 'domainId: '+str(1212538670+(name=='anvil2'))in text and 'protocol: tron'in text and 'http://127.0.0.1:9090/jsonrpc'in text,'Actual two-chain TRE9090 Source corpus differs')
    return package


def graph(repo,package_roots,architecture):
    """Pin every installed payload/link, internal package and compiled CLI output.

    Never follow a workspace link during enumeration. Targets must resolve into
    this ONE Linux workspace; there are no borrowed Mac products or old SDKs.
    """
    require(repo.is_absolute()and not repo.is_symlink()and repo.resolve()==repo and architecture in IMAGE_IDS,'Canonical Linux package root required')
    require(list(package_roots)==list(PACKAGE_ROOTS),'Exact ordered full CLI package closure required');roots=['node_modules',*package_roots,*ROOT_PAYLOADS,*[name for name in OPTIONAL_ROOT_PAYLOADS if(repo/name).exists()]]
    for name in package_roots:
        require(not Path(name).is_absolute()and '..'not in Path(name).parts,'Closed relative workspace packages required')
        require((repo/name/'package.json').is_file(),'Workspace package manifest missing')
    entries={};total=0;stack=[repo/name for name in roots]
    while stack:
        path=stack.pop();relative=str(path.relative_to(repo));require(len(entries)<MAX_FILES,'Bounded full CLI graph file count')
        if relative in entries:continue
        require(path.exists()or path.is_symlink(),'Missing full installed dependency graph')
        mode=path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target=os.readlink(path);require(not os.path.isabs(target)and path.resolve(strict=True).is_relative_to(repo),'External/absolute/dangling graph link rejected')
            entries[relative]={'kind':'symlink','target':target,'resolved':str(path.resolve().relative_to(repo))}
        elif stat.S_ISDIR(mode):
            entries[relative]={'kind':'directory'}
            for child in sorted(path.iterdir(),reverse=True):
                if child.name!='.git':stack.append(child)
        else:
            require(stat.S_ISREG(mode),'Special package payload rejected')
            row=pin(path);total+=row['bytes'];require(total<=MAX_BYTES,'Full Linux CLI copies exceed original4GiB case cap')
            with path.open('rb')as source:header=source.read(20)
            require(header[:4]not in {b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'},'Mac executable payload cannot be a Linux package product')
            if header[:4]==b'\x7fELF':require(header[4:6]==b'\x02\x01'and int.from_bytes(header[18:20],'little')=={'amd64':62,'arm64':183}[architecture],'Foreign native dependency payload')
            if path.suffix=='.node':require(header[:4]==b'\x7fELF','Native addon must be actual Linux ELF')
            entries[relative]={'kind':'file','bytes':row['bytes'],'sha256':row['sha256'],'mode':stat.S_IMODE(mode)}
    require('typescript/cli/dist/cli.js'in entries and any(n.startswith('solidity/dist/tron/typechain/factories/')for n in entries)and 'solidity/dist/buildArtifact.json'in entries,'Actual CLI/core EVM/TVM artifacts required')
    for row in entries.values():
        if row['kind']=='symlink':require(row['resolved']in entries,'Symlink target missing from complete admitted graph')
    return {'schema':1,'architecture':architecture,'root':str(repo),'package_roots':package_roots,'entries':dict(sorted(entries.items())),'regular_payload_bytes':total,'native_case_acceptance':False,'scope':'Full exact Linux workspace/package closure, not SDK/CLI evaluation or native delivery'}


def verify_graph(value):
    require(value['schema']==1 and value['native_case_acceptance']is False,'Exact non-native package receipt required')
    actual=graph(Path(value['root']),value['package_roots'],value['architecture']);require(actual==value,'Installed Linux CLI graph changed');return actual


def read_graph(row):
    path=checked(row);require(path.stat().st_size<=64*1024**2,'Bounded CLI payload manifest required');value=json.loads(path.read_text());verify_graph(value);return value


def copy_charge(value,fragment):
    require(type(fragment)is int and 0<fragment<=1024**2,'Actual bounded target filesystem fragment required')
    def charge(name,row):
        if row['kind']=='file':return max(fragment,((row['bytes']+fragment-1)//fragment)*fragment)
        return fragment
    total=sum(charge(name,row)for name,row in value['entries'].items())
    prefixes=('typescript/cli/dist/','typescript/cli/test-configs/tron/')
    total+=sum(charge(name,row)for name,row in value['entries'].items()if name.startswith(prefixes)or name=='typescript/cli/package.json')
    # Root dirs plus bounded graph/copy/required-input metadata. The original
    # owner additionally charges exact2GiB PG tmpfs; reserve it BEFORE copying.
    return total+32*fragment+256*1024**2


def materialize(value,destination,existing_case_allocated):
    verify_graph(value);source=Path(value['root']);require(destination.is_absolute()and not destination.exists()and not destination.is_symlink(),'Fresh owned case/tron-cli copy required')
    charge=copy_charge(value,os.statvfs(destination.parent).f_frsize)
    require(shutil.disk_usage(destination.parent).free>=6*GIB+charge,'Full owned CLI copies must preserve6GiB floor')
    require(type(existing_case_allocated)is int and existing_case_allocated>=0 and existing_case_allocated+charge+2*GIB<=MAX_BYTES,'Existing case/CLI allocation/metadata plus2GiB PG tmpfs exceeds original4GiB cap')
    destination.mkdir(mode=0o700);workspace=destination/'.workspace';workspace.mkdir()
    for name,row in value['entries'].items():
        path=workspace/name
        if row['kind']=='directory':path.mkdir(parents=True,exist_ok=True)
        elif row['kind']=='file':
            path.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,path);path.chmod(row['mode']);require(pin(path)['sha256']==row['sha256'],'Owned CLI payload changed during copy')
        else:path.parent.mkdir(parents=True,exist_ok=True);path.symlink_to(row['target'])
    copied={**value,'root':str(workspace)};verify_graph(copied)
    # The Rust checked_owned_path entrypoint has NO symlink parent. pnpm package
    # resolution may use only relative links into the already pinned own graph.
    shutil.copytree(workspace/'typescript/cli/dist',destination/'dist',symlinks=False)
    shutil.copytree(workspace/'typescript/cli/test-configs/tron',destination/'test-configs/tron',symlinks=False)
    shutil.copyfile(workspace/'typescript/cli/package.json',destination/'package.json')
    (destination/'node_modules').symlink_to('.workspace/typescript/cli/node_modules')
    immutable=[]
    for root in [destination/'dist',destination/'test-configs/tron']:
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(),'CLI data/dist may not introduce link parents')
            if path.is_file()and str(path.relative_to(destination))not in MUTABLE_REGISTRY:immutable.append(pin(path))
    immutable.append(pin(destination/'package.json'))
    return {'schema':1,'root':str(destination),'workspace':copied,'entrypoint':pin(destination/'dist/cli.js'),'immutable_files':immutable,'mutable_registry_slots':[str(destination/name)for name in MUTABLE_REGISTRY],'native_case_acceptance':False}


def verify_materialized(value):
    require(value['schema']==1 and value['native_case_acceptance']is False,'Owned CLI graph receipt required');root=Path(value['root']);require(root.is_absolute()and not root.is_symlink(),'Owned CLI root differs');verify_graph(value['workspace'])
    require((root/'node_modules').is_symlink()and os.readlink(root/'node_modules')=='.workspace/typescript/cli/node_modules','Owned CLI dependency alias changed')
    checked(value['entrypoint'])
    for row in value['immutable_files']:checked(row)
    require(value['mutable_registry_slots']==[str(root/name)for name in MUTABLE_REGISTRY],'Only the two Source registry address files may mutate')
    actual=[]
    for base in [root/'dist',root/'test-configs/tron']:
        for path in sorted(base.rglob('*')):
            require(not path.is_symlink(),'CLI writable registry/dist link appeared')
            if path.is_file()and str(path.relative_to(root))not in MUTABLE_REGISTRY:actual.append(pin(path))
    actual.append(pin(root/'package.json'));require(actual==value['immutable_files'],'Owned CLI new/removed/changed immutable payload')
    require({path.name for path in root.iterdir()}=={'.workspace','dist','test-configs','package.json','node_modules'},'Unexpected CLI root mutation')
    return value


def read_materialized(row):
    path=checked(row);require(path.stat().st_size<=64*1024**2,'Bounded owned CLI closure required');return verify_materialized(json.loads(path.read_text()))
