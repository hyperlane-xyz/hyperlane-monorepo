"""Controlled in-memory daemon and private files only; no Docker/socket/native."""
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'aleo_linux'));sys.path.insert(0,str(HERE.parent/'aleo_linux_sdk'));sys.path.insert(0,str(HERE))
import custody
import ast
import docker_gate
from docker_gate import container_templates


class Daemon:
    def __init__(self):self.rows={};self.network=None;self.calls=[];self.cleanup_deadlines=[];self.deadline_ns=time.monotonic_ns()+10**9
    def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
        if cleanup_deadline_ns is not None:
            if type(cleanup_deadline_ns)is not int or cleanup_deadline_ns!=self.deadline_ns:raise ValueError('fake actual caller cleanup budget differs')
            self.cleanup_deadlines.append((method,path,cleanup_deadline_ns))
        self.calls.append((method,path));reply=lambda status,value:(status,json.dumps(value).encode())
        if path=='/info':return reply(200,{'ID':'owned-daemon','OSType':'linux','Architecture':'x86_64','DockerRootDir':'/owned-docker'})
        if path=='/networks/create':
            self.network={'Id':'8'*64,'Name':body['Name'],'Labels':body['Labels'],'Internal':True,'Driver':'bridge','Attachable':False,'Containers':{}};return reply(201,{'Id':self.network['Id']})
        if path.startswith('/networks/'):
            if self.network is None or path.rsplit('/',1)[1]not in {self.network['Id'],self.network['Name']}:return reply(404,{})
            if method=='DELETE':self.network=None;return reply(204,{})
            value=dict(self.network,Containers={cid:{}for cid in self.rows});return reply(200,value)
        if path.startswith('/containers/'):
            key=path.split('/')[2].split('?')[0];cid=next((cid for cid,value in self.rows.items()if cid==key or value['Name']=='/'+key),None)
            if cid is None:return reply(404,{})
            if method=='DELETE':del self.rows[cid];return reply(204,{})
            if '/stop?'in path:self.rows[cid]['State']['Running']=False;return reply(204,{})
            return reply(200,self.rows[cid])
        raise AssertionError('unexpected cleanup API: '+method+' '+path)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.output=self.root/'case';self.output.mkdir()
        def write(name,value):
            p=self.root/name;p.write_text(json.dumps(value));return custody.pin(p)
        self.service=write('service.json',{'schema':1,'root_approved':True,'purpose':'aleo-linux-case-service-v1','run_token':'a'*32,'output':str(self.output)})
        profile=json.loads(gzip.decompress((HERE/'public-profile.json.gz').read_bytes()));self.manifest={'taskRoot':str(self.output/'data/case'),'domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],'image':profile['image'],'postgresImage':profile['postgresImage']}
        self.spec={'schema':1,'root_approved':True,'purpose':'actual-aleo-linux-case-v1','output':str(self.output),'run_token':'a'*32,'service_owner_spec':self.service,'manifest':write('manifest.json',self.manifest),'public_node_env':['PUBLIC_FIXTURE=only'],'daemon_id':'owned-daemon','docker_filesystem':'/owned-docker'}
        self.spec_pin=write('payload.json',self.spec);self.journal=custody.Journal(self.output/'custody',self.spec_pin,[1,2]);self.daemon=Daemon();self.network=custody.RecordedNetwork(self.daemon,'ziggy-aleo-net-'+'a'*32,{'ziggy.aleo.run-token':'a'*32},self.journal);self.network.create()
        self.gate_spec={'manifest':self.manifest,'run_token':'a'*32,'internal_network':self.network.cid,'public_node_env':self.spec['public_node_env'],'postgres_command':['postgres']}
        self.selected=container_templates(self.gate_spec,3)
        self.attempts=custody.RecordedMap(self.journal,'attempts');self.containers=custody.RecordedMap(self.journal,'containers')

    def put(self,index,known=True):
        selected=self.selected[index];cid=str(index+1)*64;self.attempts[selected['name']]=selected
        self.daemon.rows[cid]={'Id':cid,'Name':'/'+selected['name'],'Image':selected['image'],'Config':{'Labels':selected['labels']},'State':{'Running':True}}
        if known:self.containers[cid]=selected
        return cid

    def recover(self):return custody.recover(self.spec_pin,self.service,True,self.daemon)

    def test_actual_supervisor120_reaches_C40_cleanup_and_exact_stop_reply_margin(self):
        now=time.monotonic_ns();deadline=now+120*10**9
        tree=ast.parse((HERE/'case_supervisor.py').read_text())
        assignment=next(n for n in ast.walk(tree)if isinstance(n,ast.Assign)and ast.unparse(n)=="daemon.deadline_ns = cleanup_deadline")
        exec(compile(ast.fix_missing_locations(ast.Module(body=[assignment],type_ignores=[])),'actual-supervisor-cleanup-deadline','exec'),{'daemon':self.daemon,'cleanup_deadline':deadline})
        cid=self.put(0);gate=docker_gate.Gate(self.gate_spec,self.daemon,None);gate.containers[cid]=self.selected[0]
        call=next(n for n in ast.walk(tree)if isinstance(n,ast.Call)and ast.unparse(n.func)=='gate.cleanup')
        self.assertFalse(call.keywords);ns={'gate':gate};result=eval(compile(ast.Expression(body=call),'actual-supervisor-cleanup-call','eval'),ns)
        self.assertTrue(result['passed']);self.assertFalse(self.daemon.rows)
        self.assertTrue(self.daemon.cleanup_deadlines);self.assertTrue(all(row[2]==deadline for row in self.daemon.cleanup_deadlines))
        with patch.object(docker_gate.time,'monotonic_ns',return_value=now):
            self.assertEqual(docker_gate.daemon_request_deadline(deadline,'POST','/containers/'+cid+'/stop?t=10',deadline),now+12*10**9)
            self.assertEqual(docker_gate.daemon_request_deadline(deadline,'POST','/containers/'+cid+'/stop?t=10'),now+12*10**9)
            self.assertEqual(docker_gate.daemon_request_deadline(deadline,'GET','/info'),now+10*10**9)
            self.assertEqual(docker_gate.daemon_request_deadline(now+5*10**9,'POST','/containers/'+cid+'/stop?t=10'),now+5*10**9)
            self.assertEqual(docker_gate.daemon_request_deadline(now+5*10**9,'POST','/containers/'+cid+'/stop?t=10',now+5*10**9),now+5*10**9)

    def test_map_fsync_precedes_visible_assignment_and_is_noclobber(self):
        selected=self.selected[0]
        with patch.object(self.journal,'put',side_effect=OSError('durable write failed')):
            with self.assertRaises(OSError):self.attempts[selected['name']]=selected
        self.assertEqual(self.attempts,{})
        self.attempts[selected['name']]=selected
        with self.assertRaises(ValueError):self.attempts[selected['name']]=dict(selected,image='foreign')

    def test_network_absence_is_published_before_daemon_create(self):
        intent=self.output/'custody/network-intent.json';self.assertTrue(intent.exists())
        self.assertEqual(json.loads(intent.read_text())['actual_precreate_absence_checked'],True)
        self.assertEqual(self.daemon.calls[:2],[('GET','/networks/'+self.network.name),('POST','/networks/create')])

    def test_crashed_manager_recovers_exact_three_and_network_without_wait_credit(self):
        for i in range(3):self.put(i)
        result=self.recover();self.assertTrue(result['passed']);self.assertTrue(result['performed_mutations']);self.assertTrue(result['complete_positive_custody'])
        self.assertEqual(self.daemon.rows,{});self.assertIsNone(self.daemon.network);self.assertFalse(result['daemon_container_parent_wait_credit'])
        self.assertTrue(all(method=='GET'or method=='DELETE'or(method=='POST'and '/stop?'in path)for method,path in self.daemon.calls[3:]))

    def test_healthy_already_absent_journal_is_not_a_forced_cleanup_pass(self):
        for i in range(3):self.put(i)
        self.daemon.rows.clear();self.daemon.network=None
        result=self.recover();self.assertFalse(result['performed_mutations']);self.assertTrue(result['complete_positive_custody'])
        self.assertEqual(len(result['container_rows']),3)

    def test_lost_create_reply_uses_prior_exact_name_fence(self):
        self.put(0,known=False)
        result=self.recover();self.assertTrue(result['performed_mutations']);self.assertFalse(result['complete_positive_custody']);self.assertEqual(self.daemon.rows,{})

    def test_known_removed_cid_never_adopts_later_same_name(self):
        cid=self.put(0);foreign=self.daemon.rows.pop(cid);foreign['Id']='9'*64;self.daemon.rows['9'*64]=foreign
        with self.assertRaises(ValueError):self.recover()
        self.assertIn('9'*64,self.daemon.rows)
        self.assertFalse(any(path.startswith('/containers/'+'9'*64)for method,path in self.daemon.calls))

    def test_live_service_or_foreign_identity_has_no_recovery_authority(self):
        self.put(0)
        with self.assertRaises(ValueError):custody.recover(self.spec_pin,self.service,False,self.daemon)
        self.daemon.rows['1'*64]['Config']['Labels']={'foreign':'yes'}
        with self.assertRaises(ValueError):self.recover()
        self.assertIn('1'*64,self.daemon.rows)

    def test_unknown_record_and_tampered_caps_rejected_before_delete(self):
        self.put(0);(self.output/'custody/foreign').write_text('unknown')
        with self.assertRaises(ValueError):self.recover()
        (self.output/'custody/foreign').unlink()
        path=next((self.output/'custody/attempts').glob('*.json'));value=json.loads(path.read_text());value['selected']['create_body']['HostConfig']['Memory']=1;path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):self.recover()
        self.assertFalse(any(method=='DELETE'for method,path in self.daemon.calls))


    def test_interrupted_atomic_link_twin_is_not_foreign_hardlink_authority(self):
        self.put(0);path=next((self.output/'custody/attempts').glob('*.json'));twin=path.with_name(path.name+'.tmp');os.link(path,twin)
        self.assertEqual(path.stat().st_nlink,2)
        result=self.recover();self.assertTrue(result['performed_mutations']);self.assertIn(twin.name,result['temporary_records'])

    def test_arbitrary_third_hardlink_cannot_authorize_cleanup(self):
        self.put(0);path=next((self.output/'custody/attempts').glob('*.json'));os.link(path,path.with_name(path.name+'.tmp'));os.link(path,self.root/'unaccounted-link')
        with self.assertRaises(ValueError):self.recover()
        self.assertFalse(any(method=='DELETE'for method,path in self.daemon.calls))

if __name__=='__main__':unittest.main()
