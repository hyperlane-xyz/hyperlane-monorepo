"""Exact Source Starknet HTTP fallback notices; no chain/agent/SDK execution."""
import copy
import socket
import threading
import unittest
import urllib.parse
from unittest import mock

import sys
from pathlib import Path
saved_path=list(sys.path)
try:
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    import multivm_evidence as evidence
    import multivm_session as sessions
    import multivm_starknet as stark
finally:
    sys.path[:]=saved_path


class StarknetPeerTests(unittest.TestCase):
    def policy(self):
        manifest={'scenario':'starknet','case_inputs':{'sha256':'a'*64}}
        definition={'schema':1,'scenario':'starknet','endpoints':evidence.starknet_unavailable_peers()}
        case={'scenario':'starknet','chain_names':['starknettest23448593','starknettest23448594'],'domain_names':{'23448593':'starknettest23448593','23448594':'starknettest23448594'},'expected_starknet_unavailable_endpoints':definition}
        approval={'root_approved':True,'expected_starknet_unavailable_endpoints':definition}
        return manifest,case,approval

    def context(self):
        return dict(evidence.starknet_unavailable_peers()[0],scenario='starknet',role='relayer',case_inputs_sha256='a'*64)

    def proxy(self,context=None):
        value=evidence.TransparentProxy.__new__(evidence.TransparentProxy)
        value.expected_starknet_unavailable=context;value.upstream=urllib.parse.urlsplit('http://127.0.0.1:1337');value.failure=mock.Mock()
        return value

    def session(self):
        manifest,case,approval=self.policy();value=sessions.Session.__new__(sessions.Session)
        value.manifest=manifest;value.case=case;value.approval=approval;value.lock=threading.RLock()
        value.starknet_unavailable_definitions=sessions.starknet_expected_unavailable_definitions(manifest,case,approval)
        value.starknet_unavailable_notices=[];value.starknet_healthy_rpc_fallbacks={}
        value.failures=[];value.transport_notices=[];value.append=mock.Mock();value.lifecycle=sessions.Lifecycle()
        value.captures=[{'captured_monotonic_ns':100,'original':{'role':'relayer','role_chain_names':['starknettest23448593'],'chains':{'starknettest23448593':{}}}}]
        return value

    def notice(self,clock=110):
        return {'kind':'expected_starknet_rpc_endpoint_unavailable','context':self.context(),'error_type':'ConnectionRefusedError','error':'public Source dead peer','monotonic_ns':clock,'positive_receipt_credit':False}

    def healthy(self,clock=120):
        return {'chain':'starknettest23448593','role':'relayer','endpoint_field':'rpcurls','upstream':'http://127.0.0.1:5050','status':200,'received_monotonic_ns':clock,'request':{'jsonrpc':'2.0','id':12,'method':'starknet_chainId','params':[]},'response':{'jsonrpc':'2.0','id':12,'result':'0x534e5f5345504f4c4941'}}

    def test_policy_exact_two_domains_six_dead_peers(self):
        manifest,case,approval=self.policy();rows=sessions.starknet_expected_unavailable_definitions(manifest,case,approval)
        self.assertEqual(len(rows),6);self.assertEqual({row['ordinal'] for row in rows},{0,1,3})
        self.assertEqual({row['domain'] for row in rows},{23448593,23448594})

    def test_absent_policy_does_not_grant_any_notice(self):
        manifest,case,approval=self.policy();case.pop('expected_starknet_unavailable_endpoints')
        self.assertEqual(sessions.starknet_expected_unavailable_definitions(manifest,case,{}),())
        with self.assertRaises(ValueError):sessions.starknet_expected_unavailable_definitions(manifest,case,approval)

    def test_wrong_family_domains_peers_ordinals_schema_and_approval_reject(self):
        manifest,case,approval=self.policy()
        for key,value in [('scenario','cosmwasm'),('chain_names',['foreign','starknettest23448594']),('domain_names',{'23448593':'foreign','23448594':'starknettest23448594'})]:
            changed=copy.deepcopy(case);changed[key]=value
            with self.assertRaises(ValueError):sessions.starknet_expected_unavailable_definitions(manifest,changed,approval)
        for key,value in [('ordinal',2),('domain',23448594),('upstream','http://127.0.0.1:5050'),('phase','response_parse'),('error_type','TimeoutError')]:
            changed=copy.deepcopy(case);changed['expected_starknet_unavailable_endpoints']['endpoints'][0][key]=value
            with self.assertRaises(ValueError):sessions.starknet_expected_unavailable_definitions(manifest,changed,{'root_approved':True,'expected_starknet_unavailable_endpoints':changed['expected_starknet_unavailable_endpoints']})
        for changed in [{},dict(approval,root_approved=False)]:
            with self.assertRaises(ValueError):sessions.starknet_expected_unavailable_definitions(manifest,case,changed)

    def test_context_rejects_every_crossed_boundary_before_socket_creation(self):
        for key,value in [('scenario','evm'),('chain','foreign'),('domain',23448594),('ordinal',2),('field','customrpcurls'),('phase','response_parse'),('error_type','TimeoutError'),('upstream','http://127.0.0.1:5050'),('healthy_fallback','http://127.0.0.1:5070'),('role','foreign'),('case_inputs_sha256','bad')]:
            context=dict(self.context(),**{key:value})
            with mock.patch.object(evidence.socket,'socket') as create:
                with self.assertRaises(ValueError):evidence.TransparentProxy('http://127.0.0.1:1337',lambda *_:None,lambda *_:None,expected_starknet_unavailable=context)
                create.assert_not_called()

    def test_captured_source_order_and_effective_field_are_bound(self):
        manifest,case,approval=self.policy();definitions=sessions.starknet_expected_unavailable_definitions(manifest,case,approval)
        chain={'domainid':23448593,'rpcurls':[{'http':url} for url in ['http://127.0.0.1:1337','http://127.0.0.1:1338','http://127.0.0.1:5050','http://127.0.0.1:1347']]}
        for ordinal in (0,1,3):self.assertEqual(sessions.starknet_expected_peer_context(definitions,manifest,case['chain_names'][0],chain,'relayer','rpcurls',ordinal,chain['rpcurls'][ordinal]['http'])['ordinal'],ordinal)
        self.assertIsNone(sessions.starknet_expected_peer_context(definitions,manifest,case['chain_names'][0],chain,'relayer','rpcurls',2,chain['rpcurls'][2]['http']))
        for changed in [dict(chain,customrpcurls=chain['rpcurls']),dict(chain,domainid=23448594),dict(chain,rpcurls=chain['rpcurls'][::-1]),dict(chain,rpcurls=chain['rpcurls'][:3])]:
            with self.assertRaises(ValueError):sessions.starknet_expected_peer_context(definitions,manifest,case['chain_names'][0],changed,'relayer','rpcurls',0,chain['rpcurls'][0]['http'])

    def test_only_exact_upstream_connect_refusal_produces_diagnostic(self):
        proxy=self.proxy(self.context())
        with mock.patch.object(evidence.socket,'create_connection',side_effect=ConnectionRefusedError('Source dead peer')):
            self.assertIsNone(proxy._open_upstream())
        value=proxy.failure.call_args.args[0]
        self.assertEqual(value['kind'],'expected_starknet_rpc_endpoint_unavailable');self.assertFalse(value['positive_receipt_credit']);self.assertEqual(value['context'],self.context())

    def test_real_kernel_refusal_has_no_fabricated_rpc_response(self):
        # Allocate/close an owned local port; do not contact a possibly foreign
        # service on Source1337. The injected socket factory asserts Source's
        # requested address, then obtains the real OS refusal from that port.
        with socket.socket() as listener:listener.bind(('127.0.0.1',0));address=listener.getsockname()
        real_connect=socket.create_connection;proxy=self.proxy(self.context())
        def connect(requested,timeout):
            self.assertEqual(requested,('127.0.0.1',1337));return real_connect(address,timeout=.2)
        with mock.patch.object(evidence.socket,'create_connection',side_effect=connect):self.assertIsNone(proxy._open_upstream())
        self.assertEqual(proxy.failure.call_args.args[0]['error_type'],'ConnectionRefusedError')

    def test_unapproved_refusal_timeout_or_other_errors_stay_hard(self):
        for context,error in [(None,ConnectionRefusedError('healthy')), (self.context(),TimeoutError('deadline')), (self.context(),OSError('transport')), (self.context(),ValueError('schema'))]:
            proxy=self.proxy(context)
            with mock.patch.object(evidence.socket,'create_connection',side_effect=error):
                with self.assertRaises(type(error)):proxy._open_upstream()
            proxy.failure.assert_not_called()
        proxy=self.proxy(self.context());proxy.report_error(ConnectionRefusedError('after connect'),'response_parse')
        self.assertIsInstance(proxy.failure.call_args.args[0],str)

    def test_notice_never_starts_clock_and_requires_fresh_actual_healthy_peer(self):
        value=self.session();value.failure(self.notice());self.assertEqual(value.failures,[]);self.assertEqual(value.lifecycle.first,{})
        with self.assertRaises(ValueError):value.require_starknet_peer_recovery()
        value.record_starknet_rpc_recovery(self.healthy());value.require_starknet_peer_recovery();self.assertEqual(value.lifecycle.first,{})
        value.failure('HTTP500/schema/canonical remain hard');self.assertTrue(value.failures)

    def test_bad_response_identity_schema_error_status_peer_role_does_not_recover(self):
        for change in [lambda r:r.update(status=500),lambda r:r.update(upstream='http://127.0.0.1:5070'),lambda r:r.update(role='validator'),lambda r:r['response'].update(id=13),lambda r:r['response'].update(jsonrpc='1.0'),lambda r:r['response'].update(error={'code':-1}),lambda r:r['response'].pop('result'),lambda r:r['request'].update(method='foreign_method')]:
            value=self.session();value.failure(self.notice());record=self.healthy();change(record);value.record_starknet_rpc_recovery(record)
            with self.assertRaises(ValueError):value.require_starknet_peer_recovery()

    def test_latest_notice_capture_and_out_of_order_callbacks_preserve_epochs(self):
        value=self.session();value.failure(self.notice());value.record_starknet_rpc_recovery(self.healthy());value.require_starknet_peer_recovery()
        value.failure(self.notice(130))
        with self.assertRaises(ValueError):value.require_starknet_peer_recovery()
        value.record_starknet_rpc_recovery(self.healthy(140));value.require_starknet_peer_recovery()
        value.captures.append({'captured_monotonic_ns':200,'original':value.captures[0]['original']})
        with self.assertRaises(ValueError):value.require_starknet_peer_recovery()
        value.record_starknet_rpc_recovery(self.healthy(220));value.record_starknet_rpc_recovery(self.healthy(150));value.require_starknet_peer_recovery()

    def healthy_batch(self, clock=120):
        record=self.healthy(clock)
        record["request"]=[record["request"], {"jsonrpc":"2.0","id":"12","method":"starknet_blockNumber","params":[]}]
        record["response"]=[{"jsonrpc":"2.0","id":"12","error":{"code":-32000,"message":"synthetic pending"}}, record["response"]]
        return record

    def test_actual_session_observe_matched_mixed_batch_recovers_without_positive_receipt_credit(self):
        value=self.session();value.failure(self.notice());record=self.healthy_batch()
        value.family=stark.Adapter(value.manifest,value.case);value.activity={};value.successful_activity={}
        request={"json":record["request"],"wire":sessions.json.dumps(record["request"]).encode(),"requested_monotonic_ns":115,"start":"POST / HTTP/1.1"};response={"wire":sessions.json.dumps(record["response"]).encode()}
        with mock.patch.object(sessions.multivm_diagnostics,"note_success"):
            value.observe(record["chain"],record["role"],record["endpoint_field"],record["upstream"],request,record["response"],200,120,response)
        value.require_starknet_peer_recovery();self.assertEqual(value.lifecycle.first,{})
        self.assertEqual(value.family.receipt_members,{});self.assertEqual(value.failures,[])

    def test_batch_recovery_rejects_unmatched_duplicate_typed_error_only_or_foreign_success(self):
        changes=[lambda r:r["response"].pop(),lambda r:r["response"][0].update(id=13),lambda r:r["request"][0].update(id=True),lambda r:r["response"][1].update(id="12"),lambda r:r["response"][1].update(jsonrpc="1.0"),lambda r:r["response"][1].update(error={"code":-1,"message":"error plus result"}),lambda r:r["response"][1].pop("result"),lambda r:r["request"][0].update(method="foreign_method"),lambda r:r.update(status=500),lambda r:r.update(upstream="http://127.0.0.1:5070"),lambda r:r.update(role="validator")]
        for change in changes:
            value=self.session();value.failure(self.notice());record=self.healthy_batch();change(record)
            value.record_starknet_rpc_recovery(record)
            with self.assertRaisesRegex(ValueError,"no fresh actual healthy fallback"):value.require_starknet_peer_recovery()
            self.assertEqual(value.lifecycle.first,{})

    def test_batch_recovery_preserves_notice_and_new_capture_freshness(self):
        value=self.session();value.failure(self.notice());value.record_starknet_rpc_recovery(self.healthy_batch());value.require_starknet_peer_recovery()
        value.failure(self.notice(130))
        with self.assertRaises(ValueError):value.require_starknet_peer_recovery()
        value.record_starknet_rpc_recovery(self.healthy_batch(140));value.require_starknet_peer_recovery()
        value.captures.append({"captured_monotonic_ns":200,"original":value.captures[0]["original"]})
        with self.assertRaises(ValueError):value.require_starknet_peer_recovery()
        value.record_starknet_rpc_recovery(self.healthy_batch(220));value.record_starknet_rpc_recovery(self.healthy_batch(150));value.require_starknet_peer_recovery()
        self.assertEqual(value.lifecycle.first,{})

    def test_cross_case_or_positive_receipt_notice_rejects(self):
        for change in [lambda row:row.update(positive_receipt_credit=True),lambda row:row.update(error_type='TimeoutError'),lambda row:row['context'].update(case_inputs_sha256='b'*64),lambda row:row['context'].update(phase='response_parse')]:
            value=self.session();notice=self.notice();change(notice)
            with self.assertRaises(ValueError):value.failure(notice)
            self.assertEqual(value.lifecycle.first,{})


if __name__=='__main__':unittest.main()
