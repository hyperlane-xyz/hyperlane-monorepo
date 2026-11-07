"""Actual typed REST success clocks; pure callback/DTO controls, no network."""
import copy,hashlib,threading,unittest
import sys
from pathlib import Path
saved_path=list(sys.path)
try:
 sys.path.insert(0,str(Path(__file__).resolve().parent))
 from multivm_session import Session,successful_tron_rest_exchange
finally:sys.path[:]=saved_path
class Clock(unittest.TestCase):
 def request(self,method='getnowblock',body=None):return{'start':'POST /walletsolidity/'+method+' HTTP/1.1','json':{}if body is None else body,'wire':b'public fixture','requested_monotonic_ns':100}
 def block(self):return{'blockID':'ab'*32,'block_header':{'raw_data':{'number':7,'timestamp':1234}}}
 def success(self,r,response):return successful_tron_rest_exchange('walletsolidityurls','http://127.0.0.1:9090/walletsolidity',r,response)
 def test_actual_block_and_requested_height_only(self):
  self.assertTrue(self.success(self.request(),self.block()));self.assertTrue(self.success(self.request('getblockbynum',{'num':7}),self.block()));self.assertFalse(self.success(self.request('getblockbynum',{'num':8}),self.block()))
 def test_upper_lower_case_errors_and_empty_or_opaque_do_not_credit(self):
  for value in[{},[],None,{'Error':'failure'},{'error':'failure'},{'ERROR':'failure'},{'result':True},{'blockID':'ab'*32},{**self.block(),'Error':'bad'}]:self.assertFalse(self.success(self.request(),value))
 def test_block_fields_not_bool_negative_or_wrong_native_type(self):
  for change in[lambda r:r.update(blockID='x'),lambda r:r['block_header']['raw_data'].update(number=True),lambda r:r['block_header']['raw_data'].update(number=-1),lambda r:r['block_header']['raw_data'].update(timestamp='1234')]:
   r=self.block();change(r);self.assertFalse(self.success(self.request(),r))
 def test_constant_read_only_success_and_revert_or_error_rejection(self):
  req=self.request('triggerconstantcontract',{'owner_address':'41'+'11'*20,'contract_address':'41'+'22'*20,'data':'12345678','call_value':0,'visible':False});self.assertTrue(self.success(req,{'constant_result':['00'*32],'result':{'result':True}}))
  for value in[{'constant_result':[]},{'constant_result':['']},{'constant_result':['00'],'result':{'result':False}},{'constant_result':['00'],'result':{'code':'CONTRACT_VALIDATE_ERROR'}},{'Error':'failure','constant_result':['00']}]:self.assertFalse(self.success(req,value))
 def test_transaction_info_empty_failure_wrong_ID_and_opaque_receipt_reject(self):
  req=self.request('gettransactioninfobyid',{'value':'11'*32});good={'id':'11'*32,'blockNumber':7,'fee':0,'receipt':{'net_usage':1}};self.assertTrue(self.success(req,good))
  for value in[{},dict(good,Error='no tx'),dict(good,id='22'*32),dict(good,receipt={}),dict(good,receipt={'opaque':1}),dict(good,receipt={'result':'FAILED'}),dict(good,result='FAILED')]:self.assertFalse(self.success(req,value))
 def test_gettransactionbyid_requires_real_raw_data_hash_signature_and_return(self):
  raw=b'public fixture protobuf';identity=hashlib.sha256(raw).hexdigest();req=self.request('gettransactionbyid',{'value':identity});good={'txID':identity,'raw_data_hex':raw.hex(),'signature':['11'*65],'ret':[{'contractRet':'SUCCESS'}]};self.assertTrue(self.success(req,good));self.assertFalse(self.success(req,dict(good,raw_data_hex='00')));self.assertFalse(self.success(req,dict(good,txID=1)));self.assertFalse(self.success(req,dict(good,ret=[{'contractRet':'REVERT'}])))
 def test_account_matches_requested_native_address_and_has_balance(self):
  req=self.request('getaccount',{'address':'41'+'11'*20,'visible':False});self.assertTrue(self.success(req,{'address':'41'+'11'*20,'balance':0}));self.assertFalse(self.success(req,{}));self.assertFalse(self.success(req,{'address':'41'+'22'*20,'balance':1}))
 def test_unknown_broadcast_or_crossed_endpoint_never_clock(self):
  for method in['broadcasthex','broadcasttransaction','unknown']:
   self.assertFalse(self.success(self.request(method),{'result':True}))
  self.assertFalse(successful_tron_rest_exchange('walletsolidityurls','http://127.0.0.1:9091/walletsolidity',self.request(),self.block()));req=self.request();req['start']='POST /wallet/getnowblock HTTP/1.1';self.assertFalse(self.success(req,self.block()))
 def test_actual_observe_callback_never_updates_pair_from_Error_or_empty_lookup(self):
  session=Session.__new__(Session);session.manifest={'scenario':'tron'};session.lock=threading.RLock();session.activity={};session.successful_activity={};session.append=lambda *a:None;session.family=None;session._wallet=lambda *a:None
  for req,value in[(self.request(),{'Error':'failure'}),(self.request('gettransactioninfobyid',{'value':'11'*32}),{})]:session.observe('anvil1','validator','walletsolidityurls','http://127.0.0.1:9090/walletsolidity',req,value,200,200,{'wire':b'public fixture'})
  self.assertEqual(session.successful_activity,{});session.observe('anvil1','validator','walletsolidityurls','http://127.0.0.1:9090/walletsolidity',self.request(),self.block(),200,300,{'wire':b'public fixture'});self.assertEqual(session.successful_activity[('validator','anvil1')],{'request_started_monotonic_ns':100,'response_received_monotonic_ns':300})
  session.observe('anvil1','validator','walletsolidityurls','http://127.0.0.1:9090/walletsolidity',self.request(),{'Error':'later failure'},200,400,{'wire':b'public fixture'});self.assertEqual(session.successful_activity[('validator','anvil1')]['response_received_monotonic_ns'],300)
if __name__=='__main__':unittest.main(verbosity=2)
