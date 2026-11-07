"""Exact future Linux Tron setup recipe. No action except explicit CI setup worker."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

PNPM_RELEASE={'amd64': {'source_url': 'https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.3.0.tgz', 'archive_bytes': 19223500, 'archive_sha256': 'bca0e805a33855a99c7b2557a842212d' '67994785217cb8922b33d2c0e40815cb', 'member': 'package/pnpm', 'bytes': 44686464, 'sha256': '5635ac1a8305715ce6edc028890c9b30' 'd26f743733e215105ddc131ae5cfe186'}, 'arm64': {'source_url': 'https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-12.3.0.tgz', 'archive_bytes': 17616532, 'archive_sha256': 'ecf0752448eec84f17485c5fbede6a0b' '5c1a28089bc72d2ba1a00b3cb0db655b', 'member': 'package/pnpm', 'bytes': 35741160, 'sha256': 'b899c8a160a8cbaf23220ee9527d16da' '50ac1dc81d1b32da3293b7423cf59f5c'}}


def assets():
    spec=importlib.util.spec_from_file_location('tron_setup_assets',Path(__file__).with_name('native_tron_assets.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def require(ok,message):
    if not ok:raise ValueError(message)


def pnpm_member(archive,architecture):
    policy=PNPM_RELEASE[architecture];require(len(archive)==policy['archive_bytes']and hashlib.sha256(archive).hexdigest()==policy['archive_sha256'],'Exact official Linux pnpm12.3.0 archive required')
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz')as source:
        rows=source.getmembers();require(len(rows)==4 and {r.name for r in rows}=={'package/THIRD-PARTY-NOTICES.md','package/package.json','package/pnpm','package/LICENSE'}and all(r.isfile()and not r.issym()and not r.islnk()for r in rows)and sum(r.size for r in rows)<=64*1024**2,'Closed four-member native pnpm package required')
        body=source.extractfile(policy['member']).read(policy['bytes']+1);require(len(body)==policy['bytes']and hashlib.sha256(body).hexdigest()==policy['sha256']and body[:6]==b'\x7fELF\x02\x01'and int.from_bytes(body[18:20],'little')=={'amd64':62,'arm64':183}[architecture],'Actual native pnpm payload differs')
        package=json.load(source.extractfile('package/package.json'));require(package['name']=='@pnpm/exe.linux-'+{'amd64':'x64','arm64':'arm64'}[architecture]and package['version']=='12.3.0'and package['os']==['linux']and package['libc']==['glibc'],'pnpm platform manifest differs')
    return body


def build_commands(repo,tools,stage,original):
    a=assets();a.cli_source(repo);require(tuple(a.PACKAGE_ROOTS[:-1])==tuple(original['packages']),'Existing22-package build order changed')
    rows=[dict(row,argv=list(row['argv']),extra_environment=dict(row['extra_environment']))for row in original['commands']];require(rows[0]['name']=='locked-ignore-scripts-install','Original package install command required')
    # Keep the normal frozen/config spelling actually exercised by the SDK job.
    argv=rows[0]['argv'];require(argv.count('--config.cache-dir='+str(stage/'cache'))==1,'Original scoped cache differs');i=argv.index('install');argv[i:i]=['--filter','@hyperlane-xyz/cli...'];argv+=['--config.fetch-timeout=30000','--config.child-concurrency=1','--config.network-concurrency=1'];rows[0]['argv']=argv
    rows.append({'name':'tron-full-cli-original-tsconfig','cwd':str(repo/'typescript/cli'),'argv':[str(tools['pnpm']),'exec','tsc','--project','tsconfig.json'],'extra_environment':{}})
    return rows


def compiler_outputs(repo):
    a=assets();result={}
    for label,relative,version in [('EVM','solidity/artifacts/build-info','0.8.33'),('TVM','solidity/artifacts-tron/build-info','0.8.24')]:
        files=sorted((repo/relative).glob('*.json'));require(0<len(files)<=64,'Actual both compiler build-info outputs required');rows=[]
        for path in files:
            require(path.is_file()and not path.is_symlink()and path.stat().st_size<=256*1024**2,'Bounded real compiler metadata required');value=json.loads(path.read_text());require(value.get('solcVersion')==version and bool(value.get('input',{}).get('sources'))and bool(value.get('output',{}).get('contracts')),'Compiler version or actual contracts differ: '+label);rows.append(a.pin(path))
        result[label]={'version':version,'actual_build_info':rows}
    return result


def publish_graph(repo,architecture,audit_path,image_path,output):
    a=assets();a.cli_source(repo);audit=json.loads(audit_path.read_text());require(audit['passed']is True and audit['missing']==[]and audit['opaque']==[]and audit['tronDynamic']is True and audit['actualTVMFactories']is True and audit['entry']==str(repo/'typescript/cli/dist/cli.js'),'Actual full original CLI static import/export resolution required')
    require(audit['files']and all(Path(r['path']).is_relative_to(repo)and a.pin(Path(r['path']))==r for r in audit['files']),'Static module byte closure changed')
    value=a.graph(repo,list(a.PACKAGE_ROOTS),architecture)
    for edge in audit['edges']:
        if not edge.get('builtin'):require(str(Path(edge['canonical']).relative_to(repo))in value['entries'],'Resolved internal/external module or JSON/data missing from full owned graph')
    require(not output.exists()and not output.is_symlink(),'New full Linux package graph manifest required')
    with output.open('x')as stream:json.dump(value,stream,sort_keys=True);stream.write('\n')
    return {'schema':1,'passed':True,'graph':a.pin(output),'static_import_audit':a.pin(audit_path),'compiler_outputs':compiler_outputs(repo),'image_readback':a.pin(image_path),'SDK_or_CLI_evaluated':False,'native_case_acceptance':False}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--admit-pnpm',action='store_true');parser.add_argument('--publish-graph',action='store_true');parser.add_argument('--architecture',choices=['amd64','arm64'],required=True);parser.add_argument('--archive',type=Path);parser.add_argument('--repo',type=Path);parser.add_argument('--audit',type=Path);parser.add_argument('--image-readback',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();a=assets()
    require(args.admit_pnpm!=args.publish_graph,'One explicit setup-only operation required')
    if args.admit_pnpm:
        require(args.archive.is_file()and not args.archive.is_symlink()and not args.output.exists()and not args.output.is_symlink(),'New actual native pnpm output required');body=pnpm_member(args.archive.read_bytes(),args.architecture)
        with args.output.open('xb')as stream:stream.write(body)
        args.output.chmod(0o755);print(json.dumps({'admitted':a.pin(args.output),'native_executed':False}));return
    print(json.dumps(publish_graph(args.repo,args.architecture,args.audit,args.image_readback,args.output),sort_keys=True))
if __name__=='__main__':main()
