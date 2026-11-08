"""Linux proof data validators. No fixture/main or native import."""
from pathlib import Path
import ast,copy,gzip,hashlib,json,math,re,time

def require(value,message):
 if not value:raise RuntimeError(message)
need=require
def strict_public_value(value,entry,require_settlement):
 need(value['passed']is True and value['errors']==[]and ''.join(value['binary_sha256_chunks'])==next(r['sha256']for r in entry['roles']if r['role']=='relayer'),'actual public payload/binary differs')
 summaries={}
 for name in ['normal_indexed','sole_sidecar']:
  case=value[name];need(case['passed']is True and case['errors']==[],'public case failed')
  require_settlement(case['settlement'],2,'public '+name)
  need(type(case['shutdown']['exit'])is int and case['shutdown']['exit']==0 and type(case['restart_shutdown']['exit'])is int and case['restart_shutdown']['exit']==0,'actual public shutdown/restart wait0 missing')
  need(case['restart_nonce_unchanged']is True and case['restart_broadcasts_unchanged']is True and case['stopped_rust_readback']==case['restarted_stopped_rust_readback'],'public sameDB/no-rebroadcast restart differs')
  need(len(case['messages'])==2 and [m['label']for m in case['messages']]==['public-first','public-rate-limit']and [m['delivered']for m in case['messages']]==([True,True]if name=='normal_indexed'else[True,False])and all(type(m['delivered'])is bool for m in case['messages']),'public admitted/canonical versus filtered rate-limit delivery differs')
  summaries[name]={'strict_settlement_passed':True,'confirmed':case['settlement']['operations_confirmed'],'tracked':case['settlement']['expected_tracked_messages'],'raw_reference_observations':len(case['settlement']['public_admin_reference_observations']),'actual_shutdown_and_restart_exit_codes':[case['shutdown']['exit'],case['restart_shutdown']['exit']]}
 return summaries

def strict_public_readback(value,entry,require_settlement,reference_class):
 # The reviewed V21 carry validator is reused verbatim, then raw observations
 # are replayed through the exact frozen public-only overlap normalizer.
 summary=strict_public_value(value,entry,require_settlement)
 for name in ['normal_indexed','sole_sidecar']:
  case=value[name];filtered=name=='sole_sidecar';s=case['settlement'];messages=case['messages']
  require(case['mode']==('sole_sidecar_dispatch_filtered'if filtered else'normal_indexed'),'Public case mode differs')
  require(s['bounded_grace_seconds']==30 and s['confirm_queue']==0,'Public finality/retirement policy differs')
  require(case['canonical_nonce_absent']is filtered and case['nonce_processed_absent']is filtered,'Public canonical/sidecar storage boundary differs')
  require(case['duplicate']=={'status':429,'body':'Transaction already submitted recently'}and case['rate_limit']=={'status':429,'body':'Rate limit exceeded'},'Public duplicate/rate-limit policy differs')
  require(case['admin_metrics_separate_port']is True,'Public/admin metrics ports collapsed')
  seals=case['sealed_delivery'];require(len(seals)==2,'Exactly two sealed public/bootstrap deliveries required')
  tracked=[]
  for seal in seals:
   event=seal['process_event_proof'];require(event['status']=='0x1'and event['mailbox_emitter'].lower()==case['contracts']['test2'].lower()and len(event['process_ids'])==1,'Public sealed ProcessId receipt differs')
   identity=event['process_ids'][0].lower();require(re.fullmatch(r'0x[0-9a-f]{64}',identity),'Malformed public ProcessId');tracked.append(identity)
  public_ids=[''.join(m['id_chunks']).lower()for m in messages]
  require(len(set(public_ids))==2 and all(re.fullmatch(r'0x[0-9a-f]{64}',i)for i in public_ids)and len(set(tracked))==2,'Public tracked IDs not unique')
  require((tracked==public_ids)if not filtered else(tracked[1]==public_ids[0]and tracked[0]not in public_ids and public_ids[1]not in tracked),'Public/bootstrap tracked membership differs')
  inclusions=s['first_proxy_inclusions'];require({''.join(r['id_chunks']).lower()for r in inclusions}==set(tracked),'Public per-ID600s coverage differs from sealed receipts')
  completion=s['first_live_completion']['monotonic'];times=[completion,*[r['first_positive_receipt_or_delivered_monotonic_seconds']for r in inclusions]]
  require(all(type(t)in(int,float)and math.isfinite(t)for t in times),'Nonfinite public inclusion/completion clock')
  require(all(completion>=t+600 for t in times[1:]),'Public ID retired before600s')
  probe=case['stopped_rust_readback'];links=probe['sealed_payload_links'];require(len(links)==2 and {'0x'+''.join(r['message_id_chunks']).lower().removeprefix('0x')for r in links}==set(tracked),'Stopped public sealed-ID readback differs')
  for i,(identity,seal)in enumerate(zip(tracked,seals,strict=True)):
   link=next(r for r in links if '0x'+''.join(r['message_id_chunks']).lower().removeprefix('0x')==identity);canonical=not(filtered and i==1);source='canonical'if canonical else'public_receipt_sidecar'
   require(all(row['message_source']==source and row['canonical_nonce_message_present']is canonical and row['canonical_nonce_matches_message']is canonical and row['private_operation_stage']=='delivered'and row['gas_expenditure_record_present']is True for row in [seal,link]),'Public canonical/private custody or expenditure boundary differs')
   require(link['destination_payload_present']is True and int(link['nonce'])==i,'Public bootstrap/admitted nonce or destination payload differs')
   require(seal['sealed_estimated_gas']==seal['original_process_estimate']==int(link['estimated_gas'])and int(seal['original_estimate_proof']['result'],16)==seal['original_process_estimate'],'Public original prebroadcast gas estimate differs')
   gas=seal['receipt_gas_used'];price=seal['effective_gas_price'];require(type(gas)is int and gas>0 and type(price)is int and price>0 and seal['receipt_tokens_used']==gas*price==int(link['spent']['tokens_used'])and gas==int(link['spent']['gas_used']),'Public actual receipt expenditure differs')
  rows=probe['messages']
  if filtered:require(len(rows)==4 and rows[0]['present']is True and rows[0]['processed']is True and all(r['present']is False and not r.get('processed',False)for r in rows[1:]),'Sidecar rate-limit/canonical nonce readback differs')
  else:require(len(rows)==2 and all(r['present']is True and r['processed']is True for r in rows),'Normal canonical public DB readback differs')
  canonical_rows=[r for r in rows if r['present']is True]
  expected_canonical=tracked[:1]if filtered else tracked
  require({'0x'+''.join(r['id_chunks']).lower().removeprefix('0x')for r in canonical_rows}==set(expected_canonical)and all(int(r['nonce'])==expected_canonical.index('0x'+''.join(r['id_chunks']).lower().removeprefix('0x'))for r in canonical_rows),'Canonical public/bootstrap nonce-to-ID readback differs')
  readiness=case['restart_readiness'];require(readiness['chain']=='test1'and readiness['data_type']==('merkle_tree_hook'if filtered else'dispatched_messages')and type(readiness['launch_unix_seconds'])in(int,float)and math.isfinite(readiness['launch_unix_seconds'])and type(readiness['liveness'])in(int,float)and math.isfinite(readiness['liveness'])and readiness['liveness']>=int(readiness['launch_unix_seconds']),'Public restart readiness missing/stale')
  # Fixed Source Mailbox VERSION3 / two-domain sendAndDispatch corpus. Rebuild
  # its exact wire; the ID itself is linked independently to sealed receipts.
  expected=[]
  for i,identity in enumerate(tracked):
   label=('origin-handle-bootstrap'if i==0 else'public-first')if filtered else messages[i]['label']
   wire=b'\x03'+i.to_bytes(4,'big')+(9913371).to_bytes(4,'big')+int(case['caller'],16).to_bytes(32,'big')+(9913372).to_bytes(4,'big')+int(case['recipient'],16).to_bytes(32,'big')+label.encode()
   expected.append({'id':identity,'wire':wire.hex()})
  normalizer=reference_class(expected,None if filtered else expected[0]);observations=s['public_admin_reference_observations'];require(0<len(observations)<=20000,'Public raw reference observations missing/unbounded');duplicate_observations=0;seen=set()
  for observation in observations:
   raw=observation['raw_operations'];normalizer.normalize(raw);captured=normalizer.observations.pop()
   require(all(observation[k]==captured[k]for k in ['raw_row_count','unique_id_count','id_reference_counts','raw_operations']),'Public raw multiplicity evidence differs')
   seen.update(captured['id_reference_counts']);duplicate_observations+=int(captured['raw_row_count']>captured['unique_id_count'])
  require(seen==set(tracked),'Public raw observation coverage differs')
  summary[name].update(identical_approved_duplicate_observations=duplicate_observations,actual_minimum_hold_seconds=min(completion-t for t in times[1:]),sealed_tracked_IDs=tracked,public_API_delivered=[m['delivered']for m in messages],same_DB_restart_and_no_new_nonce_or_broadcast=True)
 return summary

def validate(kind,value,relayer_sha,repo):
    require(value.get('passed')is True and not value.get('errors'),'actual functional proof failed')
    path=Path(repo)/'zig/bench/relayer.py';node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='require_functional_settlement');space={};exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),space);settlement=space['require_functional_settlement']
    def hold(row,count,label,historical=False):
        settlement(row,count,label,allow_historical=historical);require(row.get('bounded_grace_seconds')==30,'original actual600+30 policy');return {'count':count,'actual_minimum_hold_seconds':min(row['first_live_completion']['monotonic']-r['first_positive_receipt_or_delivered_monotonic_seconds']for r in row['first_proxy_inclusions'])}
    if kind=='relayer_process':
        require(''.join(value['binaries']['relayer_sha256_chunks'])==relayer_sha,'exact Linux relayer binary')
        summary={label:hold(row,count,label)for label,row,count in [('three-ISM',value['settlement'],3),('batch4',value['max_batch_4']['settlement'],4),('WAL-recovery',value['preenqueue_crash']['settlement'],1)]}
        crash=value['preenqueue_crash'];require(crash['passed']is True and crash['recovery_new_nonce_count']==1 and crash['restart_new_nonce_count']==0 and value['restart_nonce_unchanged']is True and value['gas_expenditure_recorded']is True and value['origin_progress_during_receipt_stall']is True,'original crash/restart/expenditure/stall invariants')
        batch=value['max_batch_4']['actual_allocation'];require(batch['calls']==4 and len(batch['members'])==4,'actual four-member allocation')
        stops=[value[k]for k in ['validator_stop','first_stop','restart_stop','stalled_stop']]+[value['max_batch_4']['stop'],crash['recovery_stop'],crash['replay_stop']];require(all(type(r['exit'])is int and r['exit']==0 for r in stops),'actual process role waits')
        fault=value['fault_injection']['self_test'];require(fault['positive_real_write_sigkill']is True and fault['unrelated_path_negative_control']is True and set(fault['write_modes'])=={'write','pwrite','writev','pwrite64'}and fault['path_negative_count']==4,'actual Linux crash interposer controls')
        return summary
    if kind=='relayer_stream':
        require(''.join(value['executables']['relayer_sha256_chunks'])==relayer_sha and value['case']['passed']is True,'actual Linux WSS exact binary')
        case=value['case'];require(case['restart']['existing_rust_rows_unchanged']is True and case['restart']['nonce_increase']==2 and case['restart']['sigterm']['exit']==0 and case['late_and_stalled_origin']['sigterm']['exit']==0,'original WSS restart/source progress')
        return {'WSS_restart':hold(case['restart']['settlement'],2,'WSS restart',True)}
    require(kind=='public_relay_process','fixed functional kind')
    source=Path(repo)/'zig/integration/public_relay_process.py';node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.ClassDef)and n.name=='PublicAdminReferences');space={'copy':copy,'json':json,'re':re,'time':time,'ORIGIN':9913371,'DESTINATION':9913372};exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),space)
    return strict_public_readback(value,{'roles':[{'role':'relayer','sha256':relayer_sha}]},settlement,space['PublicAdminReferences'])
