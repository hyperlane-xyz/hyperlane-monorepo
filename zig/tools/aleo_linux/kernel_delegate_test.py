"""Pure systemd/cgroup custody controls; no real privileged or native operation."""
import copy
import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace as N
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
with patch.object(socket,'socket',side_effect=AssertionError('socket import')),patch.object(subprocess,'Popen',side_effect=AssertionError('process import')),patch.object(ctypes,'CDLL',side_effect=AssertionError('native import')):
    import kernel_delegate as owner


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ziggy-delegate-pure-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.spec={'run_token':'a'*32,'output':str(self.root/'probe')}
        self.unit=owner.identity(self.spec)
        self.rows=dict(owner.PROPERTIES,Id=self.unit,Description=self.unit,InvocationID='b'*32,User=str(os.getuid()),Group=str(os.getgid()),ControlGroup='/system.slice/'+self.unit,DelegateControllers='memory pids',RuntimeMaxUSec='2min 30s',TimeoutStopUSec='15s',LoadState='loaded',ActiveState='active',SubState='running')
        self.boot='actual-mock-boot'
        self.real_read=Path.read_text;self.real_write=Path.write_text

    def context(self):
        return {'unit':self.unit,'invocation':'b'*32,'uid':os.getuid(),'gid':os.getgid(),'root':'/sys/fs/cgroup/system.slice/'+self.unit,'root_dev':1,'root_ino':2,'manager_dev':1,'manager_ino':3,'boot_id':self.boot}

    def test_default_import_entry_is_inert(self):
        with patch.object(sys,'argv',['kernel_delegate.py']),self.assertRaisesRegex(ValueError,'inert'):owner.main()

    def test_exact_source_admission_hashes_before_provisioning(self):
        spec=dict(schema=1,root_approved=True,purpose='aleo-linux-kernel-probe-v1',pins=[owner.kernel_probe.pin(HERE/name)for name in ('kernel_probe.py','kernel_delegate.py','loopback_bridge.py','receipts.py')])
        self.assertEqual(owner.approved(spec),spec)
        for mutant in [dict(spec,delegation={}),dict(spec,pins=spec['pins'][:-1]),dict(spec,pins=[dict(row,sha256='0'*64)if index==0 else row for index,row in enumerate(spec['pins'])])]:
            with self.assertRaises(ValueError):owner.approved(mutant)

    def test_root_runner_rejected(self):
        with patch.object(os,'getuid',return_value=0),self.assertRaisesRegex(ValueError,'unprivileged'):owner.identity(self.spec)

    def test_token_cannot_select_existing_or_arbitrary_unit(self):
        for token in ('../actions-runner','a'*31,True,'A'*32):
            with self.subTest(token=token),self.assertRaises(ValueError):owner.identity(dict(self.spec,run_token=token))

    def test_exact_actual_unit_properties_admitted(self):
        self.assertEqual(owner.owned(self.rows,self.spec),'b'*32)

    def test_foreign_or_weakened_unit_properties_refused(self):
        for key,value in [('Id','foreign.service'),('Description','foreign'),('User','0'),('ControlGroup','/system.slice/actions-runner.service'),('DelegateControllers','pids'),('MemoryMax','infinity'),('MemorySwapMax','infinity'),('TasksMax','infinity'),('KillMode','process'),('Transient','no'),('NoNewPrivileges','no'),('DelegateSubgroup','')]:
            with self.subTest(key=key),self.assertRaises(ValueError):owner.owned(dict(self.rows,**{key:value}),self.spec)

    def test_actual_duration_readbacks_require_exact_fixed_caps(self):
        self.assertEqual(self.rows['RuntimeMaxUSec'],'2min 30s')
        self.assertEqual(self.rows['TimeoutStopUSec'],'15s')
        for key in ('RuntimeMaxUSec','TimeoutStopUSec'):
            missing=dict(self.rows);missing.pop(key)
            with self.subTest(key=key,value='missing'),self.assertRaisesRegex(ValueError,'actual unit property differs'):owner.owned(missing,self.spec)
            for value in ('infinity','0','2min 31s','16s','2min 30.000001s','15.000001s','150000000','150s',None,True):
                with self.subTest(key=key,value=value),self.assertRaisesRegex(ValueError,'actual unit property differs'):owner.owned(dict(self.rows,**{key:value}),self.spec)

    def test_duration_mismatch_never_authorizes_unit_stop(self):
        for key,value in [('RuntimeMaxUSec','infinity'),('TimeoutStopUSec','1min 30s')]:
            with patch.object(owner,'show',return_value=dict(self.rows,**{key:value})),patch.object(owner,'checked_context',side_effect=lambda ctx,spec:ctx),patch.object(owner,'command')as commands:
                with self.assertRaisesRegex(ValueError,'actual unit property differs'):owner.cleanup(self.spec,{'systemctl':'systemctl','sudo':'sudo'},self.context())
            commands.assert_not_called()

    def test_systemd_query_cannot_omit_duration_readback(self):
        for key in ('RuntimeMaxUSec','TimeoutStopUSec'):
            rows=dict(self.rows);rows.pop(key)
            raw='\n'.join(k+'='+v for k,v in rows.items()).encode()
            with patch.object(owner,'command',return_value=N(returncode=0,stdout=raw,stderr=b'')),self.assertRaisesRegex(ValueError,'complete systemd identity'):owner.show('/fixed/systemctl',self.unit)

    def test_replaced_invocation_refused(self):
        with self.assertRaisesRegex(ValueError,'invocation replaced'):owner.owned(self.rows,self.spec,'c'*32)

    def test_stopped_unit_empty_cgroup_requires_original_invocation(self):
        rows=dict(self.rows,ActiveState='inactive',SubState='dead',ControlGroup='')
        self.assertEqual(owner.owned(rows,self.spec,'b'*32,allow_stopped=True),'b'*32)
        with self.assertRaises(ValueError):owner.owned(rows,self.spec,allow_stopped=True)
        with self.assertRaises(ValueError):owner.owned(dict(rows,ActiveState='active'),self.spec,'b'*32,allow_stopped=True)

    def test_custody_rejects_wrong_boot_bool_inode_or_extra_authority(self):
        with patch.object(Path,'read_text',return_value=self.boot):
            self.assertEqual(owner.checked_context(self.context(),self.spec),self.context())
            for key,value in [('boot_id','other'),('root_ino',True),('root','/sys/fs/cgroup'),('extra',True)]:
                with self.subTest(key=key),self.assertRaises(ValueError):owner.checked_context(dict(self.context(),**{key:value}),self.spec)

    def test_atomic_first_receipt_never_overwritten(self):
        path=self.root/'custody.json';owner.atomic(path,{'original':True});before=path.read_bytes();inode=path.stat().st_ino
        with self.assertRaises(FileExistsError):owner.atomic(path,{'replacement':True})
        self.assertEqual(path.read_bytes(),before);self.assertEqual(path.stat().st_ino,inode)
        self.assertFalse(path.with_name(path.name+'.tmp').exists())

    def test_show_requires_exact_complete_unique_properties(self):
        raw='\n'.join(k+'='+v for k,v in self.rows.items()).encode()
        with patch.object(owner,'command',return_value=N(returncode=0,stdout=raw,stderr=b'')):
            self.assertEqual(owner.show('/fixed/systemctl',self.unit),self.rows)
        for data in (raw+b'\nId=duplicate',b'LoadState=loaded\n',raw+b'\nUnexpected=yes'):
            with patch.object(owner,'command',return_value=N(returncode=0,stdout=data,stderr=b'')),self.assertRaises(ValueError):owner.show('/fixed/systemctl',self.unit)

    def test_launch_only_systemd_is_privileged_payload_has_runner_UID(self):
        tool={'sudo':'/usr/bin/sudo','systemd-run':'/usr/bin/systemd-run'};pin={'path':'/private/spec.json','sha256':'d'*64}
        with patch.object(owner,'checked',return_value=Path('/usr/bin/python3.12')):
            argv=owner.launch_argv(dict(self.spec,python={}),tool,pin)
        self.assertEqual(argv[:3],['/usr/bin/sudo','-n','/usr/bin/systemd-run'])
        self.assertIn('--uid='+str(os.getuid()),argv);self.assertIn('--gid='+str(os.getgid()),argv)
        self.assertIn('--property=Delegate=memory pids',argv);self.assertIn('--property=RuntimeMaxSec=150',argv);self.assertIn('--property=TimeoutStopSec=15',argv)
        self.assertIn('--property=MemoryMax='+str(384*1024**2),argv);self.assertIn('--property=TasksMax=64',argv)
        self.assertIn('/usr/bin/python3.12',argv);self.assertNotIn('--scope',argv);self.assertNotIn('--privileged',argv)

    def fake_tree(self):
        fs=self.root/'sysfs';root=fs/'system.slice'/self.unit;manager=root/'manager';manager.mkdir(parents=True)
        for path,value in [(root/'cgroup.procs',''),(manager/'cgroup.procs',str(os.getpid())),(root/'cgroup.controllers','memory pids'),(root/'cgroup.subtree_control','')]:path.write_text(value)
        return fs,root,manager

    def fake_reads(self,path,*args,**kwargs):
        if str(path)=='/proc/self/cgroup':return '0::/system.slice/'+self.unit+'/manager\n'
        if str(path)=='/proc/sys/kernel/random/boot_id':return self.boot
        return self.real_read(path,*args,**kwargs)

    def test_controller_partition_writes_only_empty_owned_delegated_root(self):
        fs,root,manager=self.fake_tree();writes=[]
        def write(path,value,*args,**kwargs):
            writes.append((path,value));return self.real_write(path,value.replace('+',''),*args,**kwargs)
        with patch.object(owner.platform,'system',return_value='Linux'),patch.object(owner.platform,'machine',return_value='x86_64'),patch.object(Path,'read_text',lambda path,*args,**kwargs:self.fake_reads(path,*args,**kwargs)),patch.object(Path,'write_text',write):
            self.assertEqual(owner.prepare_inside(self.spec,self.unit,fsroot=fs),(root,manager))
        self.assertEqual(writes,[(root/'cgroup.subtree_control','+memory +pids')])

    def test_populated_root_foreign_manager_or_missing_controller_never_written(self):
        fs,root,manager=self.fake_tree()
        for path,value in [(root/'cgroup.procs','999'),(manager/'cgroup.procs',str(os.getpid())+' 999'),(root/'cgroup.controllers','pids')]:
            before=path.read_text();path.write_text(value)
            with patch.object(owner.platform,'system',return_value='Linux'),patch.object(owner.platform,'machine',return_value='x86_64'),patch.object(Path,'read_text',lambda path,*args,**kwargs:self.fake_reads(path,*args,**kwargs)),patch.object(Path,'write_text',side_effect=AssertionError('unexpected controller write')):
                with self.assertRaises(ValueError):owner.prepare_inside(self.spec,self.unit,fsroot=fs)
            path.write_text(before)

    def test_kernel_parent_is_sibling_root_and_replaced_inode_refuses(self):
        fs,root,manager=self.fake_tree();(root/'cgroup.subtree_control').write_text('memory pids')
        context=dict(self.context(),root=str(root),root_dev=root.stat().st_dev,root_ino=root.stat().st_ino,manager_dev=manager.stat().st_dev,manager_ino=manager.stat().st_ino)
        with patch.object(Path,'read_text',lambda path,*args,**kwargs:self.fake_reads(path,*args,**kwargs)):
            self.assertEqual(owner.kernel_probe.delegated_parent(context,self.spec['run_token'],fsroot=fs),root)
            with self.assertRaisesRegex(ValueError,'inode/UID'):owner.kernel_probe.delegated_parent(dict(context,root_ino=context['root_ino']+1),self.spec['run_token'],fsroot=fs)
            with self.assertRaisesRegex(ValueError,'typed delegated'):owner.kernel_probe.delegated_parent(dict(context,root_ino=True),self.spec['run_token'],fsroot=fs)

    def cleanup_path(self,path):
        path=Path(path)
        if str(path)=='/sys/fs/cgroup/system.slice':return self.root
        return path

    def test_foreign_replaced_or_unclaimed_unit_never_stopped(self):
        for rows,ctx in [(dict(self.rows,InvocationID='c'*32),self.context()),(dict(self.rows,MemoryMax='infinity'),self.context()),(self.rows,None)]:
            with patch.object(owner,'show',return_value=rows),patch.object(owner,'checked_context',side_effect=lambda ctx,spec:ctx),patch.object(owner,'command')as commands:
                with self.assertRaises(ValueError):owner.cleanup(self.spec,{'systemctl':'systemctl','sudo':'sudo'},ctx)
            commands.assert_not_called()

    def test_root_replacement_preserved_before_stop(self):
        root=self.root/self.unit;root.mkdir();ctx=dict(self.context(),root_dev=root.stat().st_dev,root_ino=root.stat().st_ino+1)
        with patch.object(owner,'show',return_value=self.rows),patch.object(owner,'checked_context',side_effect=lambda ctx,spec:ctx),patch.object(owner,'Path',side_effect=self.cleanup_path),patch.object(owner,'command')as commands:
            with self.assertRaisesRegex(ValueError,'cgroup replaced'):owner.cleanup(self.spec,{'systemctl':'systemctl','sudo':'sudo'},ctx)
        commands.assert_not_called()

    def test_active_owned_unit_stops_exact_name_and_requires_absence(self):
        root=self.root/self.unit;root.mkdir();ctx=dict(self.context(),root_dev=root.stat().st_dev,root_ino=root.stat().st_ino)
        def stop(argv,timeout):
            self.assertEqual(argv,['sudo','-n','systemctl','stop',self.unit]);root.rmdir();return N(returncode=0)
        with patch.object(owner,'show',return_value=self.rows),patch.object(owner,'checked_context',side_effect=lambda ctx,spec:ctx),patch.object(owner,'Path',side_effect=self.cleanup_path),patch.object(owner,'command',side_effect=stop):
            result=owner.cleanup(self.spec,{'systemctl':'systemctl','sudo':'sudo'},ctx)
        self.assertTrue(result['owned_cgroup_absent']);self.assertTrue(result['systemd_stop_is_not_parent_wait']);self.assertFalse(result['native_credit'])

    def test_missing_unit_with_residual_cgroup_is_not_absence(self):
        (self.root/self.unit).mkdir()
        with patch.object(owner,'show',return_value=None),patch.object(owner,'Path',side_effect=self.cleanup_path),self.assertRaisesRegex(ValueError,'remains'):
            owner.cleanup(self.spec,{'systemctl':'systemctl'},None)


    def driver_spec(self):
        return dict(self.spec,root_approved=True,purpose='aleo-linux-kernel-probe-v1',pins=[],delegation_tools={})

    def test_unavailable_controllers_persist_failed_receipt_without_launch(self):
        with patch.object(owner,'load',return_value=self.driver_spec()),patch.object(owner,'approved',side_effect=lambda spec:spec),patch.object(owner,'tools',return_value={}),patch.object(owner.platform,'system',return_value='Linux'),patch.object(owner.platform,'machine',return_value='x86_64'),patch.object(Path,'read_text',return_value='pids'),patch.object(subprocess,'Popen',side_effect=AssertionError('must not launch')):
            self.assertEqual(owner.execute({'fixture':'mock-admission'}),1)
        receipt=json.loads((self.root/'probe.owner/owner.json').read_text())
        self.assertFalse(receipt['passed']);self.assertIsNone(receipt['client_actual_wait'])
        self.assertIn('controllers unavailable',receipt['error']);self.assertIsNone(receipt['cleanup'])

    def driver_reads(self,path,*args,**kwargs):
        if str(path)=='/sys/fs/cgroup/cgroup.controllers':return 'memory pids'
        return self.fake_reads(path,*args,**kwargs)

    def test_preexisting_unit_refuses_before_launch_and_preserves_it(self):
        with patch.object(owner,'load',return_value=self.driver_spec()),patch.object(owner,'approved',side_effect=lambda spec:spec),patch.object(owner,'tools',return_value={'systemd-run':'systemd-run','systemctl':'systemctl'}),patch.object(owner.platform,'system',return_value='Linux'),patch.object(owner.platform,'machine',return_value='x86_64'),patch.object(Path,'read_text',lambda path,*args,**kwargs:self.driver_reads(path,*args,**kwargs)),patch.object(owner,'command',return_value=N(returncode=0,stdout=b'systemd 255\n')),patch.object(owner,'show',return_value=self.rows),patch.object(owner,'cleanup')as cleanup,patch.object(subprocess,'Popen',side_effect=AssertionError('must not launch')):
            self.assertEqual(owner.execute({'fixture':'mock-admission'}),1)
        cleanup.assert_not_called()
        receipt=json.loads((self.root/'probe.owner/owner.json').read_text());self.assertIn('preexisting',receipt['error']);self.assertFalse(receipt['passed'])

    def test_cleanup_failure_cannot_skip_actual_client_wait_or_heal_error(self):
        child=N(pid=123,poll=lambda:1,wait=lambda **kwargs:1)
        calls=[]
        def wait(**kwargs):calls.append(kwargs);return 1
        child.wait=wait
        with patch.object(owner,'load',return_value=self.driver_spec()),patch.object(owner,'approved',side_effect=lambda spec:spec),patch.object(owner,'tools',return_value={'systemd-run':'systemd-run','systemctl':'systemctl'}),patch.object(owner.platform,'system',return_value='Linux'),patch.object(owner.platform,'machine',return_value='x86_64'),patch.object(Path,'read_text',lambda path,*args,**kwargs:self.driver_reads(path,*args,**kwargs)),patch.object(owner,'command',return_value=N(returncode=0,stdout=b'systemd 255\n')),patch.object(owner,'show',return_value=None),patch.object(owner,'launch_argv',return_value=['explicit-mock-client']),patch.object(subprocess,'Popen',return_value=child),patch.object(owner,'cleanup',side_effect=ValueError('injected custody ambiguity')):
            self.assertEqual(owner.execute({'fixture':'mock-admission'}),1)
        receipt=json.loads((self.root/'probe.owner/owner.json').read_text())
        self.assertEqual(calls,[{}, {'timeout':18}]);self.assertFalse(receipt['passed'])
        self.assertIn('delegated kernel service failed',receipt['error']);self.assertIn('custody ambiguity',receipt['cleanup_errors'][0])
        self.assertEqual(receipt['client_actual_wait']['exit_code'],1);self.assertTrue(receipt['client_actual_wait']['waits_for_systemd_client_only'])


if __name__=='__main__':
    def no_effect(event,args):
        if event.startswith('socket.')or event in {'subprocess.Popen','os.fork','os.exec','ctypes.dlopen'}:raise AssertionError('effect forbidden:'+event)
    sys.addaudithook(no_effect)
    unittest.main()
