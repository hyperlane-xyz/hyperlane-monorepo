"""Owned Linux PG16 fixture adapter; no work at import, no daemon timing changes."""
from pathlib import Path
import hashlib
import json
import math
import os
import re
import selectors
import subprocess
import time

GIB=1024**3
IMAGE_ID='sha256:'+'ba07bdb15f0f2ac1ba7a88891da731cae'+'65ac36d663fdb7de8f698ea47e0e381'
IMAGE_REFERENCE='postgres@sha256:'+'43f9275df91e012c3da3d86bea5d7bb5e'+'67a473296cc906c5f9e80b8176b1a37'
POLICY={'schema':1,'platform':'linux/amd64','requested_image':'postgres:16.15','immutable_reference':IMAGE_REFERENCE,'image_id':IMAGE_ID,'PG_version':'16.15-1.pgdg13+2','postgres_uid':999,'postgres_gid':999}
LABEL='io.hyperlane.ziggy.paired-postgres'
TMPFS='rw,nosuid,size=2147483648,uid=999,gid=999'


def require(ok,message):
    if not ok:raise RuntimeError(message)


def boot_id():
    value=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    require(re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',value)is not None,'Linux PG boot identity unavailable')
    return value


def digest(wire):return hashlib.sha256(wire).hexdigest()


def atomic(path,value):
    require(not path.is_symlink(),'PG journal link refused')
    temporary=path.with_suffix('.pending')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'w')as stream:
            json.dump(value,stream,sort_keys=True,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if temporary.exists():temporary.unlink()


class Client:
    """Bounded real clients; aggregate only actual direct waits, never daemon waits."""
    def __init__(self,docker,config):
        require(set(docker)=={'path','bytes','sha256'},'Exact Docker executable pin required')
        executable=Path(docker['path'])
        require(executable.is_absolute()and executable.is_file()and not executable.is_symlink()and os.access(executable,os.X_OK),'Docker executable differs')
        require(executable.stat().st_size==docker['bytes']and digest(executable.read_bytes())==docker['sha256'],'Docker executable changed')
        self.prefix=[str(executable),'--host','unix:///var/run/docker.sock','--config',str(config)]
        self.environment={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'DOCKER_HOST':'unix:///var/run/docker.sock','DOCKER_CONFIG':str(config)}
        self.receipt={'actual_wait_count':0,'failure_count':0,'chain_sha256':digest(b''),'latest':[]}

    def call(self,args,deadline,timeout=180,missing=False,readiness=False):
        start=time.monotonic();end=min(deadline,start+timeout);require(start<end,'PG client original deadline')
        child=None;wire=bytearray();errors=bytearray();error=None;selector=selectors.DefaultSelector();waited=False
        try:
            child=subprocess.Popen(self.prefix+args,env=self.environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=False)
            for name,pipe in [('stdout',child.stdout),('stderr',child.stderr)]:
                os.set_blocking(pipe.fileno(),False);selector.register(pipe,selectors.EVENT_READ,name)
            while selector.get_map():
                remaining=end-time.monotonic();require(remaining>0,'PG client whole-call deadline')
                for key,_ in selector.select(min(.1,remaining)):
                    part=os.read(key.fd,16384)
                    if not part:selector.unregister(key.fileobj)
                    else:
                        require(len(wire)+len(errors)+len(part)<=1024**2,'PG client output bound');(wire if key.data=='stdout'else errors).extend(part)
            code=child.wait(timeout=max(.001,end-time.monotonic()));waited=True
            require(time.monotonic()<=end,'PG client completed late')
            if code!=0:
                absent=(missing and code==1 and args[:2]==['container','inspect']and bytes(errors or wire).decode(errors='replace').strip()in {'Error: No such object: '+args[-1],'Error response from daemon: No such container: '+args[-1]})
                pending=(readiness and code in(1,2,3)and args[:2]==['container','exec']and len(args)==8 and args[3:]==['pg_isready','-U','ziggy','-d','ziggy'])
                require(absent or pending,'PG client nonzero exit')
                return None
            return bytes(wire).decode().strip()
        except BaseException as failure:
            error=type(failure).__name__;raise
        finally:
            cleanup_errors=[]
            try:selector.close()
            except Exception:cleanup_errors.append('selector_close_failed')
            if child is not None:
                if not waited:
                    try:child.kill()
                    except ProcessLookupError:pass
                    except Exception:cleanup_errors.append('client_kill_failed')
                    try:child.wait(timeout=2);waited=True
                    except Exception:cleanup_errors.append('client_wait_failed')
                for pipe in (child.stdout,child.stderr):
                    try:pipe.close()
                    except Exception:cleanup_errors.append('client_pipe_close_failed')
                row={'pid':child.pid,'actual_parent_wait':waited,'exit_code':child.returncode,'elapsed_seconds':time.monotonic()-start,'error_class':error,'cleanup_failures':cleanup_errors,'arguments_sha256':digest(json.dumps(args,separators=(',',':')).encode()),'output_bytes':len(wire),'output_sha256':digest(wire),'stderr_bytes':len(errors),'stderr_sha256':digest(errors)}
                self.receipt['actual_wait_count']+=int(waited);self.receipt['failure_count']+=int(error is not None or bool(cleanup_errors))
                self.receipt['chain_sha256']=digest(bytes.fromhex(self.receipt['chain_sha256'])+json.dumps(row,sort_keys=True,separators=(',',':')).encode())
                self.receipt['latest']=(self.receipt['latest']+[row])[-8:]
            if cleanup_errors and error is None:raise RuntimeError('PG client cleanup failed')


class Owned:
    def __init__(self,policy,docker,config,token,receipts,deadline,cleanup_deadline):
        require(policy==POLICY,'Exact reviewed PG16 policy required')
        require(all(type(value)in(int,float)and math.isfinite(value)for value in(deadline,cleanup_deadline))and cleanup_deadline<=deadline+60,'PG explicit execution/cleanup deadline differs')
        require(isinstance(token,str)and re.fullmatch('[0-9a-f]{32}',token),'PG owner token required')
        self.root=Path(receipts);require(self.root.is_absolute()and self.root.resolve()==self.root and self.root.is_dir()and not self.root.is_symlink(),'Owned PG receipt root required')
        self.config=Path(config);require(self.config==self.root/'docker-config'and not self.config.is_symlink(),'Fixed owned Docker config required')
        self.config.mkdir(mode=0o700,exist_ok=True);require(not any(self.config.iterdir()),'PG Docker config must be empty')
        self.token=token;self.policy=dict(policy);self.name='ziggy-paired-pg16-'+token;self.labels={LABEL:'pg16-linux',LABEL+'-token':token,LABEL+'-root':digest(os.fsencode(self.root))}
        self.path=self.root/'paired-postgres-owner.json';self.deadline=deadline;self.cleanup_deadline=cleanup_deadline;self.client=Client(docker,self.config);self.cid=None;self.closed=False
        self.context={'schema':1,'purpose':'paired-linux-postgres16','boot_id':boot_id(),'owner_uid':os.getuid(),'name':self.name,'token':token,'root_sha256':self.labels[LABEL+'-root'],'image_id':IMAGE_ID,'reference':IMAGE_REFERENCE,'labels':self.labels,'caps':{'memory':GIB,'memory_swap':GIB,'nano_cpus':2_000_000_000,'pids':128,'user':'999:999','tmpfs':TMPFS}}
        self.result={'context':self.context,'container_id':None,'passed':False,'container_absent':False,'daemon_parent_wait_credit':False,'steps':[],'client_waits':self.client.receipt}
        if self.path.exists():
            require(self.path.is_file()and not self.path.is_symlink()and self.path.stat().st_size<=65536,'PG journal invalid')
            old=json.loads(self.path.read_text());original=old['context']
            require({k:v for k,v in original.items()if k not in {'execution_deadline','cleanup_deadline'}}==self.context,'Foreign PG journal')
            require(all(type(original.get(k))in(int,float)and math.isfinite(original[k])for k in ('execution_deadline','cleanup_deadline'))and original['cleanup_deadline']<=original['execution_deadline']+60 and cleanup_deadline<=original['cleanup_deadline'],'PG recovery cannot extend original cleanup')
            self.context=original
            self.cid=old['container_id'];require(self.cid is None or re.fullmatch('[0-9a-f]{64}',self.cid),'PG journal CID invalid')
            self.result=old;self.result['client_waits_recovery']=self.client.receipt
        else:
            self.context.update(execution_deadline=deadline,cleanup_deadline=cleanup_deadline)

    def flush(self):
        self.result['container_id']=self.cid;atomic(self.path,self.result)

    def inspect(self,target,deadline):
        require(target==self.name or target==self.cid,'Foreign PG inspection target')
        wire=self.client.call(['container','inspect',target],deadline,10,missing=True)
        if wire is None:return None
        rows=json.loads(wire);require(isinstance(rows,list)and len(rows)==1,'One PG inspection required');return rows[0]

    def authenticated(self,row):
        cid=row.get('Id');require(isinstance(cid,str)and re.fullmatch('[0-9a-f]{64}',cid)and(self.cid is None or self.cid==cid),'PG CID changed')
        require(row.get('Name')=='/'+self.name and row.get('Image')==IMAGE_ID and row.get('Config',{}).get('Labels')==self.labels,'Foreign PG identity')
        host=row.get('HostConfig',{});cfg=row.get('Config',{})
        self.cid=cid;self.result['container_id']=cid
        state=row.get('State')or{}
        closed_state={key:state[key]for key in ('Running','OOMKilled')if type(state.get(key))is bool}
        closed_state.update({key:state[key]for key in ('Pid','ExitCode')if type(state.get(key))is int and -255<=state[key]<=2147483647})
        self.result['latest_authenticated_container']={'container_id':cid,'image_id':row['Image'],'observed_monotonic_ns':time.monotonic_ns(),'actual_user_matches_999':cfg.get('User')=='999:999','actual_memory':host.get('Memory')if type(host.get('Memory'))is int else None,'actual_memory_swap':host.get('MemorySwap')if type(host.get('MemorySwap'))is int else None,'actual_nano_cpus':host.get('NanoCpus')if type(host.get('NanoCpus'))is int else None,'actual_pids_limit':host.get('PidsLimit')if type(host.get('PidsLimit'))is int else None,'actual_network_bridge':host.get('NetworkMode')=='bridge','actual_drop_all':host.get('CapDrop')==['ALL'],'actual_cap_add_empty':host.get('CapAdd')in(None,[]),'actual_nnp':host.get('SecurityOpt')==['no-new-privileges:true'],'actual_privileged':host.get('Privileged')if type(host.get('Privileged'))is bool else None,'actual_state':closed_state}
        return row

    def caps(self,row):
        host=row.get('HostConfig',{});cfg=row.get('Config',{})
        require(host.get('Memory')==GIB and host.get('MemorySwap')==GIB and host.get('NanoCpus')==2_000_000_000 and host.get('PidsLimit')==128 and host.get('NetworkMode')=='bridge'and host.get('Privileged')is False and host.get('CapDrop')==['ALL']and host.get('CapAdd')in(None,[])and host.get('SecurityOpt')==['no-new-privileges:true']and host.get('RestartPolicy',{}).get('Name')=='no'and cfg.get('User')=='999:999','PG isolation/caps differ')
        require(host.get('Tmpfs')=={'/var/lib/postgresql/data':TMPFS}and host.get('Binds')in(None,[]),'PG fresh data differs')
        require(host.get('PortBindings')=={'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]},'PG requested port differs')

    def capture(self,deadline):
        row=self.inspect(self.cid or self.name,deadline)
        if row is not None:self.authenticated(row);self.flush()
        return row

    def cleanup(self,deadline):
        previous=self.result.get('cleanup_failures',[])
        require(isinstance(previous,list)and len(previous)<=4 and all(value in {'stop_failed','wait_failed','remove_failed','ownership_or_absence_unavailable'}for value in previous),'PG cleanup failure journal invalid')
        failures=list(dict.fromkeys(previous));self.result['passed']=False
        try:
            row=self.capture(deadline)
            if row is not None:
                cid=self.cid
                for verb,args in [('stop',['container','stop','--time','5',cid]),('wait',['container','wait',cid]),('remove',['container','rm',cid])]:
                    try:
                        if verb=='remove':self.capture(deadline)
                        output=self.client.call(args,deadline,8 if verb=='stop'else 10)
                        if verb=='wait':
                            require(isinstance(output,str)and re.fullmatch(r'0|[1-9][0-9]{0,2}',output)is not None and int(output)<=255,'PG server wait status invalid')
                            server_exit=int(output)
                            self.result['steps'].append({'operation':verb,'container_id':cid,'actual_client_wait':True,'exit_code':0,'server_exit_code':server_exit,'daemon_parent_wait_credit':False})
                            require(not self.result.get('ready')or server_exit==0,'Ready PG server did not exit cleanly')
                        else:
                            require(output==cid,'PG mutation reply CID differs')
                            if verb=='stop':
                                stopped=self.capture(deadline);require(stopped is not None and stopped.get('State',{}).get('Running')is False,'PG stop did not produce stopped state')
                                require(not self.result.get('ready')or stopped.get('State',{}).get('OOMKilled')is False,'Ready PG server OOM state differs')
                            self.result['steps'].append({'operation':verb,'container_id':cid,'actual_client_wait':True,'exit_code':0})
                    except Exception:
                        if verb+'_failed'not in failures:failures.append(verb+'_failed')
            absent=self.inspect(self.cid or self.name,deadline)is None
            self.result['container_absent']=absent
            require(absent,'PG absence not proved')
        except Exception:
            if 'ownership_or_absence_unavailable'not in failures:failures.append('ownership_or_absence_unavailable')
        self.result['cleanup_failures']=failures;self.result['passed']=not failures and self.result['container_absent'];self.closed=self.result['passed'];self.flush()
        require(self.result['passed'],'Owned PG cleanup failed')
        return self.result


def cleanup_all(*,policy,docker,docker_config,token,receipts,deadline):
    """Outer owner calls after stopping worker. No creation, no daemon wait fiction."""
    root=Path(receipts);path=root/'paired-postgres-owner.json'
    require(path.is_file()and not path.is_symlink(),'Pre-create PG custody journal required')
    owned=Owned(policy,docker,docker_config,token,root,deadline,deadline)
    return owned.cleanup(deadline)


def bind_postgres(scraper_module,policy,*,docker,docker_config,token,deadline,cleanup_deadline,receipts):
    """Worker binding only; original constructor and prepare are inherited verbatim."""
    require(policy==POLICY,'Exact reviewed PG16 policy required')
    base=scraper_module.Postgres
    class Postgres(base):
        def __enter__(self):
            require(self.image==policy['requested_image'],'Original PG16.15 fixture image required')
            self._owned=Owned(policy,docker,docker_config,token,receipts,deadline,cleanup_deadline);owned=self._owned
            require(not owned.path.exists(),'Preserve prior PG custody journal');owned.flush()
            try:
                rows=json.loads(owned.client.call(['image','inspect',IMAGE_REFERENCE],deadline,10));require(isinstance(rows,list)and len(rows)==1,'One immutable PG image required');image=rows[0]
                require(image.get('Id')==IMAGE_ID and image.get('Os')=='linux'and image.get('Architecture')=='amd64'and IMAGE_REFERENCE in(image.get('RepoDigests')or[])and(image.get('Config',{}).get('Labels')or{})=={},'PG image ID/RepoDigest/platform differs')
                args=['container','create','--pull=never','--name',owned.name,'--user','999:999','--memory',str(GIB),'--memory-swap',str(GIB),'--cpus','2','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--restart','no','--network','bridge','--tmpfs','/var/lib/postgresql/data:'+TMPFS,'--publish','127.0.0.1::5432']
                for key,value in owned.labels.items():args+=['--label',key+'='+value]
                args+=['--env','POSTGRES_USER=ziggy','--env','POSTGRES_DB=ziggy','--env','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE_REFERENCE]
                try:created=owned.client.call(args,deadline,30)
                except BaseException:
                    try:owned.capture(cleanup_deadline)
                    except Exception:owned.result['lost_create_inspection']='unavailable';owned.flush()
                    raise
                row=owned.capture(deadline);require(row is not None and created==owned.cid,'PG create reply/inspection differs');owned.caps(row)
                owned.client.call(['container','start',owned.cid],deadline,10)
                row=owned.capture(deadline);owned.caps(row);require(row.get('State',{}).get('Running')is True,'PG did not start')
                bindings=row.get('NetworkSettings',{}).get('Ports');require(isinstance(bindings,dict)and set(bindings)=={'5432/tcp'}and isinstance(bindings['5432/tcp'],list)and len(bindings['5432/tcp'])==1,'PG actual published port absent')
                binding=bindings['5432/tcp'][0];port=binding.get('HostPort');require(binding.get('HostIp')=='127.0.0.1'and isinstance(port,str)and port.isdecimal()and 0<int(port)<65536,'PG actual port is not dynamic loopback')
                self.port=int(port);ready_end=min(deadline,time.monotonic()+30)
                while True:
                    ready=owned.client.call(['container','exec',owned.cid,'pg_isready','-U','ziggy','-d','ziggy'],ready_end,5,readiness=True)
                    if ready is not None:break
                    require(time.monotonic()<ready_end,'Disposable PG readiness deadline');time.sleep(min(.1,max(0,ready_end-time.monotonic())))
                version=owned.client.call(['container','exec',owned.cid,'postgres','--version'],deadline,5);require(re.fullmatch(r'postgres \(PostgreSQL\) 16\.15(?: \([^\r\n]{1,128}\))?',version)is not None,'PG server version differs')
                self.identity={'image':self.image,'server':version,'image_id_chunks':scraper_module.chunks(IMAGE_ID.removeprefix('sha256:')),'isolation':'Exact owned Linux PG16 CID; dynamic loopback; fresh tmpfs; independent stop/rm/absence receipts.'};self.started=True;owned.result['ready']=True;owned.result['actual_published_loopback_port']=self.port;owned.flush();return self
            except BaseException:
                try:owned.cleanup(cleanup_deadline)
                except Exception:pass  # Receipt retains failed cleanup; preserve original enter error.
                raise

        def __exit__(self,*_):
            owned=getattr(self,'_owned',None)
            if owned is not None:owned.cleanup(cleanup_deadline)
            self.started=False

        def sql(self,database,query):
            owned=self._owned;require(self.started and owned.cid is not None and not owned.closed,'PG SQL requires admitted live CID')
            return owned.client.call(['container','exec',owned.cid,'psql','-X','-U','ziggy','-d',database,'-At','-v','ON_ERROR_STOP=1','-c',query],deadline)
    return Postgres
