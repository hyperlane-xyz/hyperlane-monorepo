"""Filesystem/control tests only. No Cargo, network, agents or benchmarks."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import native_harness_controls as h
import cold_matrix_owner as cold

class CensusControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def files(self,count):
        for i in range(count):(self.root/str(i)).write_bytes(b'public census fixture')
    def test_actual_allocated_bytes_and_counts(self):
        self.files(3);record={};value=h.functional_allocated(self.root,record)
        self.assertEqual(value,sum(p.lstat().st_blocks*512 for p in self.root.iterdir()))
        self.assertTrue(record['last']['complete']);self.assertEqual(record['last']['files_seen'],3);self.assertEqual(record['last']['unique_inodes'],3)
    def test_hardlink_inodes_count_all_entries_but_bytes_once(self):
        self.files(1);(self.root/'alias').hardlink_to(self.root/'0');record={};value=h.functional_allocated(self.root,record)
        self.assertEqual(value,(self.root/'0').lstat().st_blocks*512);self.assertEqual(record['last']['files_seen'],2);self.assertEqual(record['last']['unique_inodes'],1)
    def test_symlink_directory_never_follows_external_data(self):
        outside=self.root/'outside';outside.mkdir();(outside/'data').write_bytes(b'x'*8192);owned=self.root/'owned';owned.mkdir();(owned/'link').symlink_to(outside,target_is_directory=True);record={}
        self.assertEqual(h.functional_allocated(owned,record),0);self.assertEqual(record['last']['files_seen'],0)
    def test_disappearing_file_is_race_not_unproven_census(self):
        self.files(1);original=Path.lstat
        def read(path,*a,**kw):
            if path==self.root/'0':raise FileNotFoundError('controlled concurrent compiler unlink')
            return original(path,*a,**kw)
        record={}
        with mock.patch.object(Path,'lstat',read):value=h.functional_allocated(self.root,record)
        self.assertEqual(value,0);self.assertTrue(record['last']['complete']);self.assertEqual(record['last']['files_seen'],1)
    def test_entry_limit_reports_real_seen_count_and_rejects_credit(self):
        self.files(3);record={}
        with self.assertRaises(h.FunctionalCensusIncomplete) as error:h.functional_allocated(self.root,record,maximum_entries=2)
        self.assertEqual(error.exception.observation['reason'],'entry_limit');self.assertEqual(record['last']['files_seen'],3);self.assertFalse(record['last']['complete'])
    def test_time_limit_reports_elapsed_without_complete_credit(self):
        self.files(2);record={}
        with mock.patch.object(h.time,'monotonic',side_effect=[0,.25,.5,.75]):
            with self.assertRaises(h.FunctionalCensusIncomplete) as error:h.functional_allocated(self.root,record,maximum_seconds=.1)
        self.assertEqual(error.exception.observation['reason'],'time_limit');self.assertGreater(error.exception.observation['elapsed_seconds_diagnostic'],.1);self.assertFalse(record['last']['complete'])
    def test_functional_window_can_finish_same_walk_rejected_by_cold_default(self):
        self.files(4)
        def clock():
            values=iter([i*.3 for i in range(40)]);return lambda:next(values)
        with mock.patch.object(cold.time,'monotonic',side_effect=clock()):
            with self.assertRaisesRegex(RuntimeError,'census incomplete'):cold.allocated(self.root)
        record={}
        with mock.patch.object(h.time,'monotonic',side_effect=clock()):h.functional_allocated(self.root,record)
        self.assertTrue(record['last']['complete']);self.assertEqual(record['last']['maximum_entries'],250000);self.assertEqual(record['last']['maximum_seconds'],15)
    def test_cancellation_object_propagates_unchanged(self):
        signal=cold.TaskInterrupted('controlled cancellation');record={}
        def walk(*args,**kwargs):raise signal
        with mock.patch.object(h.os,'walk',side_effect=walk):
            with self.assertRaises(cold.TaskInterrupted) as error:h.functional_allocated(self.root,record)
        self.assertIs(error.exception,signal);self.assertFalse(record['last']['complete']);self.assertEqual(record['last']['reason'],'exception:TaskInterrupted')
    def test_nonmissing_walk_io_error_remains_failure(self):
        record={}
        def walk(*args,**kwargs):kwargs['onerror'](PermissionError('controlled denial'))
        with mock.patch.object(h.os,'walk',side_effect=walk):
            with self.assertRaises(PermissionError):h.functional_allocated(self.root,record)
        self.assertFalse(record['last']['complete']);self.assertEqual(record['last']['reason'],'exception:PermissionError')
    def test_limits_cannot_exceed_explicit_functional_budget(self):
        for options in [{'maximum_seconds':16},{'maximum_seconds':0},{'maximum_entries':250001},{'maximum_entries':True}]:
            with self.subTest(options=options),self.assertRaises(ValueError):h.functional_allocated(self.root,{},**options)
    def test_diagnostic_aggregate_preserves_maximum_counts(self):
        record={};self.files(3);h.functional_allocated(self.root,record);(self.root/'2').unlink();h.functional_allocated(self.root,record)
        self.assertEqual(record['calls'],2);self.assertEqual(record['maximum_files_seen'],3);self.assertEqual(record['last']['files_seen'],2)

if __name__=='__main__':unittest.main(verbosity=2)
