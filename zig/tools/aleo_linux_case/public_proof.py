"""Dedicated Aleo TS proof projection; never the generic NativeSession schema."""
import hashlib
import json
import math
import re
from receipts import need

LIFECYCLE=('id','firstInclusion','firstObserved','lastObserved','lastPresentRequestStarted','lastPresentResponseReceived','firstAbsentRequestStarted','firstAbsentResponseReceived','maximumObservedGapMs','earlyActiveSamples','confirmSamples','firstEarlyActive','firstConfirm','firstRetirement')


def numeric(value):
    return type(value)in {float,int}and math.isfinite(value)and value>=0


def selected(row,keys):
    need(isinstance(row,dict)and all(key in row for key in keys),'actual public scalar shape missing')
    out={key:row[key]for key in keys}
    need(all(value is None or type(value)in {str,int,float,bool}for value in out.values()),'nested data cannot enter public scalar projection')
    return out


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def project(actual,owner,raw_pin,spec):
    need(owner.get('passed')is True and actual.get('passed')is True and actual.get('errors')==[],'actual dedicated owner and TS proof required')
    need(owner.get('source_unchanged')is True and owner.get('owned_absent')is True and not owner.get('signals'),'actual owner preservation/absence required')
    evidence=actual['evidence'];complete=evidence['all-gates-complete']
    need(complete['actualNativeProofsAccepted']is True and complete['sameDBRestartNoExtraTransaction']is True and complete['sourceUnchanged']is True,'dedicated actual native gates incomplete')
    messages=evidence['dispatches'];need(len(messages)==complete['messageCount']==4,'exact ordinary four-message workload required')
    ids=[row['id']for row in messages];need(len(set(ids))==4 and all(re.fullmatch('0x[0-9a-f]{64}',value)for value in ids),'exact full message IDs required')
    lifecycle=evidence['actual-600-retirement']['perID'];need({row['id']for row in lifecycle}==set(ids)and len(lifecycle)==4,'exact per-ID actual lifecycle required')
    clocks=[]
    for row in lifecycle:
        record=selected(row,LIFECYCLE)
        need(all(numeric(value)for key,value in record.items()if key!='id'),'actual lifecycle clocks/counts missing')
        need(600000<=record['firstRetirement']-record['firstInclusion']<=630000 and record['earlyActiveSamples']>0 and record['confirmSamples']>0 and record['maximumObservedGapMs']<=10000,'per-ID actual600..630/early/Confirm/gap proof failed')
        clocks.append(record)
    restart=evidence['restart-observation-intervals'];start=restart['startedMonotonicMs'];end=restart['completedMonotonicMs']
    need(numeric(start)and numeric(end)and end-start>=30000,'actual dedicated TS restart30 clocks required')
    expected_domains={str(row['destination'])for row in messages}
    received=restart['domainLastReceived']
    need(type(received)is dict and set(received)==expected_domains,'actual restart domain coverage missing')
    public_received={}
    for domain in sorted(expected_domains):
        value=received[domain]
        need(numeric(value)and start<=value<=end and end-value<=10000,'actual restart domain clock is invalid/stale/outside interval')
        public_received[domain]=value
    waits=[]
    for name in ('parent-stopped-first','parent-stopped-restart'):
        rows=evidence[name];need(len(rows)==4,'four actual role waits required')
        for row in rows:
            record=selected(row,('pid','processGroup','executable','spawned','waitReturned','code','signal'))
            need(record['spawned']is True and record['waitReturned']is True and record['code']==0 and record['signal']is None and type(record['pid'])is int and record['pid']>0,'actual role wait failed')
            waits.append(record)
    sql=evidence['actual-linked-sql'];again=evidence['restarted-linked-sql'];need(sql==again and len(sql)==4,'same-DB SQL changed')
    rows=[];checkpoints=[]
    for message,row in zip(messages,sql):
        need(row==f"1|1|{message['payment']}|{message['gasAmount']}|1|1",'actual SQL identity/payment/tree/delivery failed')
        receipt=evidence['receipt-'+message['id']];canonical=receipt['canonical']
        native=evidence['native-proofs-and-receipts']['receipts'][message['id']]
        rows.append({'message':selected(message,('id','nonce','origin','destination','sender','recipient','dispatchTransaction','payment','gasAmount','insertion')),'canonical':selected(canonical,('transactionId','blockHash','height')),'native_signed_fingerprint':selected(native,('hex','sha256','bytes','fee')),'execution_proof_sha256':hashlib.sha256(canonical['executionProof'].encode()).hexdigest(),'fee_proof_sha256':hashlib.sha256(canonical['feeProof'].encode()).hexdigest(),'actual_SQL_row':row,'canonical_membership_and_SDK_signed_call_verified_by_actual_TS':True})
    for row in evidence['authenticated-checkpoints']:
        need(isinstance(row['signed'],list)and row['signed'],'actual checkpoint signatures absent')
        checkpoints.extend(selected(item,('name','index','root','id','signer'))for item in row['signed'])
    need({row['id']for row in checkpoints}==set(ids),'checkpoint ID coverage missing')
    return {'schema':1,'kind':'public-actual-aleo-proof-v1','generic_Python_NativeSession_acceptance':False,'raw_final':raw_pin,'source':{'runtime_source_commit':spec['runtime_source_commit'],'execution_source_commit':spec['execution_source_commit'],'manifest':spec['manifest'],'SDK_receipt':spec['sdk_receipt'],'Linux_storage_component':spec['storage_interop']},'actual_owner_waits':owner['direct_waits'],'owned_absent':owner['owned_absent'],'actual_role_waits':waits,'messages':rows,'per_ID_monotonic_ms':clocks,'restart':{'startedMonotonicMs':start,'completedMonotonicMs':end,'actual_duration_ms':end-start,'domainLastReceived':public_received,'sameDB_no_extra_transaction':True},'actual_checkpoint_signature_verdicts':checkpoints,'stopped_readback_fingerprints':{key:digest(value)for key,value in evidence.items()if key.startswith('stopped-')},'source_products_rechecked':owner['source_unchanged'],'native_family_acceptance_requires_Root_readback':True,'benchmark_or_performance_credit':False}
