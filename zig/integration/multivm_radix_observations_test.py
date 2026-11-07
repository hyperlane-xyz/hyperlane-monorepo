"""Pure typed REST/projection controls. RPC/SDK fixture outputs are MOCKS ONLY."""
import copy
import hashlib
import json
import threading
import unittest
from unittest import mock
from pathlib import Path
import sys

# CI invokes this file with -I; use only the checkout's explicit siblings.
HERE=Path(__file__).resolve().parent
sys.path[0:0]=[str(HERE),str(HERE.parent/'bench')]

import multivm_radix_observations as m
import multivm_session as session
import multivm_radix_test as fixture
import native_case_owner_test as owner_fixture
import native_case_owner as owner


class Controls(unittest.TestCase):
    core='http://localhost:3333/core'
    gateway='http://localhost:5308/'
    def request(self,route,body,core=False):return {'start':'POST '+('/core'if core else'')+route+' HTTP/1.1','json':body}
    def call(self,route,body,response,core=False):return m.successful_rest_exchange('rpcurls'if core else'gatewayurls',self.core if core else self.gateway,self.request(route,body,core),response)
    def ledger(self):return {'network':'localnet','state_version':100,'epoch':10}
    def tx(self):return {'intent_hash':fixture.address_text(bytes([1])*32,'txid'),'state_version':90,'transaction_status':'CommittedSuccess','receipt':{'status':'CommittedSuccess','events':[]}}
    def test_existing_source_only_import_closure_pins_new_helper_before_roles(self):
        from multivm_evidence import import_module_closure
        for scenario in('evm','cosmosnative','cosmwasm','starknet','radix','tron'):
            self.assertIn('multivm_radix_observations.py',import_module_closure(scenario))
    def test_core_status_binds_source_request_without_inventing_network_echo(self):
        response={'current_state_identifier':{'state_version':100}}
        self.assertTrue(self.call('/status/network-status',{'network':'localnet'},response,True))
        for body,value in[({'network':'mainnet'},response),({'network':'localnet'},{}),({'network':'localnet'},{'current_state_identifier':{'state_version':True}}),({'network':'localnet'},dict(response,network='mainnet')),({'network':'localnet'},dict(response,Error='failure'))]:
            with self.subTest(body=body,value=value):self.assertFalse(self.call('/status/network-status',body,value,True))
    def test_exact_owned_endpoint_and_route_no_foreign_query_credentials_or_field(self):
        request=self.request('/status/network-status',{'network':'localnet'},True);response={'current_state_identifier':{'state_version':1}}
        for endpoint in('http://localhost:1337/core','https://localhost:3333/core','http://external.invalid:3333/core','http://u:p@localhost:3333/core','http://localhost:3333/core?token=1'):
            self.assertFalse(m.successful_rest_exchange('rpcurls',endpoint,request,response))
        self.assertFalse(m.successful_rest_exchange('walleturls',self.core,request,response))
        request['start']='POST /core/status/network-status/extra HTTP/1.1';self.assertFalse(m.successful_rest_exchange('rpcurls',self.core,request,response))
    def test_call_preview_checks_actual_state_target_scrypto_and_failure(self):
        body={'network':'localnet','target':{'type':'Method','component_address':fixture.contract(1),'method_name':'delivered'},'arguments':['4d0100'],'at_ledger_state':{'type':'ByStateVersion','state_version':90}}
        response={'status':'Succeeded','at_ledger_state':{'state_version':90},'output':{'hex':'5c0101'}}
        self.assertTrue(self.call('/transaction/call-preview',body,response,True))
        for key,value in[('status','Failed'),('at_ledger_state',{'state_version':91}),('output',{'hex':''}),('output',{'hex':'4d0101'}),('output',{'hex':'5czz'}),('output',{'hex':'5c01'}),('output',{'hex':'5c0102'}),('output',{'hex':'5c010100'}),('error_message','failed')]:
            changed=copy.deepcopy(response);changed[key]=value
            with self.subTest(key=key,value=value):self.assertFalse(self.call('/transaction/call-preview',body,changed,True))
    def test_gateway_status_requires_actual_network_and_typed_ledger(self):
        self.assertTrue(self.call('/status/gateway-status',{}, {'ledger_state':self.ledger()}))
        for value in({}, {'ledger_state':dict(self.ledger(),network='mainnet')},{'ledger_state':dict(self.ledger(),state_version=False)}):self.assertFalse(self.call('/status/gateway-status',{},value))
    def test_transaction_status_unknown_failure_empty_and_commit_state_do_not_earn_progress(self):
        body={'intent_hash':self.tx()['intent_hash']};response={'ledger_state':self.ledger(),'status':'CommittedSuccess','committed_state_version':90}
        self.assertTrue(self.call('/transaction/status',body,response))
        for status in('Unknown','Rejected','CommittedFailure',None):self.assertFalse(self.call('/transaction/status',body,dict(response,status=status)))
        for state in(0,101,True,None):self.assertFalse(self.call('/transaction/status',body,dict(response,committed_state_version=state)))
        self.assertFalse(self.call('/transaction/status',{'intent_hash':'txid_mainnet'},response))
    def test_committed_details_binds_actual_intent_and_successful_receipt(self):
        body={'intent_hash':self.tx()['intent_hash']};response={'ledger_state':self.ledger(),'transaction':self.tx()}
        self.assertTrue(self.call('/transaction/committed-details',body,response))
        for tx in(dict(self.tx(),intent_hash=fixture.address_text(bytes([2])*32,'txid')),dict(self.tx(),receipt={'status':'Failed'}),dict(self.tx(),state_version=101)):
            self.assertFalse(self.call('/transaction/committed-details',body,dict(response,transaction=tx)))
    def test_stream_empty_typed_page_is_real_read_bare_empty_is_not(self):
        body={'from_ledger_state':{'state_version':1},'order':'Asc','event_global_emitters_filter':[fixture.contract(1)]}
        response={'ledger_state':self.ledger(),'items':[]}
        self.assertTrue(self.call('/stream/transactions',body,response));self.assertFalse(self.call('/stream/transactions',body,{}))
        self.assertFalse(self.call('/stream/transactions',body,dict(response,next_cursor='unearned')))
    def test_stream_rejects_duplicate_reordered_foreign_state_cursor_and_network(self):
        body={'from_ledger_state':{'state_version':80},'order':'Asc','cursor':'previous'};response={'ledger_state':self.ledger(),'items':[self.tx()],'next_cursor':'next'}
        self.assertTrue(self.call('/stream/transactions',body,response))
        for value in(dict(response,items=[self.tx(),self.tx()]),dict(response,items=[dict(self.tx(),state_version=79)]),dict(response,next_cursor='previous'),dict(response,ledger_state=dict(self.ledger(),network='mainnet'))):self.assertFalse(self.call('/stream/transactions',body,value))
    def test_submission_preview_unknown_and_nonpost_never_earn_activity(self):
        for path in('/transaction/submit','/transaction/preview-v2','/invented'):
            self.assertFalse(self.call(path,{'notarized_transaction_hex':'4d01'},{'ledger_state':self.ledger(),'duplicate':False}))
        request=self.request('/status/gateway-status',{});request['start']='GET /status/gateway-status HTTP/1.1'
        self.assertFalse(m.successful_rest_exchange('gatewayurls',self.gateway,request,{'ledger_state':self.ledger()}))
    def test_actual_session_callback_only_records_typed_physical_success(self):
        obj=object.__new__(session.Session);obj.lock=threading.RLock();obj.manifest={'scenario':'radix'};obj.activity={};obj.successful_activity={};obj.append=lambda *args:None
        obj.family=type('Family',(),{'observe':lambda *args:None})();obj.record_starknet_rpc_recovery=lambda *args:None
        request=self.request('/status/gateway-status',{});request.update(requested_monotonic_ns=100,wire=b'public request')
        for result in({}, {'Error':'failure'}, {'ledger_state':dict(self.ledger(),network='mainnet')}):obj.observe('radix0','scraper','gatewayurls',self.gateway,request,result,200,120,{'wire':b'public response'})
        self.assertEqual(obj.successful_activity,{})
        obj.observe('radix0','scraper','gatewayurls',self.gateway,request,{'ledger_state':self.ledger()},200,120,{'wire':b'public response'})
        self.assertEqual(obj.successful_activity[('scraper','radix0')],{'request_started_monotonic_ns':100,'response_received_monotonic_ns':120})
    def snapshot(self,paid='0.000000000000000011'):
        family=fixture.CollectedFixture(paid);native=family.collect(family.session,4,'initial')
        raw=owner_fixture.CaseOwnerTests().public_snapshot_fixture();life=raw['per_id_lifecycle'][0];raw.update(native);raw['scenario']='radix'
        raw['per_id_lifecycle']=[dict(life,id=row['id'],chain=row['delivery_chain'],transaction_hash=row['delivery_transaction'])for row in native['messages']]
        raw['native_operations']=[];raw['stopped_canonical_Rust_readback']=[];raw['family_native_row_proofs']=[];raw['checkpoint_proofs']=[];raw.pop('same_db_restart_observation')
        raw['postgres']=[{'id':row['id'],'proof':{'canonical_dispatch_rows':1,'canonical_delivery_rows':1},'event_coordinates':[{'kind':kind,'metadata':value}for kind,values in row['event_metadata'].items()for value in values]+[{'kind':'delivery','metadata':row['delivery_event_metadata']}]}for row in native['messages']]
        for entry in raw['native_delivery_transactions']:
            proof=entry['proof'];sdk=proof['sdk'];raw['family_native_row_proofs'].append({'id':proof['message_ids'][0],'identity':entry['transaction_hash'],'signed_wire':proof['signed_wire'],'intent_discriminator':sdk['intent_discriminator'],'epoch_range':[sdk['start_epoch_inclusive'],sdk['end_epoch_exclusive']],'actual_fee':proof['fee'],'context':'0x'+'01'*32,'expected_context_checked':False,'configuration_authority_verified':False})
        return raw
    def test_public_preserves_real_sql_coordinates_sdk_epochs_authorities_and_fees(self):
        raw=self.snapshot();value=owner.public_native_snapshot(raw)
        self.assertEqual(len(value['native_delivery_transactions']),4)
        for source,target in zip(raw['postgres'],value['postgres']):self.assertEqual(target['canonical_event_rows'],source['event_coordinates'])
        tx=value['native_delivery_transactions'][0]['Radix'];self.assertEqual(tx['actual_fee'],{'gas_used':3,'fee_paid_attos':11,'tokens_used':9})
        self.assertEqual(tx['sdk']['intent_discriminator'],2**64-1);self.assertEqual(tx['sdk']['network'],240)
        self.assertFalse(tx['SDK_Ed25519_validation']['new_independent_crypto_reconstruction'])
        self.assertEqual(value['family_native_row_proofs'][0]['epoch_range'],[100,102])
    def test_public_omits_raw_sdk_message_metadata_signed_wire_and_unknown_fields(self):
        raw=self.snapshot();proof=raw['native_delivery_transactions'][0]['proof'];proof['transaction']['private']='DO-NOT-EXPORT';proof['sdk']['private']='DO-NOT-EXPORT';proof['signed_wire']['private']='DO-NOT-EXPORT';raw['postgres'][0]['event_coordinates'][0]['metadata']['private']='DO-NOT-EXPORT'
        raw['family_native_row_proofs'][0]['independently_verified_signature']='DO-NOT-EXPORT'
        value=owner.public_native_snapshot(raw);wire=json.dumps(value);self.assertNotIn('DO-NOT-EXPORT',wire)
        sdk=value['native_delivery_transactions'][0]['Radix']['sdk'];self.assertNotIn('metadata',sdk);self.assertNotIn('message',sdk);self.assertNotIn('visible_components',sdk)
        self.assertNotIn('signed_wire',value['family_native_row_proofs'][0])
    def test_public_unknown_fee_stays_unknown_and_zero_fee_stays_present(self):
        for paid,expected in((None,None),('0',{'gas_used':3,'fee_paid_attos':0,'tokens_used':0})):
            value=owner.public_native_snapshot(self.snapshot(paid));self.assertEqual(value['native_delivery_transactions'][0]['Radix']['actual_fee'],expected)
    def test_public_refuses_wrong_sdk_schema_network_intent_epoch_fee_or_malformed_coordinate(self):
        raw=self.snapshot()
        for key,value in(('network',1),('schema',True),('op','fixture'),('intent_hash','ee'*32),('start_epoch_inclusive',101),('intent_discriminator',True)):
            changed=copy.deepcopy(raw);changed['native_delivery_transactions'][0]['proof']['sdk'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):owner.public_native_snapshot(changed)
        changed=copy.deepcopy(raw);changed['native_delivery_transactions'][0]['proof']['fee']['private']='DO-NOT-EXPORT'
        with self.assertRaises(ValueError):owner.public_native_snapshot(changed)
        changed=copy.deepcopy(raw);changed['postgres'][0]['event_coordinates'][0]['metadata']['transaction_index']=0
        with self.assertRaises(ValueError):owner.public_native_snapshot(changed)
    def test_public_refuses_changed_stopped_discriminator_wire_or_authority_claim(self):
        raw=self.snapshot()
        for key,value in(('intent_discriminator',1),('configuration_authority_verified',True),('signed_wire',{'bytes':1,'sha256':'aa'*32})):
            changed=copy.deepcopy(raw);changed['family_native_row_proofs'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):owner.public_native_snapshot(changed)


    def test_checkpoint_and_restart_publications_keep_safe_state_and_no_location_config(self):
        raw=self.snapshot();proof={'chain':'radixtest0','metadata':{},'verified_checkpoint_objects':[],'published_bytes':[],'canonical_tree':{'count':2,'frontier':['ab'*32]*32},'announced_locations':[['file:///DO-NOT-EXPORT-CONFIG']]}
        raw['checkpoint_proofs']=[proof];raw['same_db_restart_readiness']={'actual_native_dispatches':4,'actual_native_deliveries':4,'actual_publications':[proof],'no_account_nonce_claim':True,'shared_parentwait_and_600_policy_required':True}
        value=owner.public_native_snapshot(raw);self.assertEqual(value['checkpoint_proofs'][0]['canonical_tree']['count'],2)
        self.assertEqual(value['same_db_restart_readiness']['actual_publications'][0]['canonical_tree']['count'],2)
        self.assertTrue(value['same_db_restart_readiness']['no_account_nonce_claim']);self.assertNotIn('DO-NOT-EXPORT',json.dumps(value))
        changed=copy.deepcopy(raw);changed['same_db_restart_readiness']['no_account_nonce_claim']=False
        with self.assertRaises(ValueError):owner.public_native_snapshot(changed)
    def test_public_stored_authority_is_closed_and_adds_no_reconstruction_claim(self):
        raw=self.snapshot();message=raw['messages'][0];proof=next(p['proof']for p in raw['native_delivery_transactions']if p['proof']['message_ids']==[message['id']])
        authority={'protocol':'radix','origin':message['origin'],'destination':message['destination'],'mailbox':'0x'+'01'*32,'chain_id':'240','origin_hook':'0x'+'02'*32,'operation_id':message['id'],'generation':1,'kind':'process','target':None}
        raw['native_operations']=[{'id':message['id'],'operation':{'authority':authority,'signed':proof['signed_wire'],'private':'DO-NOT-EXPORT'}}]
        value=owner.public_native_snapshot(raw);self.assertEqual(value['native_operations'][0]['operation']['authority'],authority)
        self.assertFalse(value['Radix_evidence_scope']['public_projection_adds_independent_crypto_credit'])
        raw['native_operations'][0]['operation']['authority']['private']='DO-NOT-EXPORT'
        with self.assertRaises(ValueError):owner.public_native_snapshot(raw)
    def test_projection_never_imports_or_calls_address_sdk_or_rpc_helpers(self):
        with mock.patch.object(m,'address_bytes',side_effect=AssertionError('No late verifier import')):
            value=m.native_transaction(self.snapshot()['native_delivery_transactions'][0])
        self.assertEqual(value['sdk']['network'],240)
    def test_public_refuses_wrong_final_state_ledger_or_receipt_success(self):
        raw=self.snapshot()
        for key,value in(('final_state',0),('state_version',True),('ledger_state',{'network':'mainnet','state_version':1000,'epoch':100})):
            changed=copy.deepcopy(raw);changed['native_delivery_transactions'][0]['proof'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):owner.public_native_snapshot(changed)
        changed=copy.deepcopy(raw);changed['native_delivery_transactions'][0]['proof']['transaction']['transaction_status']='CommittedFailure'
        with self.assertRaises(ValueError):owner.public_native_snapshot(changed)
    def test_malformed_coordinate_duplicate_or_nested_payload_never_reaches_public_output(self):
        raw=self.snapshot();row=raw['postgres'][0]['event_coordinates'][0];raw['postgres'][0]['event_coordinates'].append(copy.deepcopy(row))
        with self.assertRaises(ValueError):owner.public_native_snapshot(raw)
        raw=self.snapshot();raw['postgres'][0]['event_coordinates'][0]['metadata']['chain']={'private':'DO-NOT-EXPORT'}
        with self.assertRaises(ValueError):owner.public_native_snapshot(raw)


if __name__=='__main__':unittest.main()
