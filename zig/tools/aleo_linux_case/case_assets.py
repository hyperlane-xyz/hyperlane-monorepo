"""Acquisition-only exact nine public parameters. Never used by the proof jail."""
import argparse
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import ssl
import sys
import time
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
for code_root in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
    if(code_root/'__pycache__').exists()or(code_root/'__pycache__').is_symlink():raise ValueError('full-case profile forbids cached local Python bytecode')
sys.path.insert(0,str(HERE.parent/'aleo_linux'))
from receipts import checked,load,need
GRANT_SHA=('50edaa4a75ce4657d3c163e5bf644f1f' 'b90e101d5c879acb06f84e3028e87742')


def plan(grant):
    need(type(grant)is dict and len(grant['assets'])==17,'original17 aliases required')
    result={}
    for row in grant['assets']:
        value=row['file'];url=urlsplit(row['url'])
        need(url.scheme=='https'and url.username is None and url.password is None and url.port is None and not url.query and not url.fragment,'closed official HTTPS URI required')
        need(url.hostname in {'parameters.provable.com','s3.us-west-1.amazonaws.com'},'closed publisher hosts required')
        if value['sha256']not in result:result[value['sha256']]={'url':row['url'],'bytes':value['bytes'],'sha256':value['sha256'],'name':Path(value['path']).name}
        else:need(result[value['sha256']]['bytes']==value['bytes'],'conflicting publisher length')
    need(len(result)==9 and sum(row['bytes']for row in result.values())==79506114,'original9 public parameter bytes only')
    return list(result.values())


def acquire(output,source_grant,decoded_grant):
    need(sys.platform=='linux','Linux bounded acquisition entry only')
    need(hashlib.sha256(decoded_grant).hexdigest()==GRANT_SHA,'original accepted publisher grant required')
    from receipts import decode
    grant=decode(decoded_grant,65536);selected=plan(grant)
    need(output.is_absolute()and output.parent.resolve()==output.parent and not output.exists(),'new exclusive public-asset root required')
    need(os.statvfs(output.parent).f_bavail*os.statvfs(output.parent).f_frsize>=6*1024**3+128*1024**2,'free floor plus acquisition headroom required')
    output.mkdir(mode=0o700);directory=output/'.aleo/resources';directory.mkdir(parents=True,mode=0o700)
    grant_path=output/'publisher-grant.json';grant_path.write_bytes(decoded_grant);os.chmod(grant_path,0o600)
    grant_pin={'path':str(grant_path),'bytes':len(decoded_grant),'sha256':GRANT_SHA}
    result={'source_grant':source_grant,'schema':1,'kind':'aleo-linux-public-parameters-v1','passed':False,'grant':grant_pin,'assets':[],'network_is_acquisition_only':True,'proof_credit':False}
    def expired(signum,frame):raise RuntimeError('original600s public asset acquisition deadline')
    old=signal.signal(signal.SIGALRM,expired);start=time.monotonic_ns();deadline=start+600*10**9
    signal.setitimer(signal.ITIMER_REAL,600)
    try:
        physical={}
        for row in selected:
            need(time.monotonic_ns()<deadline,'asset acquisition deadline')
            url=urlsplit(row['url']);connection=http.client.HTTPSConnection(url.hostname,timeout=min(30,(deadline-time.monotonic_ns())/10**9),context=ssl.create_default_context())
            try:
                connection.request('GET',url.path,headers={'Connection':'close','Accept-Encoding':'identity'})
                response=connection.getresponse();need(response.status==200,'publisher returned unexpected status; no redirect/fallback')
                length=response.getheader('Content-Length')
                need(length is None or length==str(row['bytes']),'publisher length differs')
                target=directory/row['name'];digest=hashlib.sha256();count=0
                with target.open('xb')as stream:
                    os.chmod(target,0o600)
                    while True:
                        need(time.monotonic_ns()<deadline,'asset body deadline')
                        chunk=response.read(min(65536,row['bytes']-count+1))
                        if not chunk:break
                        count+=len(chunk);need(count<=row['bytes'],'publisher body exceeded exact bytes');digest.update(chunk);stream.write(chunk)
                        floor=os.statvfs(output);need(floor.f_bavail*floor.f_frsize>=6*1024**3,'continuous free6GiB floor')
                    stream.flush();os.fsync(stream.fileno())
                need(count==row['bytes']and digest.hexdigest()==row['sha256'],'publisher payload hash/length differs')
                physical[row['sha256']]={'path':str(target),'bytes':count,'sha256':digest.hexdigest()}
            finally:connection.close()
        result['assets']=[{'url':row['url'],'file':physical[row['file']['sha256']]}for row in grant['assets']]
        need(time.monotonic_ns()<=deadline,'final asset hashing/publication deadline')
        checked(source_grant);checked(grant_pin);result['passed']=True
    except BaseException as error:result['error_type']=type(error).__name__;result['error']=str(error)
    finally:
        try:
            result['started_monotonic_ns']=start;result['original_deadline_ns']=deadline;result['completed_monotonic_ns']=time.monotonic_ns()
            result['passed']=result['passed']and result['completed_monotonic_ns']<=deadline
            # Keep the original whole-call timer armed through publication.
            with(output/'result.json').open('x')as stream:json.dump(result,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
            need(time.monotonic_ns()<=deadline,'asset result publication exceeded original deadline')
        finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old)
    return 0 if result['passed']else 1


def main():
    p=argparse.ArgumentParser();p.add_argument('--acquire',action='store_true');p.add_argument('--output',type=Path);p.add_argument('--grant',type=Path);p.add_argument('--grant-sha');a=p.parse_args()
    need(a.acquire and a.output and a.grant and a.grant_sha,'inert: explicit public asset acquisition required')
    need(a.grant.resolve(strict=True)==HERE/'closed-cache-assets.json.gz','fixed Source publisher table required')
    raw=a.grant.read_bytes();need(len(raw)<=16384 and hashlib.sha256(raw).hexdigest()==a.grant_sha,'exact compressed Source publisher table required')
    decoded=gzip.decompress(raw);need(len(decoded)<=65536 and hashlib.sha256(decoded).hexdigest()==GRANT_SHA,'exact original decoded publisher table required')
    return acquire(a.output,{'path':str(a.grant),'bytes':len(raw),'sha256':a.grant_sha},decoded)

if __name__=='__main__':raise SystemExit(main())
