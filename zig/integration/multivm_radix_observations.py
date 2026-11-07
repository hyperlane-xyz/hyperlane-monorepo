"""Pure typed Radix read observations and closed public evidence projection.

Successful reads are activity, not inclusion/finality/crypto proof. SDK verdicts
below describe the existing admitted reference result, never new reconstruction.
"""
import hashlib
import json
import re
from urllib.parse import urlsplit

def require(value,message):
    if not value:raise ValueError(message)


def address_bytes(value,kind='component'):
    # Session has the qualified integration import path. Projection never uses
    # this helper and therefore does not mutate owner import paths or caches.
    from multivm_radix import address_bytes as decode
    return decode(value,kind)


def uint(value,bits=64):
    require(type(value)is int and 0<=value<2**bits,'Radix public/observation integer differs')
    return value


def hextext(value,size=None):
    require(isinstance(value,str)and 0<len(value)<=2*1024**2,'Bounded Radix hex required')
    raw=bytes.fromhex(value.removeprefix('0x'))
    require(re.fullmatch('(0x)?[0-9a-fA-F]+',value)and(size is None or len(raw)==size),'Radix hex width/encoding differs')
    require(raw,'Nonempty Radix hex required')
    return raw


def fingerprint(value):
    require(isinstance(value,dict)and type(value.get('bytes'))is int and 0<=value['bytes']<=1024**2 and isinstance(value.get('sha256'),str)and re.fullmatch('(0x)?[0-9a-f]{64}',value['sha256']),'Radix byte fingerprint differs')
    return {'bytes':value['bytes'],'sha256':value['sha256']}


def digest(value):
    return {'bytes':len(value),'sha256':hashlib.sha256(value).hexdigest()}


def identity(value):return '0x'+address_bytes(value,'txid').hex()


def ledger(response):
    source=response.get('ledger_state');require(isinstance(source,dict)and source.get('network')=='localnet','Radix Gateway network differs')
    value={'network':'localnet','state_version':uint(source.get('state_version')),'epoch':uint(source.get('epoch'))}
    require(value['state_version']>0,'Actual positive Radix ledger required')
    return value


def transaction(value,head):
    require(isinstance(value,dict)and value.get('transaction_status')in{'CommittedSuccess','CommittedFailure'},'Typed committed Radix transaction required')
    identity(value['intent_hash'])
    state=uint(value['state_version']);require(0<state<=head,'Radix transaction outside ledger')
    receipt=value.get('receipt')
    require(isinstance(receipt,dict)and receipt.get('status')==value['transaction_status'],'Radix actual receipt status differs')
    events=receipt.get('events',[])
    require(isinstance(events,list)and len(events)<=8192 and all(isinstance(event,dict)for event in events),'Bounded Radix event objects required')
    return state


def successful_rest_exchange(field,endpoint,request,response):
    """Accept only actual Source readonly routes and matching typed replies."""
    try:
        require(isinstance(request,dict)and isinstance(response,dict)and response,'Typed Radix exchange required')
        require(not any(key.lower()in{'error','error_message','errors'}and value is not None for key,value in response.items()),'Radix error response')
        require(response.get('network','localnet')=='localnet','Contradictory Radix network')
        core=field in{'rpcurls','customrpcurls'};gateway=field in{'gatewayurls','customgatewayurls'}
        require(core or gateway,'Radix endpoint field differs')
        parsed=urlsplit(endpoint)
        require(parsed.scheme=='http'and parsed.hostname in{'localhost','127.0.0.1'}and parsed.port==(3333 if core else 5308)and parsed.username is None and parsed.password is None and not parsed.query and not parsed.fragment and parsed.path.rstrip('/')==('/core'if core else''),'Exact Source Radix endpoint required')
        start=request.get('start','').split(' ')
        require(len(start)==3 and start[0]=='POST'and start[2]in{'HTTP/1.0','HTTP/1.1'},'Actual Radix POST required')
        path=start[1];prefix='/core'if core else''
        require(path.startswith(prefix+'/')and '?'not in path and '#'not in path,'Radix request route differs')
        route=path[len(prefix):];body=request.get('json');require(isinstance(body,dict),'Radix object request required')
        if core:
            require(body.get('network')=='localnet','Source request network differs')
            if route=='/status/network-status':
                require(set(body)=={'network'},'Radix status request differs')
                require(uint(response['current_state_identifier']['state_version'])>0,'Positive Core state required')
                return True # Core SDK response has no network echo field.
            require(route=='/transaction/call-preview','Unknown Core read route')
            target=body.get('target');arguments=body.get('arguments')
            require(isinstance(target,dict)and set(target)=={'type','component_address','method_name'}and target['type']=='Method','Radix Method target required')
            address_bytes(target['component_address'])
            require(isinstance(target['method_name'],str)and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}',target['method_name']),'Radix method name differs')
            require(isinstance(arguments,list)and len(arguments)<=256,'Radix argument bound')
            for value in arguments:hextext(value)
            require(response.get('status')=='Succeeded','Radix preview did not succeed')
            state=uint(response['at_ledger_state']['state_version']);require(state>0,'Radix call state missing')
            selector=body.get('at_ledger_state')
            if selector is not None:require(isinstance(selector,dict)and selector.get('type')=='ByStateVersion'and uint(selector.get('state_version'))==state,'Requested/actual Radix call state differs')
            output=hextext(response['output']['hex'])
            scalar=(len(output)==3 and output[:2]==bytes([0x5c,1])and output[2]in(0,1))or(len(output)==6 and output[:2]==bytes([0x5c,9]))
            require(scalar,'Only exact Source bool/u32 preview values earn read activity')
            return True # Structured/other Scrypto outputs earn no clock; SDK checks remain in verifier.
        head=ledger(response)['state_version']
        if route=='/status/gateway-status':return body=={}
        if route in{'/transaction/status','/transaction/committed-details'}:
            txid=identity(body['intent_hash'])
            if route=='/transaction/status':
                require(response.get('status')in{'Pending','CommitPendingOutcome','CommittedSuccess'},'Unknown/failed Radix status earns no progress')
                if response['status']=='CommittedSuccess':require(0<uint(response.get('committed_state_version'))<=head,'Radix commit state differs')
                return True
            tx=response['transaction'];transaction(tx,head)
            return tx['transaction_status']=='CommittedSuccess'and identity(tx['intent_hash'])==txid
        require(route=='/stream/transactions','Unknown/submission Radix route earns no progress')
        require(body.get('order')=='Asc','Radix stream ordering differs')
        first=uint(body['from_ledger_state']['state_version'])
        require(first<=head,'Radix stream ledger behind request')
        selector=body.get('at_ledger_state')
        if selector is not None:require(isinstance(selector,dict)and uint(selector.get('state_version'))==head,'Radix stream snapshot differs')
        emitters=body.get('event_global_emitters_filter',[])
        require(isinstance(emitters,list)and len(emitters)<=256,'Radix emitter filter differs')
        for emitter in emitters:address_bytes(emitter)
        cursor=body.get('cursor');require(cursor is None or isinstance(cursor,str)and 0<len(cursor)<=4096,'Radix requested cursor differs')
        items=response.get('items');require(isinstance(items,list)and len(items)<=8192,'Radix stream items required')
        previous=first-1
        for item in items:
            state=transaction(item,head);require(state>=first and state>previous,'Radix stream repeats/reorders/below request');previous=state
        next_cursor=response.get('next_cursor');require(next_cursor is None or next_cursor==''or isinstance(next_cursor,str)and 0<len(next_cursor)<=4096 and next_cursor!=cursor and bool(items),'Radix cursor lacks progress')
        return True # A typed empty page is a genuine read, not a bare empty body.
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,OverflowError):return False


def coordinates(rows):
    require(isinstance(rows,list)and len(rows)<=8192,'Radix SQL coordinates required')
    result=[];seen=set()
    for row in rows:
        require(isinstance(row,dict)and row.get('kind')in{'dispatch','insertion','payment','delivery'},'Radix event kind differs')
        source=row['metadata'];keys=('chain','domain','transaction_hash','block_hash','block_number','transaction_index','log_index','emitter')
        require(isinstance(source,dict)and all(k in source for k in keys),'Complete Radix SQL coordinates required')
        value={key:source[key]for key in keys}
        require(isinstance(value['chain'],str)and re.fullmatch('[A-Za-z0-9_-]+',value['chain']),'Radix coordinate chain differs')
        uint(value['domain'],32)
        for key in('transaction_hash','block_hash','emitter'):hextext(value[key],32)
        for key in('block_number','transaction_index','log_index'):uint(value[key])
        require(value['transaction_index']==value['block_number']and value['block_hash']=='0x'+value['block_number'].to_bytes(32,'big').hex(),'Radix absolute state-version coordinates differ')
        marker=(row['kind'],*value.values());require(marker not in seen,'Duplicate Radix SQL coordinates');seen.add(marker)
        result.append({'kind':row['kind'],'metadata':value})
    return result


def public_fee(value):
    if value is None:return None
    keys={'gas_used','fee_paid_attos','tokens_used'}
    require(isinstance(value,dict)and set(value)==keys,'Closed actual Radix fee required')
    for number in value.values():uint(number,256)
    gas=value['gas_used'];require(value['tokens_used']==(value['fee_paid_attos']//gas*gas if gas else 0),'Radix fee floor differs')
    return dict(value)


def native_transaction(row):
    proof=row['proof'];tx=proof['transaction'];sdk=proof['sdk'];txid=row['transaction_hash']
    require(isinstance(sdk,dict)and type(sdk.get('schema'))is int and sdk['schema']==1 and sdk.get('op')=='notarized'and type(sdk.get('network'))is int and sdk['network']==240,'Actual successful SDK notarized evidence response required')
    require('0x'+hextext(sdk['intent_hash'],32).hex()==txid,'Radix SDK/native identity differs')
    require(isinstance(tx.get('intent_hash'),str)and re.fullmatch('txid_loc1[a-z0-9]{1,150}',tx['intent_hash']),'Native localnet intent text required')
    for key,size in(('public_key',32),('account',30),('mailbox',30),('signed_intent_hash',32),('notarized_hash',32)):hextext(sdk[key],size)
    first,last=uint(sdk['start_epoch_inclusive']),uint(sdk['end_epoch_exclusive']);epoch=uint(tx['epoch'])
    require(first<=epoch<last,'Radix committed epoch outside SDK range');uint(sdk['intent_discriminator']);require(isinstance(sdk['locked_fee'],str)and len(sdk['locked_fee'])<=80 and re.fullmatch('(0|[1-9][0-9]*)(\\.[0-9]{1,18})?',sdk['locked_fee'])and any(c in'123456789'for c in sdk['locked_fee']),'Positive actual locked Radix fee required')
    head=ledger({'ledger_state':proof['ledger_state']})['state_version'];state=uint(tx['state_version'])
    require(state==uint(proof['state_version'])and state<=uint(proof['final_state'])<=head and proof['source_state_version_hash']=='0x'+state.to_bytes(32,'big').hex()and tx['transaction_status']=='CommittedSuccess'and isinstance(tx.get('receipt'),dict)and tx['receipt'].get('status')=='CommittedSuccess','Canonical Radix final state differs')
    require(isinstance(tx.get('payload_hash'),str)and re.fullmatch('notarizedtransaction_loc1[a-z0-9]{1,150}',tx['payload_hash']),'Native localnet notarized text required')
    actual_fee=public_fee(proof['fee'])
    require((actual_fee is None)==('fee_paid'not in tx),'Radix unknown/present fee flag differs')
    return {'identity':txid,'state_version':state,'source_state_version_hash':proof['source_state_version_hash'],'ledger_state':{key:proof['ledger_state'][key]for key in('network','state_version','epoch')},'final_state':proof['final_state'],'transaction_status':tx['transaction_status'],'committed_epoch':epoch,'actual_fee':actual_fee,'sdk':{key:sdk[key]for key in('schema','op','network','public_key','account','mailbox','intent_hash','signed_intent_hash','notarized_hash','start_epoch_inclusive','end_epoch_exclusive','intent_discriminator','locked_fee')},'signed_wire_fingerprint':fingerprint(proof['signed_wire']),'SDK_Ed25519_validation':{'passed':True,'basis':'Existing pinned radix_reference successful notarized evidence response: SDK TransactionValidator plus Ed25519 notary/account/network/effect checks.','new_independent_crypto_reconstruction':False},'message_ids':list(proof['message_ids'])}


def checkpoint(source,target):
    tree=source['canonical_tree'];uint(tree['count'],32);require(isinstance(tree['frontier'],list)and len(tree['frontier'])==32,'Radix canonical frontier width')
    for branch in tree['frontier']:hextext(branch,32)
    target['canonical_tree']={'count':tree['count'],'frontier_canonical_JSON_fingerprint':digest(json.dumps(tree['frontier'],sort_keys=True,separators=(',',':')).encode())}
    target['announced_locations_fingerprint']=digest(json.dumps(source['announced_locations'],sort_keys=True,separators=(',',':')).encode())


def extend_public_snapshot(snapshot,public):
    """Enrich the existing safe projection; never copy arbitrary DTO subtrees."""
    require(snapshot.get('scenario')=='radix','Only Radix public projection')
    by_id={}
    for source,target in zip(snapshot['native_delivery_transactions'],public['native_delivery_transactions'],strict=True):
        value=native_transaction(source);target['Radix']=value
        require(len(value['message_ids'])==1,'Radix process grouping differs');message=value['message_ids'][0];hextext(message,32)
        require(message not in by_id,'Duplicate Radix native process');by_id[message]=value
    for source,target in zip(snapshot.get('native_operations',[]),public['native_operations'],strict=True):
        authority=source['operation']['authority'];keys={'protocol','origin','destination','mailbox','chain_id','origin_hook','operation_id','generation','kind','target'}
        require(isinstance(authority,dict)and set(authority)==keys and authority['protocol']=='radix'and authority['chain_id']=='240'and authority['kind']=='process'and authority['target']is None and authority['operation_id']==source['id'],'Closed Radix stored public authority required')
        for key in('origin','destination'):uint(authority[key],32)
        uint(authority['generation'])
        for key in('mailbox','origin_hook','operation_id'):hextext(authority[key],32)
        require(source['id']in by_id,'Radix native operation lacks verified transaction')
        target['operation']['authority']={key:authority[key]for key in sorted(keys)}
    for source,target in zip(snapshot.get('postgres',[]),public['postgres'],strict=True):
        target['canonical_event_rows']=coordinates(source['event_coordinates'])
    for source,target in zip(snapshot.get('family_native_row_proofs',[]),public['family_native_row_proofs'],strict=True):
        actual=by_id[source['id']];sdk=actual['sdk']
        require(source['identity']==actual['identity']and source['intent_discriminator']==sdk['intent_discriminator']and source['epoch_range']==[sdk['start_epoch_inclusive'],sdk['end_epoch_exclusive']]and source['actual_fee']==actual['actual_fee']and source['configuration_authority_verified']is False,'Radix stopped-row SDK/fee binding differs')
        hextext(source['context'],32);require(type(source['expected_context_checked'])is bool,'Radix context verdict differs')
        target.clear()
        target.update(id=source['id'],identity=source['identity'],context=source['context'],expected_context_checked=source['expected_context_checked'],configuration_authority_verified=False,intent_discriminator=source['intent_discriminator'],epoch_range=list(source['epoch_range']),actual_fee=actual['actual_fee'],signed_wire_fingerprint=fingerprint(source['signed_wire']))
        require(target['signed_wire_fingerprint']==actual['signed_wire_fingerprint'],'Radix stopped native wire differs')
    for source,target in zip(snapshot.get('checkpoint_proofs',[]),public['checkpoint_proofs'],strict=True):
        checkpoint(source,target)
    if 'same_db_restart_readiness'in public:
        value=snapshot['same_db_restart_readiness']
        for key in('no_account_nonce_claim','shared_parentwait_and_600_policy_required'):
            require(value[key]is True,'Radix restart readiness qualification missing');public['same_db_restart_readiness'][key]=True
        for source,target in zip(value['actual_publications'],public['same_db_restart_readiness']['actual_publications'],strict=True):checkpoint(source,target)
    public['Radix_evidence_scope']={'network':240,'no_account_nonce_claim':True,'public_projection_adds_independent_crypto_credit':False,'SDK_signature_verdict_basis':'Existing successfully verified native evidence only; not executable or future-native admission.'}
    return public
