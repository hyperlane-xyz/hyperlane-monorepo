#!/usr/bin/env python3
"""Pure actual-source observer controls; no fixture imports, sockets or children."""
import ast,copy,gzip,hashlib,json,math,pathlib,re,time,types,urllib.error,unittest
ROOT=pathlib.Path(__file__).parent
PUBLIC=ROOT/'public_relay_process.py'
SHARED=ROOT/'relayer_process.py'
api={'copy':copy,'re':re,'time':time,'json':json,'math':math,'hashlib':hashlib,'SOURCE_CONFIRM_SECONDS':600,'SOURCE_FINALITY_GRACE_SECONDS':30,'ORIGIN':9913371,'DESTINATION':9913372}
tree=ast.parse(PUBLIC.read_text());node=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name=='PublicAdminReferences');exec(compile(ast.Module(body=[node],type_ignores=[]),str(PUBLIC),'exec'),api)
names={'chunks','metric_value','metric_observation','early_included_snapshot','retirement_poll','retirement_lower_bound','retirement_deadline'}
nodes=[n for n in ast.parse(SHARED.read_text()).body if isinstance(n,ast.FunctionDef)and n.name in names];exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SHARED),'exec'),api)
CAPTURE=ROOT/'public_fixtures/admin-overlap.json.gz'
DATA=json.loads(gzip.decompress(CAPTURE.read_bytes()))

class PublicReferenceTests(unittest.TestCase):
 def setUp(self):self.data=copy.deepcopy(DATA);self.messages=self.data['messages'];self.rows=self.data['operations']
 def guard(self,approved=True):return api['PublicAdminReferences'](self.messages,self.messages[0]if approved else None)
 def snapshot(self,rows):
  d=self.data
  return api['early_included_snapshot'](d['metrics_utf8'].encode(),rows,d['origin'],d['latest_nonce'],d['messages'],d['now'],d['initial'],d['aggregate'])
 def test_actual_capture_reproduces_original_failure_and_scoped_exact_membership(self):
  with self.assertRaisesRegex(AssertionError,'duplicate admin ID'):self.snapshot(self.rows)
  g=self.guard();normalized=g.normalize(self.rows);self.assertEqual(len(normalized),2);self.assertTrue(self.snapshot(normalized)['ready'])
  evidence=g.observations[0];self.assertEqual(evidence['raw_operations'],self.rows);self.assertEqual(evidence['raw_row_count'],3);self.assertEqual(evidence['unique_id_count'],2);self.assertEqual(sorted(evidence['id_reference_counts'].values()),[1,2])
 def test_generic_snapshot_and_retirement_stay_strict_without_normalizer(self):
  with self.assertRaisesRegex(AssertionError,'duplicate admin ID'):self.snapshot(self.rows)
  with self.assertRaisesRegex(AssertionError,'duplicate active operation ID'):api['retirement_poll'](self.rows,None,self.messages,self.data['now'])
 def test_no_overlap_optin_rejects_even_identical_duplicate(self):
  with self.assertRaises(AssertionError):self.guard(False).normalize(self.rows)
 def test_only_admitted_first_message_may_have_two_references(self):
  rows=[self.rows[0],self.rows[2],copy.deepcopy(self.rows[2])]
  with self.assertRaisesRegex(AssertionError,'unapproved public duplicate'):self.guard().normalize(rows)
 def test_third_reference_rejects(self):
  for rows in [[self.rows[0],self.rows[1],copy.deepcopy(self.rows[1]),self.rows[2]],[self.rows[0],self.rows[1],copy.deepcopy(self.rows[1])]]:
   with self.subTest(rows=len(rows)):
    with self.assertRaises(AssertionError):self.guard().normalize(rows)
 def test_each_mismatching_complete_row_field_rejects(self):
  changes=[lambda r:r['operation']['message'].update(body=[99]),lambda r:r['operation']['message'].update(nonce=99),lambda r:r['operation'].update(status='ReadyToSubmit',submitted=False),lambda r:r['operation'].update(num_retries=1),lambda r:r['operation'].update(app_context='different'),lambda r:r.update(extra='unknown'),lambda r:r['operation'].update(extra='unknown')]
  for mutate in changes:
   with self.subTest(mutate=mutate):
    rows=copy.deepcopy(self.rows);mutate(rows[1])
    with self.assertRaises(AssertionError):self.guard().normalize(rows)
 def test_malformed_duplicate_never_accepted_by_python_bool_integer_equality(self):
  for mutate in [lambda r:r['operation']['message'].update(nonce=False),lambda r:r['operation']['message'].update(body=[False]),lambda r:r['operation'].update(submitted=1),lambda r:r['operation'].update(num_retries=False)]:
   rows=copy.deepcopy(self.rows);mutate(rows[1])
   with self.assertRaises(AssertionError):self.guard().normalize(rows)
 def test_identical_bad_wire_status_or_body_in_both_rows_rejects(self):
  for mutate in [lambda r:r['operation']['message'].update(destination=1),lambda r:r['operation'].update(status={'Confirm':'Unknown'}),lambda r:r['operation'].update(submitted=False),lambda r:r['operation']['message'].update(body=[False])]:
   rows=copy.deepcopy(self.rows);mutate(rows[0]);mutate(rows[1])
   with self.assertRaises(AssertionError):self.guard().normalize(rows)
 def test_foreign_or_malformed_id_rejects(self):
  for identity in ['0x'+'ff'*32,'bad',None]:
   rows=copy.deepcopy(self.rows);rows[1]['id']=identity
   with self.assertRaises(AssertionError):self.guard().normalize(rows)
 def test_normalization_never_hides_missing_tracked_id(self):
  rows=self.guard().normalize(self.rows[:2])
  with self.assertRaisesRegex(AssertionError,'disappeared'):self.snapshot(rows)
 def test_raw_evidence_does_not_alias_returned_rows_or_later_response_mutations(self):
  g=self.guard();before=copy.deepcopy(self.rows);rows=g.normalize(self.rows);rows[0]['operation']['num_retries']=9;self.assertEqual(g.observations[0]['raw_operations'],before)
 def test_original_counter_exact_two_and_each_id600_seconds_unchanged(self):
  g=self.guard();normalized=g.normalize(self.rows);end=max(m['included_monotonic']for m in self.messages)+600
  self.assertFalse(api['retirement_poll'](normalized,None,self.messages,self.data['now']))
  with self.assertRaisesRegex(AssertionError,'partial early retirement'):api['retirement_poll']([],2,self.messages,end-1)
  self.assertTrue(api['retirement_poll']([],2,self.messages,end))
  with self.assertRaisesRegex(AssertionError,'partial early retirement'):api['retirement_poll']([],3,self.messages,end)
  self.assertFalse(api['retirement_poll']([],None,self.messages,end))
 def test_rejected_duplicate_preserves_raw_input_in_memory(self):
  rows=copy.deepcopy(self.rows);rows[1]['operation']['num_retries']=1;g=self.guard()
  with self.assertRaises(AssertionError):g.normalize(rows)
  self.assertEqual(g.observations[0]['raw_operations'],rows)
 def test_retained_fixture_file_records_raw_rows_before_rejecting_them(self):
  # Minimal in-memory Path capability exercises actual persistence ordering.
  written=[]
  class Stream:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def write(self,value):written.append(value)
  class Path:
   def open(self,mode):self.last=mode;return Stream()
  rows=copy.deepcopy(self.rows);rows[1]['operation']['num_retries']=1;g=api['PublicAdminReferences'](self.messages,self.messages[0],Path())
  with self.assertRaises(AssertionError):g.normalize(rows)
  self.assertEqual(json.loads(''.join(written))['raw_operations'],rows)

 def http_observers(self):
  d=self.data
  class Response:
   status=200
   def __init__(self,body):self.body=body
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self):return self.body
  def urlopen(url,timeout):return Response(json.dumps(d['operations']).encode()if '/list_operations?'in url else d['metrics_utf8'].encode())
  ctx=dict(api,urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=urlopen),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:d['now'],time=lambda:1))
  class Observed(Exception):pass
  def wait(callback,*args):
   self.assertFalse(callback())
   raise Observed()
  ctx['wait']=wait
  funcs=[n for n in ast.parse(SHARED.read_text()).body if isinstance(n,ast.FunctionDef)and n.name in ['early_included_guard','wait_for_retirement']]
  exec(compile(ast.Module(body=funcs,type_ignores=[]),str(SHARED),'exec'),ctx)
  return ctx,Observed
 def test_actual_early_http_observer_normalizes_before_strict_snapshot(self):
  ctx,_=self.http_observers();g=self.guard()
  value=ctx['early_included_guard'](1,self.data['origin'],self.data['latest_nonce'],self.messages,initial=True,operation_normalizer=g.normalize)
  self.assertTrue(value['ready']);self.assertEqual(g.observations[0]['raw_row_count'],3)
 def test_actual_retirement_http_observer_normalizes_before_first_strict_poll(self):
  ctx,Observed=self.http_observers();g=self.guard()
  with self.assertRaises(Observed):ctx['wait_for_retirement'](1,None,self.messages,operation_normalizer=g.normalize)
  self.assertEqual(g.observations[0]['raw_row_count'],3)
  # Default path still rejects raw duplicates before any confirmed counter.
  with self.assertRaisesRegex(AssertionError,'duplicate active operation ID'):ctx['wait_for_retirement'](1,None,self.messages)

 def test_shared_http_seams_default_to_original_strict_observers(self):
  t=ast.parse(SHARED.read_text())
  for name in ['early_included_guard','wait_for_retirement']:
   f=next(n for n in t.body if isinstance(n,ast.FunctionDef)and n.name==name);self.assertEqual(f.args.args[-1].arg,'operation_normalizer');self.assertIsNone(ast.literal_eval(f.args.defaults[-1]))
  for name,error in [('early_included_snapshot','duplicate admin ID'),('retirement_poll','duplicate active operation ID')]:
   node=next(n for n in t.body if isinstance(n,ast.FunctionDef)and n.name==name)
   self.assertNotIn('operation_normalizer',[a.arg for a in node.args.args])
   self.assertTrue(any(isinstance(n,ast.Assert)and isinstance(n.msg,ast.Constant)and n.msg.value==error for n in ast.walk(node)))
 def test_public_callsite_only_approves_messages_zero_in_unfiltered_case(self):
  tree=ast.parse(PUBLIC.read_text());call=next(n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='PublicAdminReferences');self.assertEqual(ast.unparse(call),"PublicAdminReferences(included, None if filtered else messages[0], temporary / 'public-admin-references.jsonl')")
  calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr in ['early_included_guard','wait_for_retirement']];self.assertEqual(len(calls),2)
  self.assertTrue(all(any(k.arg=='operation_normalizer'and ast.unparse(k.value)=='references.normalize'for k in n.keywords)for n in calls))

if __name__=='__main__':unittest.main()
