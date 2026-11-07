"""Pure protocol/adapter controls. Mock oracle output is NOT SDK/chain evidence."""
import copy
import gzip
import hashlib
import json
import pathlib
import random
import unittest

from multivm_radix import Adapter, address_bytes, address_text, attos, event_value, fee, full_component, identity, integer, receipt, tree_root, verify_signed_canonical, process_sequence, canonical_event
from multivm_sql import sql_event_query


def digest(value):
    # Deliberately no crypto acceptance: a deterministic mock for schema tests.
    raw = bytes.fromhex(value[2:]) if value.startswith('0x') else value.encode()
    return '0x' + hashlib.sha3_256(raw).hexdigest()


def wire(nonce=0, origin=9913374, destination=9913375):
    return '0x' + (b'\x03' + nonce.to_bytes(4,'big') + origin.to_bytes(4,'big') + bytes(32) + destination.to_bytes(4,'big') + bytes([2])*32 + b'fixture').hex()


def contract(value):
    return address_text(bytes([0xc0]) + bytes([value])*29)


def field(kind, name, value):
    return {'kind': kind, 'field_name': name, 'hex' if kind == 'Bytes' else 'value': value}


def event(name, fields, emitter=None):
    return {'name':name,'emitter':{'type':'Method','entity':{'entity_address':emitter or contract(1)}}, 'data':{'kind':'Tuple','type_name':name,'fields':fields}}


def dispatch(nonce=0):
    value=wire(nonce)
    return event('DispatchEvent',[field('U32','destination','9913375'),field('Bytes','recipient','02'*32),field('Bytes','message',value[2:]),field('U32','sequence',str(nonce))])


def case():
    names=['radixtest0','radixtest1']
    return {'chain_names':names,'domain_names':{'9913374':names[0],'9913375':names[1]},'initial_corpus':{'dispatches':4,'deliveries':4,'zero_insertions':0,'failed_body':0,'double_insertions':0},'additional_refused_dispatches':0,'validator_addresses':{name:'0x'+'11'*20 for name in names},'relayer_public_keys':{name:'0x'+'22'*32 for name in names},'relayer_accounts':{name:address_text(bytes([0xc1])+bytes([3])*29,'account') for name in names},'payment_resource':address_text(bytes([0x5d])+bytes([4])*29,'resource'),'family_tools':{'radix_reference':{'path':'/not-executed','bytes':1,'sha256':'1'*64}}}


def chain(domain):
    return {'protocol':'radix','chainid':240,'domainid':domain,'networkname':'localnet','mailbox':contract(1),'merkletreehook':contract(2),'interchaingaspaymaster':contract(3),'validatorannounce':contract(4),'rpcurls':[{'http':'http://127.0.0.1:3333/core'}],'gatewayurls':[{'http':'http://127.0.0.1:5308/'}],'blocks':{'confirmations':1},'index':{'from':0}}


class Session:
    def __init__(self):
        self.chains={'radixtest0':chain(9913374),'radixtest1':chain(9913375)}
        self.broadcasts=[]
        self.inclusions=[]
        self.http=[]
        self.answers=[]
        self.reference=[]
        self.submitted_message=wire()
        self.sdk={}
        self.boolean=True
    def chain_config(self,name): return self.chains[name]
    def keccak(self,value): return digest(value)
    def record_broadcast(self,name,txid,sha,message_ids=None):
        self.broadcasts.append({'chain':name,'transaction_hash':txid,'raw_transaction_sha256':sha,'message_ids':message_ids})
    def record_inclusion(self,*args): self.inclusions.append(args)
    def native_http(self,endpoint,path,payload):
        self.http.append((endpoint,path,payload))
        return self.answers.pop(0)
    def family_tool(self,name,args,stdin=None,timeout=None):
        self.reference.append((name,args,json.loads(stdin),timeout))
        request=json.loads(stdin)
        if request['op']=='notarized':
            result={'network':240,'public_key':request['public_key'],'account':request['account'],'mailbox':request['mailbox'],'intent_hash':'ab'*32,'signed_intent_hash':'cd'*32,'notarized_hash':'ef'*32,'message':self.submitted_message[2:],'metadata':'55'*20,'visible_components':[],'start_epoch_inclusive':100,'end_epoch_exclusive':102,'intent_discriminator':2**64-1,'locked_fee':'1.5',**self.sdk}
        elif request['op']=='byte_argument': result={'hex':digest(wire())[2:] if request['kind']=='decode_bytes' else 'mock-encoded-'+str(request['hex'])}
        else: result={'kind':request['kind'],'value':self.boolean}
        return json.dumps({'schema':1,'op':request['op'],**result})


class CollectedFixture(Adapter):
    """Actual adapter assembly with mock RPC/SDK only, no cryptographic credit."""
    def __init__(self, fee_paid='0.000000000000000011', units=3):
        super().__init__({'scenario':'radix'},case())
        self.session=Session()
        self.transactions={}
        self.origins={}
        messages=[]
        for origin_name,origin,destination_name,destination,offset in [('radixtest0',9913374,'radixtest1',9913375,0),('radixtest1',9913375,'radixtest0',9913374,2)]:
            for nonce in range(2):
                packed=wire(nonce,origin,destination)
                message_id=digest(packed)
                txid='0x'+bytes([offset+nonce+1]).hex()*32
                self.session.submitted_message=packed
                self.session.sdk={'intent_hash':txid[2:]}
                raw=b'mock-private-SBOR'+bytes([offset+nonce])
                self._submission(self.session,destination_name,self.session.chains[destination_name],{'notarized_transaction_hex':raw.hex()})
                state=10+10*(offset+nonce)
                dispatch_fields=[field('U32','destination',destination),field('Bytes','recipient','02'*32),field('Bytes','message',packed[2:]),field('U32','sequence',nonce)]
                events=[{'name':'Unrelated'},event('InsertedIntoTreeEvent',[field('Bytes','id',message_id[2:]),field('U32','index',nonce)],contract(2)),event('GasPayment',[field('Bytes','message_id',message_id[2:]),field('U32','destination_domain',destination),field('Decimal','gas_amount','2'),field('Decimal','payment','0.000000000000000007'),field('String','resource_address',self.case['payment_resource']),field('U32','sequence',nonce)],contract(3)),event('DispatchEvent',dispatch_fields)]
                transaction={'intent_hash':address_text(bytes([40+offset+nonce])*32,'txid'),'state_version':state,'transaction_status':'CommittedSuccess','receipt':{'status':'CommittedSuccess','events':events}}
                self.transactions[(origin_name,identity(transaction['intent_hash']))]=transaction
                self.origins.setdefault(origin_name,[]).append(transaction)
                messages.append((destination_name,txid,message_id,nonce,raw))
        # Independent destination scheduling: origin nonce1 executes BEFORE0.
        for name in self.case['chain_names']:
            for sequence,(_,txid,message_id,nonce,raw) in enumerate(sorted((m for m in messages if m[0]==name),key=lambda m:-m[3])):
                state=100+sequence*10
                events=[{'name':'Unrelated'},event('ProcessIdEvent',[field('Bytes','message_id',message_id[2:]),field('U32','sequence',sequence)])]
                transaction={'intent_hash':address_text(bytes.fromhex(txid[2:]),'txid'),'state_version':state,'transaction_status':'CommittedSuccess','epoch':100,'raw_hex':raw.hex(),'payload_hash':address_text(bytes.fromhex('ef'*32),'notarizedtransaction'),'receipt':{'status':'CommittedSuccess','events':events,'fee_summary':{'execution_cost_units_consumed':units,'finalization_cost_units_consumed':0}}}
                if fee_paid is not None:transaction['fee_paid']=fee_paid
                self.transactions[(name,txid)]=transaction
                self.origins[name].append(transaction)
    def _final_state(self,session,configured):return 1000
    def _stream(self,session,configured,contract_value,final_state):
        name=self.case['domain_names'][str(configured['domainid'])]
        return copy.deepcopy(sorted(self.origins[name],key=lambda t:t['state_version']))
    def _receipt(self,session,configured,txid,final_state):
        name=self.case['domain_names'][str(configured['domainid'])]
        return receipt({'ledger_state':{'network':'localnet','state_version':1000,'epoch':100},'transaction':copy.deepcopy(self.transactions[(name,txid)])},txid,final_state)
    def _call(self,session,configured,component,method,arguments,state,kind):
        if method=='processed':return 2
        if method=='delivered':return True
        if method=='default_ism':return address_bytes(contract(6)).hex()
        if method=='route':return address_bytes(contract(7)).hex()
        if method=='validators_and_threshold':return {'validators':['11'*20],'threshold':1}
        raise AssertionError('unexpected mock call '+method)


class RadixTests(unittest.TestCase):
    def setUp(self):
        self.case=case()
        self.adapter=Adapter({'scenario':'radix'},self.case)
        self.session=Session()

    def test_address_bounded_generated_roundtrip_and_mutation(self):
        rng=random.Random(0x5241444958)
        for kind,size in [('component',30),('account',30),('resource',30),('txid',32),('notarizedtransaction',32)]:
            for _ in range(32):
                raw=rng.randbytes(size)
                value=address_text(raw,kind)
                self.assertEqual(address_bytes(value,kind),raw)
                changed=value[:-1]+('q' if value[-1]!='q' else 'p')
                with self.assertRaises(ValueError): address_bytes(changed,kind)
        # 160 generated cases, seed above; no claim to run an SDK here.

    def test_address_sdk_mainnet_fixture_rejected_by_localnet(self):
        path=pathlib.Path(__file__).parents[1]/'src/radix/fixtures/sdk.json.gz'
        data=json.loads(gzip.decompress(path.read_bytes()))
        with self.assertRaises(ValueError): address_bytes(data['account_text'],'account')

    def test_address_kind_case_padding_and_width(self):
        encoded=contract(1)
        for value in [encoded.upper(),encoded+'q',encoded.replace('_loc','_rdx'),encoded[:-1], 'component_loc1qqqqqq']:
            with self.assertRaises(ValueError): address_bytes(value)
        with self.assertRaises(ValueError): address_bytes(encoded,'account')
        with self.assertRaises(ValueError): address_text(bytes(32))
        self.assertEqual(full_component(encoded),'0x0000'+address_bytes(encoded).hex())

    def test_case_source_scope_and_no_constructor_io(self):
        self.adapter.validate_case()
        for key,value in [('initial_corpus',dict(self.case['initial_corpus'],deliveries=3)),('domain_names',{'1':'radixtest0','2':'radixtest1'}),('family_tools',{}),('additional_refused_dispatches',1)]:
            other=copy.deepcopy(self.case);other[key]=value
            with self.assertRaises(ValueError): Adapter({'scenario':'radix'},other).validate_case()
        self.assertEqual(self.adapter.transport('customgatewayurls'),'http-json')
        with self.assertRaises(ValueError): self.adapter.transport('grpcurls')

    def test_actual_chain_network_and_contract_controls(self):
        self.adapter._chains(self.session)
        self.session.chains['radixtest0']['networkname']='mainnet'
        with self.assertRaises(ValueError): self.adapter._chains(self.session)

    def test_dispatch_exact_native_schema_and_wire(self):
        value=event_value(dispatch(),contract(1),digest)
        self.assertEqual(value['message']['id'],digest(wire()))
        self.assertEqual(value['message']['nonce'],0)
        self.assertEqual(value['message']['origin'],9913374)
        self.assertIsNone(event_value(dispatch(),contract(8),digest))

    def test_dispatch_wrong_fields_schema_nonce_and_recipient(self):
        for index,key,new in [(0,'kind','U64'),(0,'field_name','wrong'),(0,'value','0009913375'),(0,'value',True),(3,'value','1'),(1,'hex','00'*32)]:
            bad=dispatch();bad['data']['fields'][index][key]=new
            with self.assertRaises(ValueError): event_value(bad,contract(1),digest)
        bad=dispatch();bad['data']['type_name']='Spoof'
        with self.assertRaises(ValueError): event_value(bad,contract(1),digest)
        bad=dispatch();bad['data']['fields'].append(field('U32','extra',0))
        with self.assertRaises(ValueError): event_value(bad,contract(1),digest)

    def test_delivery_tree_and_payment_source_fields(self):
        ident=digest(wire())
        self.assertEqual(event_value(event('ProcessIdEvent',[field('Bytes','message_id',ident[2:]),field('U32','sequence','0')]),contract(1),digest),{'kind':'delivery','id':ident,'sequence':0})
        insertion=event_value(event('InsertedIntoTreeEvent',[field('Bytes','id',ident[2:]),field('U32','index',4)]),contract(1),digest)
        self.assertEqual(insertion['index'],4)
        payment=event('GasPayment',[field('Bytes','message_id',ident[2:]),field('U32','destination_domain',9913375),field('Decimal','gas_amount','2.9'),field('Decimal','payment','0.000000000000000007'),field('String','resource_address',self.case['payment_resource']),field('U32','sequence',0)])
        parsed=event_value(payment,contract(1),digest)
        self.assertEqual((parsed['gas_amount'],parsed['payment']),(2,7))
        payment['data']['fields'][2]['value']='-1'
        self.assertEqual(event_value(payment,contract(1),digest)['gas_amount'],0)

    def test_decimal_exact_floor_unknown_and_overflow(self):
        self.assertEqual(attos('1.000000000000000001'),10**18+1)
        for bad in ['','1e2','+1','1.0000000000000000001',' 1','9'*80]:
            with self.assertRaises(ValueError): attos(bad)
        self.assertIsNone(fee({}))
        actual=fee({'fee_paid':'0.000000000000000011','receipt':{'fee_summary':{'execution_cost_units_consumed':2,'finalization_cost_units_consumed':1}}})
        self.assertEqual(actual,{'gas_used':3,'fee_paid_attos':11,'tokens_used':9})
        with self.assertRaises(ValueError): fee({'fee_paid':'-1','receipt':{'fee_summary':{'execution_cost_units_consumed':2,'finalization_cost_units_consumed':1}}})
        with self.assertRaises(ValueError): integer(True)

    def receipt(self):
        txid=address_text(bytes.fromhex('ab'*32),'txid')
        return {'ledger_state':{'network':'localnet','state_version':100,'epoch':100},'transaction':{'intent_hash':txid,'state_version':90,'transaction_status':'CommittedSuccess','receipt':{'status':'CommittedSuccess','events':[]}}}

    def test_receipt_native_state_identity_and_failure_controls(self):
        value=self.receipt()
        proof=receipt(value,'0x'+'ab'*32,99)
        self.assertEqual(proof['source_state_version_hash'],'0x'+(90).to_bytes(32,'big').hex())
        self.assertIsNone(proof['fee'])
        for name,bad in [('transaction_status','Pending'),('transaction_status','CommittedFailure'),('state_version',100)]:
            row=copy.deepcopy(value);row['transaction'][name]=bad
            with self.assertRaises(ValueError): receipt(row,'0x'+'ab'*32,99)
        with self.assertRaises(ValueError): receipt(value,'0x'+'cd'*32,99)
        value['transaction']['receipt']['status']='CommittedFailure'
        with self.assertRaises(ValueError): receipt(value,'0x'+'ab'*32,99)

    def test_submit_uses_admitted_reference_and_native_sbor_digest(self):
        txid=self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d0001'})
        self.assertEqual(txid,'0x'+'ab'*32)
        record=self.session.broadcasts[0]
        self.assertEqual(record['raw_transaction_sha256'],hashlib.sha256(bytes.fromhex('4d0001')).hexdigest())
        self.assertNotEqual(record['raw_transaction_sha256'],hashlib.sha256(b'{"notarized_transaction_hex":"4d0001"}').hexdigest())
        self.assertEqual(self.session.reference[0][0:2],('radix_reference',['evidence']))
        self.assertEqual(self.session.reference[0][2]['network'],240)

    def test_submitted_wrong_destination_and_oracle_authority(self):
        self.session.submitted_message=wire(destination=9913374)
        with self.assertRaises(ValueError): self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d01'})
        self.session.submitted_message=wire()
        self.session.sdk={'public_key':'00'*32}
        with self.assertRaises(ValueError): self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d01'})

    def test_same_intent_changed_wire_rejected(self):
        self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d01'})
        with self.assertRaises(ValueError): self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d02'})

    def observed(self,path,request,response):
        return {'chain':'radixtest1','role':'relayer','path':path,'status':200,'request':request,'response':response,'received_monotonic_ns':1234}

    def test_status_positive_before_submit_retains_first_witness(self):
        txid=address_text(bytes.fromhex('ab'*32),'txid')
        event=self.observed('/transaction/status',{'intent_hash':txid},{'status':'CommittedSuccess','committed_state_version':90,'ledger_state':{'network':'localnet','state_version':100,'epoch':100}})
        self.adapter.observe(self.session,event)
        self.assertEqual(self.session.inclusions,[])
        self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d01'})
        self.assertEqual(self.session.inclusions[0][3],1234)
        self.assertEqual(self.session.inclusions[0][2],'0x'+'ab'*32)

    def test_pending_failed_foreign_receipts_do_not_admit(self):
        txid=address_text(bytes.fromhex('ab'*32),'txid')
        for status in ['Pending','Unknown','CommittedFailure','Rejected']:
            self.adapter.observe(self.session,self.observed('/transaction/status',{'intent_hash':txid},{'status':status}))
        self.assertEqual(self.session.inclusions,[])
        self.assertEqual(self.adapter.pending_positive,{})

    def test_actual_stream_delivery_is_an_earlier_positive_effect(self):
        transaction=self.receipt()['transaction']
        transaction['receipt']['events']=[event('ProcessIdEvent',[field('Bytes','message_id',digest(wire())[2:]),field('U32','sequence',0)])]
        response={'ledger_state':{'network':'localnet','state_version':100,'epoch':100},'items':[transaction]}
        self.adapter.observe(self.session,self.observed('/stream/transactions',{},response))
        self.assertEqual(self.session.inclusions[0][1:4],(digest(wire()),'0x'+'ab'*32,1234))
        self.session.inclusions=[]
        transaction['receipt']['events']=[]
        self.adapter.observe(self.session,self.observed('/stream/transactions',{},response))
        self.assertEqual(self.session.inclusions,[])

    def test_delivered_getter_before_submit_retains_unknown_identity_witness(self):
        request={'target':{'type':'Method','component_address':contract(1),'method_name':'delivered'},'arguments':['independently-decoded-by-mock']}
        response={'status':'Succeeded','at_ledger_state':{'state_version':90},'output':{'hex':'mock-bool-output'}}
        self.adapter.observe(self.session,self.observed('/transaction/call-preview',request,response))
        self.assertEqual(self.session.inclusions[0][1:4],(digest(wire()),'0x'+'00'*32,1234))
        self.session.inclusions=[];self.session.boolean=False
        self.adapter.observe(self.session,self.observed('/transaction/call-preview',request,response))
        self.assertEqual(self.session.inclusions,[])

    def test_delivered_pinned_state_and_missing_gateway_fields_never_credit(self):
        request={'target':{'type':'Method','component_address':contract(1),'method_name':'delivered'},'arguments':['mock'],'at_ledger_state':{'type':'ByStateVersion','state_version':123}}
        response={'status':'Succeeded','at_ledger_state':{'state_version':122},'output':{'hex':'mock'}}
        with self.assertRaises(ValueError):self.adapter.observe(self.session,self.observed('/transaction/call-preview',request,response))
        self.assertEqual(self.session.inclusions,[])
        self.assertEqual(self.session.reference,[])
        response.pop('at_ledger_state')
        with self.assertRaises(ValueError):self.adapter.observe(self.session,self.observed('/transaction/call-preview',request,response))
        request.pop('at_ledger_state');response['at_ledger_state']={'state_version':123}
        self.adapter.observe(self.session,self.observed('/transaction/call-preview',request,response))
        self.assertEqual(len(self.session.inclusions),1)
        self.session.inclusions=[]
        for omitted in ['state_version','epoch']:
            ledger={'network':'localnet','state_version':123,'epoch':100};ledger.pop(omitted)
            status={'status':'CommittedSuccess','committed_state_version':120,'ledger_state':ledger}
            with self.assertRaises(ValueError):self.adapter.observe(self.session,self.observed('/transaction/status',{'intent_hash':address_text(bytes.fromhex('ab'*32),'txid')},status))
        self.assertEqual(self.session.inclusions,[])

    def test_direct_pinned_call_rejects_boolean_state_before_sdk_decode(self):
        self.session.answers=[{'status':'Succeeded','at_ledger_state':{'state_version':True},'output':{'hex':'mock'}}]
        with self.assertRaises(ValueError):self.adapter._call(self.session,chain(9913374),contract(1),'delivered',[],1,'bool')
        self.assertEqual(self.session.reference,[])

    def test_collect_accepts_independent_destination_process_order(self):
        family=CollectedFixture()
        snapshot=family.collect(family.session,4,'initial')
        self.assertEqual(len(snapshot['deliverable_messages']),4)
        for message in snapshot['messages']:
            self.assertEqual(message['delivery_sequence'],1-message['nonce'])
            metadata=message['delivery_event_metadata']
            self.assertEqual(metadata['transaction_index'],metadata['block_number'])
            self.assertEqual(metadata['log_index'],1)
            self.assertEqual(message['event_metadata']['dispatch'][0]['log_index'],3)
            self.assertEqual(message['event_metadata']['insertion'][0]['log_index'],1)
            self.assertEqual(message['event_metadata']['payment'][0]['log_index'],2)
        rows=[{'id':'a','sequence':0,'metadata':{'block_number':10,'log_index':8}},{'id':'b','sequence':1,'metadata':{'block_number':11,'log_index':2}}]
        self.assertEqual(process_sequence(list(reversed(rows)),2),rows)
        for changed in [[rows[0],rows[0]],[dict(rows[0],sequence=1),rows[1]]]:
            with self.assertRaises(ValueError):process_sequence(changed,2)
        with self.assertRaises(ValueError):process_sequence(rows,3)

    def test_sql_emits_every_actual_native_coordinate_and_rejects_mutation(self):
        from multivm_evm import sql_message_query,sql_delivery_query
        family=CollectedFixture();snapshot=family.collect(family.session,4,'initial');accepted={}
        for message in snapshot['messages']:
            accepted[sql_message_query(message)]=f"1|1|7|2|{message['nonce']}"
            accepted[sql_delivery_query(message,message['delivery_transaction'])]='1'
            for kind,events in message['event_metadata'].items():
                for metadata in events:accepted[sql_event_query(kind,message['id'],metadata)]='1'
            accepted[sql_event_query('delivery',message['id'],message['delivery_event_metadata'])]='1'
        class Sql:
            def __init__(self):self.queries=[]
            def query_sql(self,name,query):self.queries.append((name,query));return accepted.get(query,'0')
        sql=Sql();proof=family.sql(sql,snapshot)
        self.assertEqual(len(sql.queries),24)
        self.assertTrue(all(len(row['event_coordinates'])==4 for row in proof))
        query=sql.queries[2][1]
        self.assertIn('transaction_index=10',query)
        self.assertIn('log_index=3',query)
        self.assertIn("decode('"+(10).to_bytes(32,'big').hex()+"','hex')",query)
        for key,value in [('block_number',999),('block_hash','0x'+'00'*32),('transaction_index',0),('log_index',0),('emitter','0x'+'00'*32)]:
            changed=copy.deepcopy(snapshot);changed['messages'][0]['event_metadata']['dispatch'][0][key]=value
            with self.assertRaises(ValueError):family.sql(Sql(),changed)

    def test_radix_absolute_state_version_transaction_index_remains_u64(self):
        state=2**32+7
        response=self.receipt();response['ledger_state']['state_version']=state+1;response['transaction']['state_version']=state
        proof=receipt(response,'0x'+'ab'*32,state)
        value=event('ProcessIdEvent',[field('Bytes','message_id',digest(wire())[2:]),field('U32','sequence',0)])
        metadata=canonical_event('radixtest0',chain(9913374),proof,9,value)
        self.assertEqual(metadata['transaction_index'],state)
        query=sql_event_query('delivery',digest(wire()),metadata)
        self.assertIn(f'e.transaction_index={state}',query)
        self.assertIn(f'b.height={state}',query)

    def test_split_restart_exact_shared_call_shape_and_epoch_guards(self):
        class Ready(Adapter):
            def collect(self,session,expected,phase):
                self.assertion=(expected,phase)
                return {'messages':[{}]*4,'deliverable_messages':[{}]*4}
            def checkpoints(self,session,snapshot):return ['mock-only-publication']
        family=Ready({'scenario':'radix'},case());names=family.case['chain_names']
        def epoch(offset):
            return [{'capture_ordinal':offset+i,'captured_monotonic_ns':1000+offset+i,'original':{'role':role,'role_chain_names':scope,'chains':{name:chain(9913374+j) for j,name in enumerate(names)}}} for i,(role,scope) in enumerate([('relayer',names),('validator',[names[0]]),('validator',[names[1]]),('scraper',names)])]
        before,after=epoch(0),epoch(4)
        self.assertEqual(family.readiness(None,before,after)['actual_native_deliveries'],4)
        self.assertEqual(family.assertion,(4,'after_restart'))
        for bad in [before,after[:-1],copy.deepcopy(after)]:
            if len(bad)==4 and bad!=before:bad[2]['original']['role_chain_names']=[names[0]]
            with self.assertRaises(ValueError):family.readiness(None,before,bad)

    def test_canonical_cost_contract_known_unknown_zero_and_forged_flags(self):
        for paid,units,expected in [('0.000000000000000011',3,{'gas_used':3,'tokens_used':9}),(None,3,None),('0',0,{'gas_used':0,'tokens_used':0})]:
            family=CollectedFixture(paid,units);snapshot=family.collect(family.session,4,'initial')
            costs=family.canonical_expenditure(snapshot)
            self.assertEqual(set(costs),{m['id'] for m in snapshot['deliverable_messages']})
            self.assertTrue(all(value==expected for value in costs.values()))
            changed=copy.deepcopy(snapshot);changed['native_delivery_transactions'][0]['proof']['fee']=None if expected is not None else {'gas_used':0,'tokens_used':0}
            with self.assertRaises(ValueError):family.canonical_expenditure(changed)
            changed=copy.deepcopy(snapshot);changed['native_delivery_transactions'][0]['proof']['transaction']['state_version']=999
            with self.assertRaises(ValueError):family.canonical_expenditure(changed)
            changed=copy.deepcopy(snapshot);changed['native_delivery_transactions'][0]['proof']['message_ids']=['0x'+'00'*32]
            with self.assertRaises(ValueError):family.canonical_expenditure(changed)
            changed=copy.deepcopy(snapshot);changed['native_delivery_transactions'][0]['proof']['sdk']['account']='00'*30
            with self.assertRaises(ValueError):family.canonical_expenditure(changed)
            changed=copy.deepcopy(snapshot);changed['native_delivery_transactions'].pop()
            with self.assertRaises(ValueError):family.canonical_expenditure(changed)

    def test_unknown_fee_requires_both_stopped_markers_absent_and_known_zero_present(self):
        for paid,units in [(None,3),('0',0)]:
            family=CollectedFixture(paid,units);snapshot=family.collect(family.session,4,'initial')
            costs=family.canonical_expenditure(snapshot);rows=[];canonical=[]
            for message in snapshot['messages']:
                name,txid=message['delivery_chain'],message['delivery_transaction']
                signed=family.signed[(name,txid)];actual=costs[message['id']]
                expenditure={'present':False} if actual is None else {'present':True,'gas_used_hex':'0x'+actual['gas_used'].to_bytes(32,'big').hex(),'tokens_used_hex':'0x'+actual['tokens_used'].to_bytes(32,'big').hex()}
                authority={'protocol':'radix','origin':message['origin'],'destination':message['destination'],'mailbox':full_component(contract(1)),'chain_id':'240','origin_hook':full_component(contract(2)),'operation_id':message['id'],'generation':1,'kind':'process','target':None}
                operation={'stage':'delivered','confirmation_started':True,'kind':'process','target':None,'authority':authority,'generation':1,'nonce':message['nonce'],'origin':message['origin'],'destination':message['destination'],'identity':{'kind':'hash256','hex':txid},'signed':signed['wire'],'expenditure':expenditure,'context':'0x'+'01'*32,'expected_context_checked':False}
                rows.append({'id':message['id'],'operation':operation})
                canonical.append({'id_chunks':[message['id'][2:34],message['id'][34:]],'processed':True,'gas_expenditure_record_present':actual is not None,'spent':{'gas_used':'0','tokens_used':'0'}})
            snapshot['stopped_canonical_Rust_readback']=[{'actual_Rust_output':{'messages':canonical}}]
            self.assertEqual(len(family.native_rows(family.session,snapshot,rows,None)),4)
            changed=copy.deepcopy(snapshot);changed['stopped_canonical_Rust_readback'][0]['actual_Rust_output']['messages'][0]['gas_expenditure_record_present']=paid is None
            with self.assertRaises(ValueError):family.native_rows(family.session,changed,rows,None)
            changed=copy.deepcopy(rows);changed[0]['operation']['expenditure']['present']=paid is None
            with self.assertRaises(ValueError):family.native_rows(family.session,snapshot,changed,None)

    def test_canonical_wire_and_notarized_hash_checked(self):
        signed={'wire':{'bytes':2,'sha256':'0x'+hashlib.sha256(b'\x4d\x01').hexdigest()},'sdk':{'notarized_hash':'ef'*32,'start_epoch_inclusive':100,'end_epoch_exclusive':102}}
        tx={'raw_hex':'4d01','epoch':100,'payload_hash':address_text(bytes.fromhex('ef'*32),'notarizedtransaction')}
        verify_signed_canonical(tx,signed)
        for key,value in [('raw_hex','4d02'),('epoch',102),('payload_hash',address_text(bytes.fromhex('ee'*32),'notarizedtransaction'))]:
            with self.assertRaises(ValueError): verify_signed_canonical(dict(tx,**{key:value}),signed)

    def test_stream_progress_order_and_cursor_controls(self):
        tx=self.receipt()['transaction']
        self.session.answers=[{'ledger_state':{'network':'localnet','state_version':100,'epoch':100},'items':[tx],'next_cursor':None}]
        self.assertEqual(len(self.adapter._stream(self.session,chain(9913374),contract(1),99)),1)
        self.session.answers=[{'ledger_state':{'network':'localnet','state_version':100,'epoch':100},'items':[tx,tx]}]
        with self.assertRaises(ValueError): self.adapter._stream(self.session,chain(9913374),contract(1),99)
        self.session.answers=[{'ledger_state':{'network':'localnet','state_version':100,'epoch':100},'items':[],'next_cursor':'again'}]
        with self.assertRaises(ValueError): self.adapter._stream(self.session,chain(9913374),contract(1),99)

    def test_final_state_actual_confirmations_not_account_nonce(self):
        self.session.answers=[{'current_state_identifier':{'state_version':100}}]
        configured=chain(9913374);configured['blocks']={'confirmations':7,'reorgperiod':20}
        self.assertEqual(self.adapter._final_state(self.session,configured),93)
        self.assertEqual(self.session.http[0][1],'/core/status/network-status')

    def test_tree_frontier_exact_count_root(self):
        from multivm_evm import merkle_roots
        message={'id':digest(wire()),'insertions':[0]}
        leaves=merkle_roots([message],digest)
        tree={'count':1,'frontier':[message['id'][2:]]+['00'*32]*31}
        self.assertEqual(tree_root(tree,digest),leaves[-1]['root'])
        tree['count']=2
        self.assertNotEqual(tree_root(tree,digest),leaves[-1]['root'])
        tree['frontier'].pop()
        with self.assertRaises(ValueError): tree_root(tree,digest)

    def test_custom_gateway_uses_actual_selected_config(self):
        configured=chain(9913374);configured['customgatewayurls']=[{'http':'http://127.0.0.1:6000'}]
        self.session.answers=[{}]
        self.adapter._http(self.session,configured,'/transaction/status',{})
        self.assertEqual(self.session.http[0][0],'http://127.0.0.1:6000')

    def test_core_and_gateway_base_paths_preserved_without_authority_rewrite(self):
        configured=chain(9913374)
        configured['gatewayurls']=[{'http':'http://127.0.0.1:5308/gateway/'}]
        self.session.answers=[{},{}]
        self.adapter._http(self.session,configured,'/transaction/call-preview',{})
        self.adapter._http(self.session,configured,'/transaction/status',{})
        self.assertEqual(self.session.http[0][:2],('http://127.0.0.1:3333/core','/core/transaction/call-preview'))
        self.assertEqual(self.session.http[1][:2],('http://127.0.0.1:5308/gateway/','/gateway/transaction/status'))

    def test_native_row_rejects_wrong_authority_wire_and_actual_fee(self):
        self.adapter._submission(self.session,'radixtest1',self.session.chains['radixtest1'],{'notarized_transaction_hex':'4d01'})
        txid='0x'+'ab'*32; signed=self.adapter.signed[('radixtest1',txid)]
        message={**signed['message'],'origin_chain':'radixtest0'}
        authority={'protocol':'radix','origin':9913374,'destination':9913375,'mailbox':full_component(contract(1)),'chain_id':'240','origin_hook':full_component(contract(2)),'operation_id':message['id'],'generation':1,'kind':'process','target':None}
        operation={'stage':'delivered','confirmation_started':True,'kind':'process','target':None,'authority':authority,'generation':1,'nonce':0,'origin':9913374,'destination':9913375,'identity':{'kind':'hash256','hex':txid},'signed':signed['wire'],'expenditure':{'present':True,'gas_used_hex':'0x'+(3).to_bytes(32,'big').hex(),'tokens_used_hex':'0x'+(9).to_bytes(32,'big').hex()},'context':'0x'+'01'*32,'expected_context_checked':False}
        proof={'message_ids':[message['id']],'sdk':signed['sdk'],'signed_wire':signed['wire'],'fee':{'gas_used':3,'tokens_used':9,'fee_paid_attos':11}}
        snapshot={'messages':[message],'deliverable_messages':[message],'native_delivery_transactions':[{'chain':'radixtest1','transaction_hash':txid,'proof':proof}],'stopped_canonical_Rust_readback':[{'actual_Rust_output':{'messages':[{'id_chunks':[message['id'][2:34],message['id'][34:]],'processed':True,'gas_expenditure_record_present':True,'spent':{'gas_used':'3','tokens_used':'9'}}]}}]}
        rows=[{'id':message['id'],'operation':operation}]
        self.assertEqual(self.adapter.native_rows(self.session,snapshot,rows,None)[0]['intent_discriminator'],2**64-1)
        for field,value in [('target','0x'+'01'*32),('signed',dict(signed['wire'],sha256='0x'+'00'*32)),('expenditure',dict(operation['expenditure'],tokens_used_hex='0x'+'00'*32))]:
            modified=copy.deepcopy(rows);modified[0]['operation'][field]=value
            with self.assertRaises(ValueError): self.adapter.native_rows(self.session,snapshot,modified,None)
        modified=copy.deepcopy(rows);modified[0]['operation']['authority']['chain_id']='1'
        with self.assertRaises(ValueError): self.adapter.native_rows(self.session,snapshot,modified,None)
        bad=copy.deepcopy(snapshot);bad['stopped_canonical_Rust_readback'][0]['actual_Rust_output']['messages'][0]['spent']['tokens_used']='10'
        with self.assertRaises(ValueError): self.adapter.native_rows(self.session,bad,rows,None)

    def test_sql_full_native_width_and_no_unsafe_values(self):
        from multivm_evm import sql_message_query,sql_delivery_query
        from multivm_evidence import message_wire
        message={**message_wire(wire(),digest),'dispatch_transaction':'0x'+'ab'*32,'insertions':[0],'payments':[{'gas_amount':1,'payment':9}]}
        self.assertIn("decode('"+'ab'*32+"','hex')",sql_message_query(message))
        self.assertIn("decode('"+'cd'*32+"','hex')",sql_delivery_query(message,'0x'+'cd'*32))
        with self.assertRaises(ValueError): sql_message_query(dict(message,origin='1;DROP TABLE message'))


if __name__=='__main__': unittest.main()
