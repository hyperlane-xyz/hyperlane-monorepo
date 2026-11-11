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


def validate_handoff(value, role, mode, expected_products, input_manifest, producer, source_pins, required_cpu_flags):
    """Closed six-case drained handoff evidence, distinct from accepted_six."""
    need(type(value)is dict and value.get('schema')==1 and type(value['schema'])is int and value.get('kind')=='paired-linux-drained-role-handoff'and value.get('passed')is True,'actual successful handoff proof required')
    need(value.get('role')==role and role in {'relayer','validator','scraper'}and value.get('mode')==mode and mode in {'ReleaseSafe','ReleaseFast'},'handoff role/mode differs')
    need(value.get('performance_credit')is False and value.get('baseline_source_commit')=='c5202242cc6569da4a858ed7ddbb34170ab696aa'and value.get('producer_source_commit')==producer,'handoff baseline/producer/scope differs')
    need(type(value.get('execution_source_commit'))is str and re.fullmatch('[0-9a-f]{40}',value['execution_source_commit']),'actual handoff executed Source identity required')
    need(value.get('source_pins')==source_pins,'actual handoff Source closure differs')
    actual=value.get('input_manifest');need(type(actual)is dict and all(actual.get(k)==input_manifest[k]for k in ['bytes','sha256']),'same actual once-input manifest required')
    cpu=value.get('actual_consumer_CPU');need(type(cpu)is dict and cpu.get('required_flags')==required_cpu_flags and type(required_cpu_flags)is list and required_cpu_flags and type(cpu.get('available_intersection_flags'))is list and all(type(v)is str for v in cpu['available_intersection_flags'])and set(required_cpu_flags)<=set(cpu['available_intersection_flags'])and type(cpu.get('cpuinfo_bytes'))is int and 0<cpu['cpuinfo_bytes']<=1024**2 and type(cpu.get('cpuinfo_sha256'))is str and re.fullmatch('[0-9a-f]{64}',cpu['cpuinfo_sha256']),'actual handoff consumer ISA evidence differs')
    epochs=value.get('epochs');need(type(epochs)is list and len(epochs)==3,'exactly three actual daemon handoff epochs required')
    store=None;previous_end=None;pids=set();events=set()
    for index,(epoch,implementation)in enumerate(zip(epochs,('rust','zig','rust'),strict=True)):
        need(type(epoch)is dict and epoch.get('phase')=='ABC'[index]and epoch.get('implementation')==implementation and epoch.get('binary_sha256')==expected_products[implementation]['sha256'],'actual handoff phase/product differs')
        pid=epoch.get('pid');need(type(pid)is int and pid>0 and pid not in pids,'unique actual daemon PID required');pids.add(pid)
        times=[epoch.get(k)for k in ['started_monotonic','ready_monotonic','drained_monotonic','ended_monotonic']]
        need(all(type(t)in(int,float)and math.isfinite(t)and t>0 for t in times)and times==sorted(times),'handoff actual readiness/drain/wait ordering invalid')
        need(previous_end is None or times[0]>previous_end,'handoff writers overlap');previous_end=times[-1]
        wait=epoch.get('parent_wait');need(type(wait)is dict and set(wait)=={'completed','exit_code','forced'}and wait['completed']is True and wait['forced']is False and type(wait['exit_code'])is int and wait['exit_code']in([0]if implementation=='zig'else[0,-15]),'actual clean/planned parent wait required')
        need(epoch.get('store_initialized')is(index==0),'state reset or missing initial store ownership')
        current=epoch.get('store_identity');need(type(current)is list and len(current)>=2 and all(type(v)in(str,int)for v in current),'actual retained physical store identity required')
        if store is None:store=current
        need(current==store,'handoff physical store changed')
        event=epoch.get('new_event');need(type(event)is str and re.fullmatch('(?:0x)?[0-9a-fA-F]{64}',event)and event.lower().removeprefix('0x')not in events,'actual unique fresh phase event required');events.add(event.lower().removeprefix('0x'))
        need(type(epoch.get('readiness'))is dict and bool(epoch['readiness']),'actual daemon readiness evidence missing')
        if role=='relayer':
            need(epoch.get('prior_rows_before')==epoch.get('prior_rows_after')and type(epoch.get('canonical_rows'))is list and len(epoch['canonical_rows'])==index+1 and all(r.get('present')is True and r.get('processed')is True for r in epoch['canonical_rows']),'canonical pending/processed state not drained or prior rows changed')
            need(epoch.get('prior_rows_before')==([]if index==0 else epochs[index-1]['canonical_rows']),'handoff canonical history was not retained')
            identifiers=[''.join(r.get('id_chunks',[])).lower().removeprefix('0x')for r in epoch['canonical_rows']];need(set(identifiers)==events and len(set(identifiers))==index+1,'canonical rows do not bind actual fresh phase IDs')
            accounting=epoch.get('accounting');need(type(accounting)is dict,'canonical receipt accounting required')
            gas=accounting.get('receipt_gas_used');price=accounting.get('effective_gas_price');need(type(gas)is int and gas>0 and type(price)is int and price>0 and accounting.get('receipt_tokens_used')==gas*price,'actual positive canonical receipt fee required')
            need(all(type(accounting.get(k))is str and re.fullmatch('0x[0-9a-fA-F]{64}',accounting[k])for k in ['canonical_transaction_hash','canonical_block_hash']),'canonical receipt identity required')
            event=accounting.get('process_event_proof');need(type(event)is dict and event.get('status')=='0x1'and event.get('process_ids')==['0x'+epoch['new_event'].lower().removeprefix('0x')]and type(event.get('mailbox_emitter'))is str and re.fullmatch('0x[0-9a-f]{40}',event['mailbox_emitter']),'fresh event must bind canonical receipt')
            latest=epoch['canonical_rows'][-1];spent=latest.get('spent');need(type(spent)is dict and type(accounting.get('database_gas_used'))is int and type(accounting.get('database_tokens_used'))is int and str(accounting['database_gas_used'])==str(spent.get('gas_used'))and str(accounting['database_tokens_used'])==str(spent.get('tokens_used'))and accounting.get('gas_expenditure_record_present')is latest.get('gas_expenditure_record_present'),'receipt accounting must bind actual stopped database row')
            gap=accounting.get('preserved_Rust_absent_record_Source_gap');need(type(gap)is bool and type(accounting.get('exact_expenditure'))is bool,'typed expenditure scope required')
            if gap:need(implementation=='rust'and accounting['gas_expenditure_record_present']is False and accounting['database_gas_used']==accounting['database_tokens_used']==0 and accounting['exact_expenditure']is False,'only existing absent Rust record gap may remain explicit')
            else:need(accounting['gas_expenditure_record_present']is True and accounting['database_gas_used']==gas and accounting['database_tokens_used']==gas*price and accounting['exact_expenditure']is True,'Zig/current expenditure must equal actual canonical receipt')
            before=epoch.get('nonce_before');after=epoch.get('nonce_after');need(type(after)is list and len(after)==2 and all(type(v)is int and v>=0 for v in after),'actual output nonce vector required');need(type(before)is list and len(before)==2 and all(type(v)is int and v>=0 for v in before)and after==[before[0]+1,before[1]],'actual fresh-event nonce coverage differs')
            need(type(epoch.get('raw_sends_before'))is int and type(epoch.get('raw_sends_after'))is int and epoch.get('raw_sends_after')==epoch['raw_sends_before']+1,'handoff duplicate/missing actual submission')
            if index:need(before==epochs[index-1]['nonce_after']and epoch['raw_sends_before']==epochs[index-1]['raw_sends_after'],'takeover replayed prior transaction')
            included=epoch.get('inclusion_ns');retired=epoch.get('retirement_ns');need(type(included)is int and type(retired)is int and included>0 and included+600_000_000_000<=retired<=included+630_000_000_000,'actual per-ID600+30 drain missing')
            settlement=epoch.get('settlement');need(type(settlement)is dict and type(settlement.get('processed_count'))in(int,float)and math.isfinite(settlement['processed_count'])and settlement['processed_count']==1 and type(settlement.get('queues'))is dict and settlement['queues']and all(type(v)in(int,float)and math.isfinite(v)and v==0 for v in settlement['queues'].values()),'actual owned queue drain missing')
        elif role=='validator':
            ready=epoch['readiness'];launched=ready.get('launch_unix_seconds');liveness=ready.get('liveness')
            need(all(ready.get(k)==v for k,v in [('agent','validator'),('data_type','merkle_tree_hook'),('chain','test1'),('task','cursor_task'),('http_status',200)])and type(launched)in(int,float)and math.isfinite(launched)and launched>0 and type(liveness)in(int,float)and math.isfinite(liveness)and liveness>=int(launched)and type(ready.get('metrics_bytes'))is int and 0<ready['metrics_bytes']<=1024**2,'actual fresh validator role/source cycle readiness required')
            before=epoch.get('prior_objects_before');after=epoch.get('prior_objects_after');objects=epoch.get('objects_after')
            need(type(before)is dict and before==after and type(objects)is dict and len(objects)==index+1 and set(objects)=={str(i)+'_with_id.json'for i in range(index+1)}and all(type(d)is str and re.fullmatch('[0-9a-f]{64}',d)for d in objects.values()),'checkpoint publication/frontier not drained')
            need(before==({}if index==0 else epochs[index-1]['objects_after'])and all(objects[k]==v for k,v in before.items()),'prior signed checkpoints changed')
            need(type(epoch.get('signature_count_verified'))is int and epoch['signature_count_verified']==index+1,'full current checkpoint crypto proof missing')
            metadata=epoch.get('metadata');need(type(metadata)is dict and metadata.get('git_sha')==epoch.get('expected_metadata_git_sha')==expected_products[implementation]['metadata_git_sha']and type(metadata.get('git_sha'))is str and re.fullmatch('[0-9a-f]{40}',metadata['git_sha']),'actual validator metadata/build provenance mismatch')
            need(all(type(epoch.get(k))is int and epoch[k]>=0 for k in ['nonce_before','nonce_after_takeover','nonce_after'])and epoch.get('actual_URI_in_chain_reply')is True and type(epoch.get('announcement_reply_sha256'))is str and re.fullmatch('[0-9a-f]{64}',epoch['announcement_reply_sha256']),'actual announcement drain missing')
            need(index!=0 or epoch['nonce_after']==epoch['nonce_before']+1,'initial announcement missing or duplicated')
            if index:need(epoch['announcement_reply_sha256']==epochs[0]['announcement_reply_sha256'],'takeover mutated announcement')
            if index:need(epoch.get('nonce_before')==epochs[index-1].get('nonce_after')==epoch.get('nonce_after_takeover')==epoch.get('nonce_after'),'validator takeover repeated announcement')
        else:
            identity=epoch['store_identity'];need(len(identity)==2 and type(identity[0])is str and type(identity[1])is str,'actual PG cluster/database identity required');parts=identity[1].split('|');need(len(parts)==3 and parts[0]==identity[0]and all(v.isdecimal()and int(v)>0 for v in parts[1:]),'PG cluster/database OID identity missing')
            before=epoch.get('prior_rows_before');need(type(before)is dict and before==epoch.get('prior_rows_after')and before==({}if index==0 else epochs[index-1]['rows_after']),'prior scraper rows changed')
            need(type(epoch.get('rows_after'))is dict and len(epoch['rows_after'])==5 and epoch.get('migrations')=='21'and type(epoch.get('fresh_SQL_events_verified'))is int and epoch['fresh_SQL_events_verified']==index+1,'actual scraper linked-row/schema coverage missing')
            need(event.lower().removeprefix('0x')in str(epoch['rows_after']).lower(),'fresh scraper event absent from actual rows')
            state=epoch.get('row_counts');keys=['raw_dispatch','messages','deliveries','gas_payments','merkle_insertions','linked_messages','linked_deliveries','linked_gas_payments']
            need(type(state)is dict and all(type(state.get(k))is int and state[k]==index+1 for k in keys)and state.get('receipt_or_identity_mismatches')==0 and state.get('duplicate_rows_by_message_identity')==0,'scraper drain/duplicates differ')
            head=state.get('head','').split('|');need(len(head)==6 and head[3].isdecimal()and head[4:]==['t','f'],'scraper actual healthy confirmed frontier missing')
            need(index==0 or epoch.get('normalized_config_sha256')==epochs[0].get('normalized_config_sha256'),'scraper effective configuration changed')
    need(epochs[-1]['ended_monotonic']-epochs[0]['started_monotonic']<7200,'handoff actual owner wall budget exceeded')
    launches=value.get('actual_role_launches');need(type(launches)is list,'actual direct daemon launch/wait evidence missing')
    need(len(launches)==(4 if role=='relayer'else 3)and all(type(r)is dict for r in launches),'complete actual primary and companion launch catalog required')
    launch_pids=set()
    for row in launches:
        need(type(row.get('pid'))is int and row['pid']>0 and row['pid']not in launch_pids and row.get('actual_parent_wait')is True and type(row.get('direct_parent_pid'))is int and row['direct_parent_pid']>0 and row.get('implementation')in {'rust','zig'}and type(row.get('exit_code'))is int and row['exit_code']in([0]if row['implementation']=='zig'else[0,-15]),'every actual daemon including companion must have clean waited exit')
        launch_pids.add(row['pid'])
        if row.get('role')!=role:need(role=='relayer'and row.get('role')=='validator'and row['implementation']=='rust'and type(row.get('binary'))is dict and all(row['binary'].get(k)==expected_products['rust_validator_companion'][k]for k in ['bytes','sha256']),'only exact once Rust validator companion is admitted')
    primary=[r for r in launches if type(r)is dict and r.get('role')==role]
    need(len(primary)==3 and [r.get('pid')for r in primary]==[r['pid']for r in epochs]and [r.get('implementation')for r in primary]==['rust','zig','rust'],'actual role epoch binding differs')
    for row,epoch in zip(primary,epochs,strict=True):need(row.get('actual_parent_wait')is True and type(row.get('direct_parent_pid'))is int and row['direct_parent_pid']>0 and type(row.get('exit_code'))is int and row['exit_code']==epoch['parent_wait']['exit_code']and type(row.get('binary'))is dict and row['binary'].get('sha256')==epoch['binary_sha256'],'actual daemon parent/product/wait differs')
    return {'role':role,'mode':mode,'actual_daemon_order':['rust','zig','rust'],'drained':True,'same_physical_store':True,'no_writer_overlap':True,'fresh_rollback_event':epochs[2]['new_event'],'performance_credit':False}
