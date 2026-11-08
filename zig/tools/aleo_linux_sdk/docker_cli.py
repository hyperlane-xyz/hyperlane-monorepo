#!/usr/bin/python3 -I
"""Fixed Source CLI spelling → bounded local capability API. Never raw Docker."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
# Execute the exact reviewed bytes, never timestamp-selected cached bytecode.
import types
def _reviewed_module(name,path,digest):
    raw=path.read_bytes()
    if path.resolve(strict=True)!=path or any(p.is_symlink()for p in [path,*path.parents])or hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('reviewed CLI dependency changed')
    if name in sys.modules:raise ValueError('foreign preloaded CLI dependency')
    module=types.ModuleType(name);module.__file__=str(path);module.__package__='';sys.modules[name]=module
    try:exec(compile(raw,str(path),'exec'),module.__dict__)
    except BaseException:sys.modules.pop(name,None);raise
    return module
_reviewed_module('receipts',KERNEL/'receipts.py',('a0dbe1ce96080a0f614605673994727a' '85fa946b49632f27e70223a0afe917a6'))
_reviewed_module('docker_gate',HERE/'docker_gate.py',('e2d004c844b7f83db502dd4918e6cdf0' '9eb07b0844885238273a54032657f98a'))
from receipts import decode, need
from docker_gate import container_templates, WholeSocket, operation_deadline


def call(policy, method, path, body=None):
    deadline=operation_deadline(policy['original_deadline_ns'])
    with WholeSocket(deadline) as budget:
        class Connection(http.client.HTTPConnection):
            def connect(self):
                budget.check();self.sock=budget.socket;self.sock.connect(policy['gate_socket'])
        connection=Connection('localhost',timeout=max(.001,(deadline-time.monotonic_ns())/10**9))
        reply=None
        try:
            raw=None if body is None else json.dumps(body,separators=(',',':')).encode()
            connection.putrequest(method,path,skip_host=True,skip_accept_encoding=True)
            connection.putheader('Host','localhost');connection.putheader('Connection','close');connection.putheader('Content-Length',str(0 if raw is None else len(raw)))
            if raw is not None:connection.putheader('Content-Type','application/json')
            connection.endheaders(raw)
            reply=connection.getresponse();data=reply.read(16*1024**2+1)
            need(len(data)<=16*1024**2 and reply.status in {200,201,204,304},'capability API rejected fixed command')
            budget.check()
            return data
        finally:
            if reply is not None:reply.close()
            connection.close()


def mux(raw):
    result=[bytearray(),bytearray()]
    while raw:
        need(len(raw)>=8 and raw[0]in {1,2}and raw[1:4]==b'\0\0\0','malformed Docker output frame')
        size=int.from_bytes(raw[4:8],'big');need(size<=len(raw)-8,'truncated Docker output frame')
        result[raw[0]-1]+=raw[8:8+size];raw=raw[8+size:]
    return bytes(result[0]),bytes(result[1])


def run(policy,args):
    owner=decode(Path(policy['manifest']['taskRoot'],'owner.json').read_bytes(),4096)
    need(owner['marker']=='ziggy-aleo-owned-v1'and owner['pid']==os.getppid()and owner['manifest']==policy['manifest_digest'],'actual direct Source main Node required')
    endpoint='unix://'+policy['gate_socket']
    need(args[:2]==['--host',endpoint]and os.environ.get('DOCKER_HOST')==endpoint,'raw Docker socket or implicit context forbidden')
    config=Path(os.environ['DOCKER_CONFIG']);need(config==Path(policy['manifest']['taskRoot'])/'docker-cli','private Source Docker config required')
    config.mkdir(mode=0o700,exist_ok=True);need(config.resolve()==config,'config alias forbidden')
    for path in config.iterdir():need(path.name=='config.json'and not path.is_symlink()and decode(path.read_bytes(),4096)=={},'Docker auth/config forbidden')
    command=args[2:];need(command,'command required')
    containers=container_templates(policy,owner['pid'])
    if command==['info','--format','{{json .}}']:return call(policy,'GET','/info'),b'',0
    if len(command)==3 and command[:2]==['image','inspect']:
        need(command[2]in {row['reference']for row in containers},'foreign image')
        return call(policy,'GET','/images/'+command[2]+'/json'),b'',0
    if command[0]=='run':
        images=[i for i,arg in enumerate(command)if arg in {row['reference']for row in containers}];need(len(images)==1,'one exact admitted image required')
        index=images[0];before=command[1:index];after=command[index+1:];flags={};i=0
        while i<len(before):
            key=before[i];need(key in {'--detach','--pull=never','--name','--publish','--env','--platform'},'unapproved Source run flag')
            if key in {'--detach','--pull=never'}:flags.setdefault(key,[]).append(True);i+=1
            else:need(i+1<len(before),'flag value missing');flags.setdefault(key,[]).append(before[i+1]);i+=2
        need(flags.get('--detach')==[True]and flags.get('--pull=never')==[True]and len(flags.get('--name',[]))==1,'detached/no-pull/name boundary differs')
        selected=[row for row in containers if row['name']==flags['--name'][0]];need(len(selected)==1,'foreign name');row=selected[0]
        need(command[index]==row['reference']and flags.get('--env')==row['create_body']['Env']and after==([]if row['kind']=='postgres'else row['create_body']['Cmd']),'Source image/environment/command differs')
        if row['kind']=='postgres':need(flags.get('--publish')==['127.0.0.1::5432']and '--platform'not in flags,'Source PG argv differs')
        else:
            port=row['create_body']['HostConfig']['PortBindings']['3030/tcp'][0]['HostPort']
            need(flags.get('--publish')==['127.0.0.1:'+port+':3030']and flags.get('--platform')==['linux/amd64'],'Source node argv differs')
        raw=decode(call(policy,'POST','/containers/create?name='+row['name'],row['create_body']));cid=raw['Id'];need(re.fullmatch('[0-9a-f]{64}',cid),'full created CID required')
        call(policy,'POST','/containers/'+cid+'/start');return (cid+'\n').encode(),b'',0
    if command[0]=='port':
        need(len(command)==3 and command[2]=='5432/tcp','only owned PG port supported')
        row=decode(call(policy,'GET','/containers/'+command[1]+'/json'));need(row['NetworkSettings']['Ports']['5432/tcp']==[{'HostIp':'127.0.0.1','HostPort':'25432'}],'actual exclusive PG port differs')
        return b'127.0.0.1:25432\n',b'',0
    if command[0]=='exec':
        need(len(command)>=3,'exec argv missing');cid=command[1]
        value=decode(call(policy,'POST','/containers/'+cid+'/exec',{'AttachStdout':True,'AttachStderr':True,'Tty':False,'Cmd':command[2:]}));eid=value['Id']
        stdout,stderr=mux(call(policy,'POST','/exec/'+eid+'/start',{'Detach':False,'Tty':False}))
        result=decode(call(policy,'GET','/exec/'+eid+'/json'));need(result['Running']is False and type(result['ExitCode'])is int,'exec has no actual terminal status')
        return stdout,stderr,result['ExitCode']
    if command[:3]==['logs','--tail','10000']and len(command)==4:return (*mux(call(policy,'GET','/containers/'+command[3]+'/logs?stdout=1&stderr=1&tail=10000')),0)
    if command[:3]==['stop','--time','10']and len(command)==4:call(policy,'POST','/containers/'+command[3]+'/stop?t=10');return (command[3]+'\n').encode(),b'',0
    raise ValueError('unapproved Source Docker command')


def main():
    # Parent binds this immutable policy in code_pins and the namespace RO mount;
    # the host gate independently checks the complete request/caps/caller.
    endpoint=os.environ.get('DOCKER_HOST','')
    need(endpoint.startswith('unix:///')and endpoint.endswith('/capabilities/docker.sock'),'explicit owned gate endpoint required')
    socket_path=Path(endpoint[len('unix://'):])
    need(socket_path.parent.resolve()==socket_path.parent,'gate path alias forbidden')
    policy_path=socket_path.parent.parent/'readonly/docker-client-policy.json'
    need(policy_path.resolve()==policy_path and not policy_path.is_symlink(),'RO Source-generated client policy required')
    policy=decode(policy_path.read_bytes())
    need(policy['gate_socket']==str(socket_path),'client policy endpoint differs')
    stdout,stderr,status=run(policy,sys.argv[1:]);sys.stdout.buffer.write(stdout);sys.stderr.buffer.write(stderr);return status


if __name__=='__main__':raise SystemExit(main())
