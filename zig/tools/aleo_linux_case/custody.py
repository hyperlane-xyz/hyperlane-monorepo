"""Case-only durable Docker custody. Recovery is cleanup-only after unit absence."""
import hashlib
import os
from pathlib import Path
import re
import stat
import time
from receipts import checked,decode,load,need
from kernel_delegate import atomic
from docker_gate import Daemon,Gate,NetworkLease,container_templates


def pin(path):
    raw=path.read_bytes();return {'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}


class Journal:
    def __init__(self,path,spec_pin,socket_identity):
        self.path=path;self.spec_pin=spec_pin;self.spec=load(spec_pin,32*1024**2)
        need(path==Path(self.spec['output'])/'custody'and not path.exists(),'exclusive host-only custody directory required')
        path.mkdir(mode=0o700)
        for name in ('attempts','containers'):(path/name).mkdir(mode=0o700)
        atomic(path/'header.json',{'schema':1,'kind':'aleo-case-docker-custody-v1','case_spec':spec_pin,'service_spec':self.spec['service_owner_spec'],'run_token':self.spec['run_token'],'daemon_socket_identity':socket_identity})

    def put(self,kind,key,value):
        need(kind in {'attempts','containers'}and type(key)is str and re.fullmatch('[A-Za-z0-9_-]{1,120}',key),'closed custody map key required')
        path=self.path/kind/(key+'.json')
        row={'key':key,'selected':value,'recorded_after_exact_name_absence':kind=='attempts'}
        if path.exists():need(load(pin(path))==row,'custody entry cannot be replaced')
        else:atomic(path,row)


class RecordedMap(dict):
    def __init__(self,journal,kind):super().__init__();self.journal=journal;self.kind=kind
    def __setitem__(self,key,value):
        # Gate assigns attempted ONLY after its actual404 and image admission;
        # this fsync completes before the daemon create request can be issued.
        self.journal.put(self.kind,key,value);super().__setitem__(key,value)


class RecordedNetwork(NetworkLease):
    def __init__(self,daemon,name,labels,journal):super().__init__(daemon,name,labels);self.journal=journal
    def create(self):
        status,_=self.daemon.call('GET','/networks/'+self.name);need(status==404,'network name preexisted')
        atomic(self.journal.path/'network-intent.json',{'name':self.name,'labels':self.labels,'actual_precreate_absence_checked':True})
        body={'Name':self.name,'CheckDuplicate':True,'Driver':'bridge','Internal':True,'Attachable':False,'EnableIPv6':False,'Labels':self.labels}
        self.attempted=True
        status,raw=self.daemon.call('POST','/networks/create',body);need(status==201,'owned network create failed')
        value=decode(raw);need(re.fullmatch('[0-9a-f]{64}',value['Id']),'full new network ID required');self.cid=value['Id']
        atomic(self.journal.path/'network-created.json',{'cid':self.cid})
        row=self.inspect();need(row['Internal']is True and row['Driver']=='bridge'and row['Attachable']is False and not row.get('Containers'),'not a fresh internal network')
        return self.cid


def read_map(directory,kind):
    need(directory.is_dir()and not directory.is_symlink(),'custody map directory required')
    records={};temporary=[]
    for path in directory.iterdir():
        need(path.is_file()and not path.is_symlink(),'ordinary custody file required')
        links=path.stat().st_nlink
        if not path.name.endswith('.tmp')and links==2:
            twin=path.with_name(path.name+'.tmp');a=path.stat();b=twin.stat();need(twin.is_file()and not twin.is_symlink()and(a.st_dev,a.st_ino)==(b.st_dev,b.st_ino)and b.st_nlink==2,'only interrupted atomic publication twin allowed')
        else:need(links in {1,2}and(links==1 or path.name.endswith('.tmp')),'unrecognized custody hardlink')
        if path.name.endswith('.json.tmp'):
            need(re.fullmatch('[A-Za-z0-9_-]{1,120}\\.json\\.tmp',path.name),'unknown custody temporary file');temporary.append(path.name);continue
        need(path.suffix=='.json','unknown custody file')
        row=load(pin(path),65536)
        need(set(row)=={'key','selected','recorded_after_exact_name_absence'}and path.name==row['key']+'.json'and row['key']not in records,'closed exact custody entry required')
        need(row['recorded_after_exact_name_absence']is(kind=='attempts'),'custody fence kind differs')
        records[row['key']]=row['selected']
    need(len(records)<=3 and len(temporary)<=3,'at most three exact owned container records')
    return records,temporary


def recover(spec_pin,service_pin,unit_absent,daemon=None):
    """No create/start/exec API. Never called while its service can still act."""
    need(unit_absent is True,'positive service absence required before Docker recovery')
    spec=load(spec_pin,32*1024**2);need(spec.get('schema')==1 and spec.get('root_approved')is True and spec.get('purpose')=='actual-aleo-linux-case-v1'and spec['service_owner_spec']==service_pin,'case/service custody differs')
    service=load(service_pin);need(service.get('schema')==1 and service.get('root_approved')is True and service.get('purpose')=='aleo-linux-case-service-v1'and service['run_token']==spec['run_token']and service['output']==spec['output'],'exact approved service binding required')
    path=Path(spec['output'])/'custody'
    if not path.exists():return {'passed':True,'custody_never_published':True,'Docker_or_native_acceptance':False,'performed_mutations':False,'complete_positive_custody':False}
    need(path.is_dir()and path.resolve()==path and path.stat().st_uid==os.getuid(),'owned canonical custody directory required')
    allowed={'header.json','header.json.tmp','network-intent.json','network-intent.json.tmp','network-created.json','network-created.json.tmp','attempts','containers'}
    need({p.name for p in path.iterdir()}<=allowed,'unknown custody record')
    if not(path/'header.json').exists():
        need(not(path/'network-intent.json').exists()and not(path/'network-created.json').exists()and not any((path/'attempts').iterdir())and not any((path/'containers').iterdir()),'missing header cannot authorize resources')
        return {'passed':True,'no_complete_custody_header_no_Docker_actions':True,'Docker_or_native_acceptance':False,'performed_mutations':False,'complete_positive_custody':False}
    header=load(pin(path/'header.json'))
    socket_identity=header.get('daemon_socket_identity')
    need(type(socket_identity)is list and len(socket_identity)==2 and all(type(v)is int and v>=0 for v in socket_identity),'original daemon socket inode required')
    need(header=={'schema':1,'kind':'aleo-case-docker-custody-v1','case_spec':spec_pin,'service_spec':service_pin,'run_token':spec['run_token'],'daemon_socket_identity':socket_identity},'immutable exact custody header differs')
    attempted,attempt_tmp=read_map(path/'attempts','attempts');containers,cid_tmp=read_map(path/'containers','containers')
    if not(path/'network-intent.json').exists():
        need(not attempted and not containers and not(path/'network-created.json').exists(),'no network intent cannot authorize containers')
        return {'passed':True,'network_never_armed':True,'Docker_or_native_acceptance':False,'performed_mutations':False,'complete_positive_custody':False}
    name='ziggy-aleo-net-'+spec['run_token'];labels={'ziggy.aleo.run-token':spec['run_token']}
    need(load(pin(path/'network-intent.json'))=={'name':name,'labels':labels,'actual_precreate_absence_checked':True},'exact precreate network fence required')
    deadline=time.monotonic_ns()+120*10**9
    if daemon is None:
        info=Path(spec['docker_socket']).stat(follow_symlinks=False);need(stat.S_ISSOCK(info.st_mode)and [info.st_dev,info.st_ino]==socket_identity,'original native Docker socket required')
        daemon=Daemon(spec['docker_socket'],socket_identity,spec['docker_api_version'],deadline)
    daemon.deadline_ns=deadline
    status,raw=daemon.call('GET','/info');info=decode(raw)
    need(status==200 and info['ID']==spec['daemon_id']and info['OSType']=='linux'and info['Architecture']=='x86_64'and info['DockerRootDir']==spec['docker_filesystem'],'recovery daemon identity differs')
    network=NetworkLease(daemon,name,labels);network.attempted=True;network_absent=False
    if(path/'network-created.json').exists():
        record=load(pin(path/'network-created.json'));need(set(record)=={'cid'}and re.fullmatch('[0-9a-f]{64}',record['cid']),'exact positive network CID required');network.cid=record['cid']
        status,_=daemon.call('GET','/networks/'+network.cid);network_absent=status==404;need(status in {200,404},'network recovery inspect failed')
    else:need(not attempted and not containers,'no published network CID cannot have container attempts')
    gate_spec={'manifest':load(spec['manifest']),'run_token':spec['run_token'],'internal_network':network.cid,'public_node_env':spec['public_node_env'],'postgres_command':['postgres']}
    expected={}
    for selected in attempted.values():
        match=re.fullmatch('ziggy-aleo-[0-9a-f]{12}-([1-9][0-9]*)-(aleo_a|aleo_b|postgres)',selected['name']);need(match is not None,'exact case name shape required')
        choices=container_templates(gate_spec,int(match[1]));need(selected in choices,'custody image/token/caps/body differs');expected[selected['name']]=selected
    need(set(expected)==set(attempted),'attempt key/name differs')
    gate=Gate({'original_deadline_ns':deadline},daemon,lambda _pid:None);absent=[];known_names=set()
    for cid,selected in containers.items():
        need(re.fullmatch('[0-9a-f]{64}',cid)and selected==attempted.get(selected['name']),'positive CID lacks prior exact attempt')
        known_names.add(selected['name']);status,_=daemon.call('GET','/containers/'+cid+'/json');need(status in {200,404},'CID recovery inspect failed')
        if status==404:absent.append({'cid':cid,'stopped_removed_absent':True,'actual_absence_observed':True})
        else:gate.containers[cid]=selected
    # A known CID that vanished cannot authorize adoption of a later same-name
    # replacement. Only genuinely lost create replies use the prearmed name.
    gate.attempted={key:value for key,value in attempted.items()if key not in known_names}
    cleanup=gate.cleanup();need(cleanup['passed']is True,'owned container recovery failed')
    net={'cid':network.cid,'owned_internal_network_removed_and_absent':True,'actual_absence_observed':True}if network_absent else network.close()
    need(net.get('owned_internal_network_removed_and_absent')is True or net.get('network_absent_after_failed_create')is True,'owned network recovery absent proof missing')
    checked(spec_pin);checked(service_pin)
    return {'passed':True,'performed_mutations':bool(cleanup['rows'])or not(network_absent or net.get('network_absent_after_failed_create')is True),'complete_positive_custody':len(attempted)==3 and len(containers)==3 and network.cid is not None,'container_rows':absent+cleanup['rows'],'network':net,'temporary_records':attempt_tmp+cid_tmp,'original_cleanup_deadline_ns':deadline,'completed_monotonic_ns':time.monotonic_ns(),'daemon_container_parent_wait_credit':False,'Docker_or_native_acceptance':False}
