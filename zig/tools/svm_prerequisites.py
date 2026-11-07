#!/usr/bin/env python3
"""Linux-only SVM prerequisite production. No chain, fixture or agent execution."""
import argparse,ctypes,hashlib,json,os,pathlib,posixpath,re,shutil,signal,stat,struct,subprocess,sys,tarfile,time,tomllib,urllib.request
P=pathlib.Path
GIB=1024**3
PROGRAMS=['mailbox','validator-announce','ism/multisig-ism-message-id','ism/composite-ism','hyperlane-sealevel-token','hyperlane-sealevel-token-native','hyperlane-sealevel-token-collateral','hyperlane-sealevel-token-cross-collateral','hyperlane-sealevel-igp']
SPL=['spl_token.so','spl_token_2022.so','spl_associated_token_account.so','spl_noop.so']
# Pinned Linux v1.51 publisher defects: optional LLDB Python helpers point outside
# the published llvm/ subtree to absent root lib/ and bin/. Keep every compiler
# input unchanged; omit only these exact unusable debugger links, with a receipt.
PLATFORM_UNUSED_DANGLING_LINKS={
 'llvm/lib/python3.10/dist-packages/lldb/_lldb.cpython-310-x86_64-linux-gnu.so':'../../../../../lib/liblldb.so',
 'llvm/lib/python3.10/dist-packages/lldb/lldb-argdumper':'../../../../../bin/lldb-argdumper',
}
ASSETS={
 'agave':{'url':'https://github.com/anza-xyz/agave/releases/download/v3.0.14/solana-release-x86_64-unknown-linux-gnu.tar.bz2','asset_id':338693012,'bytes':214232615,'sha256':('65614325423316a48f57f1ceeaa91ca7' '8f4516e165e305b38c01873cf8c6b8b4'),'publisher_digest':True},
 'platform':{'url':'https://github.com/anza-xyz/platform-tools/releases/download/v1.51/platform-tools-linux-x86_64.tar.bz2','asset_id':279991627,'bytes':542447828,'sha256':('0933e05dd964826e8e2db5c58c34ae25' '5e3baf0ce1711568552dca81b5407a6b'),'publisher_digest':True},
 'spl':{'url':'https://github.com/hyperlane-xyz/solana-program-library/releases/download/2024-08-23/spl.tar.gz','asset_id':187913462,'bytes':245817,'sha256':('5a0862a76357316707a2056d810729ab' '563aded8b6c094a90fa204ef0fa2c415'),'publisher_digest':False}}
def need(ok,msg):
 if not ok:raise ValueError(msg)
def write(p,value):
 with P(p).open('x')as f:json.dump(value,f,indent=2);f.write('\n')
def pin(p):
 p=P(p);s=p.lstat();need(stat.S_ISREG(s.st_mode)and s.st_nlink==1,'regular nlink1 required: '+str(p))
 with p.open('rb')as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 return {'path':str(p),'bytes':s.st_size,'sha256':h}
def system_pin(p):
 p=P(p).resolve();s=p.stat();need(stat.S_ISREG(s.st_mode),'regular resolved system tool required')
 with p.open('rb')as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 return {'path':str(p),'bytes':s.st_size,'sha256':h}
def safe_name(name):
 p=pathlib.PurePosixPath(name);need(name and not p.is_absolute()and '..'not in p.parts and '\\'not in name and '\x00'not in name,'unsafe archive member')
 return str(p)
def safe_link(name,target):
 need(target and not target.startswith('/')and '\\'not in target and '\x00'not in target,'unsafe symlink')
 joined=posixpath.normpath(posixpath.join(posixpath.dirname(name),target));need(joined!='..'and not joined.startswith('../'),'escaped symlink');return joined
def inventory(root,hashes=True):
 root=P(root);rows={};stack=[root];started=time.monotonic()
 while stack:
  parent=stack.pop()
  for p in parent.iterdir():
   try:s=p.lstat()
   except FileNotFoundError:continue
   name=p.relative_to(root).as_posix();row={'mode':stat.S_IMODE(s.st_mode)}
   if stat.S_ISLNK(s.st_mode):
    target=os.readlink(p);safe_link(name,target);need(p.resolve().is_relative_to(root.resolve()),'external symlink');row.update(type='symlink',target=target)
   elif stat.S_ISDIR(s.st_mode):row['type']='directory';stack.append(p)
   else:
    need(stat.S_ISREG(s.st_mode)and s.st_nlink==1,'special/hardlinked input');row.update(type='file',bytes=s.st_size)
    if hashes:row['sha256']=pin(p)['sha256']
   rows[name]=row
   need(len(rows)<=500000,'inventory entry cap')
   if not hashes:need(time.monotonic()-started<3,'allocated census exceeded3s')
 return dict(sorted(rows.items()))
def allocated(root):
 total=0;stack=[P(root)];started=time.monotonic();count=0
 while stack:
  for p in stack.pop().iterdir():
   try:s=p.lstat()
   except FileNotFoundError:continue
   total+=s.st_blocks*512;count+=1
   if stat.S_ISDIR(s.st_mode):stack.append(p)
   need(count<=500000 and time.monotonic()-started<3,'allocated census exceeded3s/500k')
 return total
def extract(archive,dest,tick,*,platform_asset=None):
 omitted_symlinks={}
 if platform_asset is not None:
  need(platform_asset==ASSETS['platform'],'wrong pinned Linux platform asset')
  tick();actual=pin(archive);tick()
  need(actual['bytes']==platform_asset['bytes']and actual['sha256']==platform_asset['sha256'],'wrong pinned Linux platform archive bytes/digest')
  omitted_symlinks=PLATFORM_UNUSED_DANGLING_LINKS
 omitted=set()
 dest=P(dest);dest.mkdir();seen=set();expanded=0;directory_modes={}
 with tarfile.open(archive,'r:*')as t:
  for m in t:
   name=safe_name(m.name)
   if name=='.':need(m.isdir(),'invalid archive root');continue
   need(name not in seen,'duplicate archive member');need(m.mode&0o7000==0,'special permission bits');seen.add(name);need(len(seen)<=25000,'archive entry cap')
   if name in omitted_symlinks:
    need(m.issym()and m.linkname==omitted_symlinks[name],'omitted debugger link identity differs');safe_link(name,m.linkname);omitted.add(name);tick();continue
   out=dest/name
   need(not any(p.is_symlink()for p in [out,*out.parents]if p.is_relative_to(dest)),'symlink archive parent')
   out.parent.mkdir(parents=True,exist_ok=True)
   if m.isdir():out.mkdir(exist_ok=True);directory_modes[name]=m.mode&0o777
   elif m.issym():safe_link(name,m.linkname);out.symlink_to(m.linkname)
   else:
    need(m.isfile()and not m.islnk()and m.size>=0,'special/hardlink archive member');expanded+=m.size;need(expanded<=4*GIB,'archive expanded cap4GiB')
    source=t.extractfile(m);need(source is not None,'missing member stream')
    with out.open('xb')as f:
     while chunk:=source.read(1024*1024):f.write(chunk);tick()
    need(out.stat().st_size==m.size,'truncated member');out.chmod(m.mode&0o777)
   tick()
 need(omitted==set(omitted_symlinks),'expected omitted debugger link missing')
 for name,mode in sorted(directory_modes.items(),key=lambda row:row[0].count('/'),reverse=True):(dest/name).chmod(mode)
 result=inventory(dest);need(all((dest/n).resolve(strict=True).is_relative_to(dest.resolve())for n,r in result.items()if r['type']=='symlink'),'dangling/escaping symlink')
 return result

def proc(pid):
 try:
  raw=P('/proc',str(pid),'stat').read_text();tail=raw[raw.rfind(')')+2:].split();return {'pid':pid,'start':int(tail[19]),'ppid':int(tail[1]),'group':int(tail[2]),'session':int(tail[3]),'state':tail[0],'rss':int(tail[21])*os.sysconf('SC_PAGE_SIZE')}
 except(FileNotFoundError,ProcessLookupError):return None

def elf(path,machine):
 with P(path).open('rb')as f:b=f.read(64)
 need(len(b)==64 and b[:6]==b'\x7fELF\x02\x01'and struct.unpack_from('<H',b,18)[0]==machine,'wrong ELF class/endian/machine')
 return dict(pin(path),elf_class=64,elf_machine=machine)

class OfficialRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  need(newurl.startswith(('https://github.com/','https://release-assets.githubusercontent.com/','https://objects.githubusercontent.com/','https://api.github.com/')),'nonofficial redirect')
  return super().redirect_request(req,fp,code,msg,headers,newurl)

def owned_closure(snapshot,known,owner):
 roots={pid for pid,row in known.items()if snapshot.get(pid,{}).get('start')==row['start']};changed=True
 while changed:
  changed=False
  for pid,row in snapshot.items():
   if pid not in roots and(row['ppid']in roots or row['ppid']==owner):roots.add(pid);changed=True
 return roots

def prune_finished(known,snapshot,close):
 for pid,row in list(known.items()):
  if snapshot.get(pid,{}).get('start')!=row['start']:
   close(row['fd']);del known[pid]

class Owner:
 def __init__(self,root,repo,bwrap):
  self.root=root;self.repo=repo;self.bwrap=bwrap;self.started=time.monotonic();self.deadline=self.started+10800;self.rows=[];self.known={};self.history=[];self.orphan_waits=[];self.signals=[];self.child=None;self.peak=0;self.disk=0;self.peakdisk=0;self.floor=2**63;self.lastdisk=0
  self.logs=root/'logs';self.logs.mkdir();self.events=(root/'observations.jsonl').open('x');self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),OfficialRedirect());need(ctypes.CDLL(None).prctl(36,1,0,0,0)==0,'subreaper unavailable')
 def discover(self):
  snapshot={}
  for p in P('/proc').iterdir():
   if p.name.isdigit():
    row=proc(int(p.name))
    if row:snapshot[row['pid']]=row
  prune_finished(self.known,snapshot,os.close)
  roots=owned_closure(snapshot,self.known,os.getpid())
  for pid in roots:
   row=snapshot[pid]
   if pid not in self.known or self.known[pid]['start']!=row['start']:
    try:fd=os.pidfd_open(pid)
    except ProcessLookupError:continue
    live=proc(pid)
    if live and live['start']==row['start']:
     if pid in self.known:os.close(self.known[pid]['fd'])
     self.known[pid]=dict(row,fd=fd);self.history.append(row)
    else:os.close(fd)
  return [snapshot[p]for p,r in self.known.items()if snapshot.get(p,{}).get('start')==r['start']]
 def tick(self,force=False):
  live=self.discover();rss=sum(r['rss']for r in live)+(proc(os.getpid())or{}).get('rss',0);self.peak=max(self.peak,rss);free=shutil.disk_usage(self.root).free;self.floor=min(self.floor,free)
  if force or time.monotonic()-self.lastdisk>=5:self.disk=allocated(self.root);self.peakdisk=max(self.peakdisk,self.disk);self.lastdisk=time.monotonic()
  self.events.write(json.dumps(dict(elapsed=time.monotonic()-self.started,rss=rss,allocated=self.disk,free=free,owned=[{k:r[k]for k in ['pid','start','group','state']}for r in live]))+'\n');self.events.flush()
  need(time.monotonic()<self.deadline,'whole180m deadline');need(rss<=12*GIB,'owned12GiB RSS');need(self.disk<=24*GIB,'new24GiB disk');need(free>=6*GIB,'free6GiB floor')
  return live
 def reap_terminal(self,where):
  for row in self.discover():
   if row['state']not in ['Z','X']or row['ppid']!=os.getpid():continue
   # Direct Popen wait belongs exclusively to Popen; adopted orphans only here.
   if self.child and row['pid']==self.child.pid:continue
   try:pid,status=os.waitpid(row['pid'],os.WNOHANG)
   except ChildProcessError:continue
   if pid:self.orphan_waits.append({'pid':pid,'start':row['start'],'where':where,'raw_wait_status':status,'exit_code':os.waitstatus_to_exitcode(status),'actual_wait_observed':True,'preceded_by_owner_signal':any(r['pid']==pid and r['start']==row['start']for r in self.signals)})
  return self.discover()
 def drain(self):
  # Only captured pidfds signal exact processes; no session-based foreign capture.
  for sig,budget in [(signal.SIGINT,8),(signal.SIGTERM,5),(signal.SIGKILL,5)]:
   live=self.reap_terminal('drain-before-signal')
   for row in live:
    if row['state']in ['Z','X']:continue
    try:
     signal.pidfd_send_signal(self.known[row['pid']]['fd'],sig);self.signals.append({'pid':row['pid'],'start':row['start'],'signal':int(sig)})
    except ProcessLookupError:pass
   end=time.monotonic()+budget
   while time.monotonic()<end:
    if self.child:self.child.poll()
    if not self.reap_terminal('drain-after-signal'):return
    time.sleep(.1)
  need(not self.discover(),'owned descendants remain after drain')
 def run(self,name,argv,cwd,env):
  self.tick(True)
  if not name.startswith('compile.'):argv=compile_command(self.bwrap,self.root,self.repo,argv,cwd,offline=False)
  start=time.monotonic();row=dict(name=name,argv=list(map(str,argv)),cwd=str(cwd),phase='compile_offline'if name.startswith('compile.')else'provision',started=time.time(),actual_wait_observed=False,exit_code=None);self.rows.append(row)
  out=self.logs/(name+'.stdout');err=self.logs/(name+'.stderr')
  with out.open('xb')as o,err.open('xb')as e:
   try:
    self.child=subprocess.Popen(list(map(str,argv)),cwd=cwd,env=env,stdout=o,stderr=e,start_new_session=True)
    identity=proc(self.child.pid);need(identity is not None,'child identity disappeared before capture');fd=os.pidfd_open(self.child.pid);need((proc(self.child.pid)or{}).get('start')==identity['start'],'child start changed');self.known[self.child.pid]=dict(identity,fd=fd);self.history.append(identity);row['child']=identity
    while self.child.poll()is None:
     self.tick();need(out.stat().st_size+err.stat().st_size<=32*1024**2,'command log32MiB cap');time.sleep(1)
    row.update(exit_code=self.child.wait(),actual_wait_observed=True)
    # A direct exit cannot release surviving/orphan descendants into next phase.
    need(not self.reap_terminal('normal:'+name),'owned child exited leaving live descendants')
    need(row['exit_code']==0,'command failed: '+name)
   except BaseException:
    self.drain()
    if self.child:row.update(exit_code=self.child.wait(),actual_wait_observed=True)
    raise
   finally:
    row['elapsed_seconds_diagnostic_not_benchmark']=time.monotonic()-start;row['stdout']=pin(out);row['stderr']=pin(err);self.child=None
  return out
 def fetch(self,url,dest,limit,expected=None,*,accept='application/octet-stream'):
  need(url.startswith('https://'),'HTTPS required');request=urllib.request.Request(url,headers={'User-Agent':'hyperlane-svm-ci-prerequisites','Accept':accept})
  with self.opener.open(request,timeout=30)as response:
   need(response.url.startswith(('https://github.com/','https://release-assets.githubusercontent.com/','https://objects.githubusercontent.com/','https://api.github.com/')),'nonofficial redirect')
   with dest.open('xb')as f:
    total=0
    while b:=response.read(1024*1024):
     total+=len(b);need(total<=limit,'download size bound');f.write(b);self.tick()
  row=dict(pin(dest),actual_response_url=response.url,headers={k:response.headers[k]for k in ['Date','ETag','Content-Length']if k in response.headers})
  if expected:need(row['bytes']==expected['bytes']and row['sha256']==expected['sha256'],'asset size/SHA mismatch')
  return row

def compile_command(bwrap,root,repo,argv,cwd,offline=True):
 cmd=[bwrap,'--die-with-parent']+(['--unshare-net']if offline else[])+['--ro-bind','/','/','--bind',str(root),str(root)]
 for name in (['assets','spl-source','rustup','build-sdk']if offline else[]):
  cmd+=['--ro-bind',str(root/name),str(root/name)]
 for name in (['registry','git']if offline else[]):
  p=root/'cargo'/name
  if p.exists():cmd+=['--ro-bind',str(p),str(p)]
 cmd+=['--ro-bind',str(repo),str(repo),'--tmpfs','/tmp','--proc','/proc','--dev','/dev','--chdir',str(cwd),'--',*map(str,argv)]
 return cmd

def cargo_binary(log,package,name,expected):
 found=[]
 for line in log.read_text().splitlines():
  if line.startswith('{'):
   row=json.loads(line)
   if row.get('reason')=='compiler-artifact'and row['target']['name']==name and 'bin'in row['target']['kind']and row.get('executable'):found.append(row)
 need(len(found)==1 and P(found[0]['executable'])==expected and (found[0]['package_id'].startswith(package+' ')or found[0]['package_id'].rsplit('#',1)[-1].startswith(package+'@')),'Cargo product binding mismatch');return found[0]

def source_row(repo,name):
 safe_name(name);p=repo/name
 if p.is_symlink():
  need(p.resolve(strict=True).is_relative_to(repo),'Source symlink escapes checkout');return {'path':str(p),'type':'symlink','target':os.readlink(p)}
 return pin(p)

def final_acceptance(status):
 rows=status.get('commands')
 return (status.get('passed') is True and status.get('error','MISSING') is None
  and status.get('Source_unchanged') is True and status.get('owned_absent') is True
  and status.get('actual_owner_signals')==[] and isinstance(rows,list) and bool(rows)
  and all(isinstance(row,dict)and row.get('actual_wait_observed') is True
   and type(row.get('exit_code'))is int and row['exit_code']==0 for row in rows))

def execute(a):
 need(sys.platform=='linux'and os.uname().machine=='x86_64','Linux x86_64 only');repo=a.repo.resolve();root=a.output.absolute();need(a.output.is_absolute()and root==root.resolve()and '..'not in root.parts,'canonical absolute output required');need(root.parent.is_dir()and not root.exists()and not root.is_symlink(),'exclusive output required');need(shutil.disk_usage(root.parent).free>=40*GIB,'40GiB staged-free admission')
 root.mkdir(mode=0o700)
 for sig in [signal.SIGINT,signal.SIGTERM]:signal.signal(sig,lambda signum,frame:(_ for _ in ()).throw(KeyboardInterrupt('owner interrupted')))
 o=Owner(root,repo,a.bwrap);status=dict(passed=False,component_only=True,native_case_credit=False,linux_profile_admitted=False,performance_credit=False,commands=o.rows);before=None;error=None
 base={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'CARGO_HOME':str(root/'cargo'),'RUSTUP_HOME':str(root/'rustup'),'TMPDIR':str(root/'tmp'),'CARGO_BUILD_JOBS':'2','CARGO_NET_RETRY':'0','CARGO_NET_GIT_FETCH_WITH_CLI':'true','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','RUSTUP_AUTO_INSTALL':'0','LC_ALL':'C.UTF-8'}
 for n in ['home','cargo','rustup','tmp','assets','published','targets','tools']:(root/n).mkdir()
 try:
  status['host']={'uname':list(os.uname()),'boot_id':P('/proc/sys/kernel/random/boot_id').read_text().strip()};status['system_tools']={name:system_pin(P(name).resolve())for name in [a.bwrap,'/usr/bin/git','/usr/bin/clang','/usr/bin/cc']};o.run('provision.dpkg-readback',['/usr/bin/dpkg-query','-W'],root,base)
  head=o.run('provision.source-head',['/usr/bin/git','rev-parse','HEAD'],repo,base).read_text().strip();need(re.fullmatch('[0-9a-f]{40}',head)is not None,'invalid checkout commit');status['checkout_commit']=head
  clean=o.run('provision.source-status',['/usr/bin/git','status','--porcelain=v1','--untracked-files=no'],repo,base).read_bytes();need(not clean,'tracked Source is dirty before provisioning')
  listing=o.run('provision.source-files',['/usr/bin/git','ls-files','-z','--recurse-submodules'],repo,base).read_bytes();names=[n.decode()for n in listing.split(b'\0')if n];need(len(names)==len(set(names)),'duplicate tracked Source');before={n:source_row(repo,n)for n in names};write(root/'source-before.json',before)
  original=(repo/'rust/main/utils/run-locally/src/sealevel/solana.rs').read_text();array=re.search(r'const SOLANA_HYPERLANE_PROGRAMS:.*?=\s*&\[(.*?)\];',original,re.S);need(array is not None and re.findall(r'"([^"]+)"',array.group(1))==PROGRAMS,'Source nine-program order differs')
  need(tomllib.loads((repo/'rust/sealevel/rust-toolchain').read_text())['toolchain']['channel']=='1.86.0','Source host toolchain differs')
  rustup=root/'tools/rustup';shutil.copyfile(a.rustup.resolve(),rustup);rustup.chmod(0o700);status['rustup_tool']=pin(rustup)
  for version in ['1.86.0','1.76.0']:o.run('provision.rust-'+version,[rustup,'toolchain','install',version,'--profile','minimal','--no-self-update'],root,base)
  tool={}
  for version in ['1.86.0','1.76.0']:
   out=o.run('provision.cargo-path-'+version,[rustup,'which','--toolchain',version,'cargo'],root,base);path=P(out.read_text().strip());need(path.is_relative_to(root/'rustup')and path.is_file(),'toolchain escaped');tool[version]=path;status['cargo_'+version]=pin(path)
  for name,asset in ASSETS.items():
   archive=root/'assets'/(name+'.tar');status[name+'_archive']=dict(o.fetch(asset['url'],archive,asset['bytes'],asset),**{k:asset[k]for k in ['url','asset_id','publisher_digest']});dest=root/'assets'/name
   omissions=PLATFORM_UNUSED_DANGLING_LINKS if name=='platform'else{}
   members=extract(archive,dest,o.tick,platform_asset=asset if name=='platform'else None);write(root/'published'/(name+'-publisher-members.json'),members)
   if omissions:
    status['platform_debugger_link_omissions']={'archive_sha256':asset['sha256'],'publisher_byte_equivalent_extraction':False,'omitted_symlinks':omissions,'reason':'Two exact unused publisher LLDB Python links are dangling; retained extraction remains closed.'}
    write(root/'published/platform-debugger-link-omissions.json',status['platform_debugger_link_omissions'])
  def unique(parent,suffix):
   matches=[p for p in parent.rglob(P(suffix).name)if p.is_file()and str(p).endswith('/'+suffix)];need(len(matches)==1,'ambiguous/missing '+suffix);return matches[0]
  agave=unique(root/'assets/agave','bin/cargo-build-sbf').parent.parent;platform=unique(root/'assets/platform','rust/bin/rustc').parent.parent.parent;original_sdk=agave/'bin/platform-tools-sdk/sbf';need(original_sdk.is_dir(),'Agave SBF SDK absent');sdk=root/'build-sdk';shutil.copytree(original_sdk,sdk,symlinks=True)
  dependency=sdk/'dependencies/platform-tools';need(not dependency.exists()and not dependency.is_symlink(),'unexpected preexisting platform dependency');dependency.parent.mkdir(exist_ok=True);dependency.symlink_to(platform)
  cache=root/'home/.cache/solana/v1.51';cache.mkdir(parents=True);(cache/'platform-tools').symlink_to(platform)
  write(root/'published/platform-linkage.json',{'sdk':str(sdk),'target':str(platform),'links':[str(dependency),str(cache/'platform-tools')]})
  source_meta=o.fetch('https://api.github.com/repos/hyperlane-xyz/solana-program-library/commits/e101cca',root/'published/custom-spl-commit.json',2*1024**2,accept='application/vnd.github+json');commit=json.loads(P(source_meta['path']).read_text());sha=commit['sha'];tree=commit['commit']['tree']['sha'];need(len(sha)==40 and sha.startswith('e101cca')and len(tree)==40,'wrong custom SPL immutable ref')
  fork=root/'spl-source';fork.mkdir();git=['/usr/bin/git','-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never']
  for name,args in [('init',['init']),('remote',['remote','add','origin','https://github.com/hyperlane-xyz/solana-program-library']),('fetch',['fetch','--depth','1','origin',sha]),('checkout',['checkout','--detach','FETCH_HEAD'])]:o.run('provision.spl-git-'+name,git+args,fork,base)
  readtree=o.run('provision.spl-tree',git+['rev-parse','HEAD^{tree}'],fork,base).read_text().strip();need(readtree==tree,'SPL Git tree differs official metadata');write(root/'published/custom-spl-source-map.json',inventory(fork))
  crates=[]
  for p in fork.rglob('Cargo.toml'):
   obj=tomllib.loads(p.read_text())
   if obj.get('package',{}).get('name')=='spl-token-cli':crates.append(p)
  need(len(crates)==1,'exact spl-token-cli package required');spl_manifest=crates[0];spl_toml=tomllib.loads(spl_manifest.read_text());need(any(b['name']=='spl-token'for b in spl_toml.get('bin',[])),'Source custom SPL bin absent')
  locks=[repo/'rust/sealevel/Cargo.lock',fork/'Cargo.lock'];lockpins=[pin(p)for p in locks];write(root/'published/locks-before.json',lockpins)
  for name,version,manifest in [('sealevel','1.86.0',repo/'rust/sealevel/Cargo.toml'),('spl','1.76.0',spl_manifest)]:o.run('provision.fetch-'+name,[tool[version],'fetch','--locked','--manifest-path',manifest],manifest.parent,{**base,'RUSTUP_TOOLCHAIN':version,'PATH':str(tool[version].parent)+':/usr/bin:/bin'})
  need([pin(p)for p in locks]==lockpins,'provision changed committed lock');compiler_inputs={n:inventory(root/n)for n in ['assets','spl-source','rustup','build-sdk']};write(root/'published/compiler-inputs-before.json',compiler_inputs)
  for version,cargo in tool.items():o.run('provision.compiler-version-'+version,[cargo.parent/'rustc','--version','--verbose'],root,base)
  version_log=o.run('provision.platform-rust-version',[platform/'rust/bin/rustc','--version','--verbose'],root,base);need(version_log.read_text().startswith('rustc 1.84.1'),'pinned platform Rust version differs')
  outdir=root/'targets/programs';outdir.mkdir();expected=[];sbf_env={**base,'CARGO_NET_OFFLINE':'true','RUSTC':str(platform/'rust/bin/rustc'),'RUSTDOC':str(platform/'rust/bin/rustdoc'),'PATH':str(platform/'rust/bin')+':/usr/bin:/bin'}
  for index,name in enumerate(PROGRAMS):
   cwd=repo/'rust/sealevel/programs'/name;obj=tomllib.loads((cwd/'Cargo.toml').read_text());library=obj.get('lib',{}).get('name',obj['package']['name'].replace('-','_'));expected.append(library+'.so')
   argv=[agave/'bin/cargo-build-sbf','--sbf-sdk',sdk,'--sbf-out-dir',outdir,'--tools-version','v1.51','--skip-tools-install','--no-rustup-override','--offline','--jobs','2','--','--frozen','--target-dir',root/'targets/sbf']
   o.run('compile.sbf-'+str(index),compile_command(a.bwrap,root,repo,argv,cwd),cwd,sbf_env);elf(outdir/expected[-1],247)
  for name in SPL:shutil.copyfile(unique(root/'assets/spl',name),outdir/name);(outdir/name).chmod(0o600)
  need({p.name for p in outdir.glob('*.so')}==set(expected+SPL),'closed13 SO membership differs')
  export=root/'published/programs';export.mkdir()
  for name in expected+SPL:shutil.copyfile(outdir/name,export/name);(export/name).chmod(0o600)
  products={'programs':{p.name:elf(p,247)for p in export.iterdir()}}
  for name,version,manifest,package,binary,profile in [('client','1.86.0',repo/'rust/sealevel/Cargo.toml','hyperlane-sealevel-client','hyperlane-sealevel-client','debug'),('spl','1.76.0',spl_manifest,'spl-token-cli','spl-token','release')]:
   target=root/'targets'/name;argv=[tool[version],'build','--frozen','--offline','--manifest-path',manifest,'--package',package,'--bin',binary,'--target-dir',target,'-j','2','--message-format=json-render-diagnostics']
   if profile=='release':argv.append('--release')
   env={**base,'CARGO_NET_OFFLINE':'true','PATH':str(tool[version].parent)+':/usr/bin:/bin','RUSTUP_TOOLCHAIN':version}
   log=o.run('compile.'+name,compile_command(a.bwrap,root,repo,argv,manifest.parent),manifest.parent,env);actual=target/profile/binary;artifact=cargo_binary(log,package,binary,actual);dest=root/'published'/binary;shutil.copyfile(actual,dest);dest.chmod(0o700);products[name]=elf(dest,62);write(root/'published'/(name+'-cargo-artifact.json'),artifact)
  need([pin(p)for p in locks]==lockpins,'compiler changed lock');need({n:inventory(root/n)for n in compiler_inputs}==compiler_inputs,'compiler changed asset/tool/source input')
  shutil.copytree(agave,root/'published/agave',symlinks=True);write(root/'published/agave-linux-runtime-members.json',inventory(root/'published/agave'))
  write(root/'published/linux-profile.CANDIDATE.json',{'schema':1,'platform':'linux-x86_64','Root_approved':False,'native_case_admitted':False,'Darwin_profile_not_reused':True,'agave_archive':status['agave_archive'],'platform_archive':status['platform_archive'],'spl_archive':status['spl_archive'],'agave_member_manifest':pin(root/'published/agave-linux-runtime-members.json'),'agave_file_count':sum(row['type']=='file'for row in inventory(root/'published/agave').values()),'platform_member_manifest':pin(root/'published/platform-publisher-members.json'),'platform_debugger_link_omissions':pin(root/'published/platform-debugger-link-omissions.json'),'custom_spl_commit':sha,'custom_spl_tree':tree,'program_count':13,'products':products})
  o.tick(True)
  write(root/'published/products.json',products);status.update(passed=True,products=products,linux_profile_admitted=False,linux_profile_review_required=True,custom_spl_commit=sha,custom_spl_tree=tree)
 except BaseException as exc:error=type(exc).__name__+': '+str(exc)
 finally:
  try:o.drain()
  except BaseException as exc:error=(error+'; 'if error else'')+'drain: '+str(exc);status['passed']=False
  if before is not None:
   try:
    after={n:source_row(repo,n)for n in before};status['Source_unchanged']=after==before
    if after!=before:raise ValueError('Source changed')
   except BaseException as exc:status['Source_unchanged']=False;status['passed']=False;error=(error+'; 'if error else'')+'postflight: '+str(exc)
  status.update(error=error,actual_owned_identities=[{k:v[k]for k in ['pid','start','ppid','group','session']}for v in o.history],owned_absent=not o.reap_terminal('final'),actual_orphan_waits=o.orphan_waits,actual_owner_signals=o.signals,forced_cleanup=bool(o.signals),peak_owned_RSS=o.peak,peak_new_disk=o.peakdisk,minimum_free=o.floor,elapsed_seconds_diagnostic_not_benchmark=time.monotonic()-o.started,compile_measurement_scope='No formal cold benchmark; downloads/fetch/toolchain setup have provision phase labels.')
  status['passed']=final_acceptance(status)
  o.events.close();write(root/'result.json',status)
 return 0 if status['passed']else 1

def main():
 p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');p.add_argument('--repo',type=P,required=True);p.add_argument('--output',type=P,required=True);p.add_argument('--rustup',type=P,required=True);p.add_argument('--bwrap',default='/usr/bin/bwrap');a=p.parse_args();need(a.execute,'inert without --execute');return execute(a)
if __name__=='__main__':sys.exit(main())
