#!/usr/bin/env python3
"""Fresh-target Linux fixture controls only; never invokes native-case tests."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import cold_matrix_owner as ownership

GIB=1024**3
ROOT=Path(__file__).resolve().parents[2]
FEATURES='cosmos cosmosnative sealevel starknet radix tron test-utils memory-profiling'
FILTERS=['external_agents::tests::','external_agents::radix_fixture::tests::','program::tests::','cosmos::validator_config_tests::']
GENERATED=['rust/main/chains/hyperlane-ethereum/src/interfaces','rust/main/chains/hyperlane-starknet/src/contracts','rust/main/chains/hyperlane-tron/src/interfaces','rust/main/ethers-prometheus/src/contracts']

REQUIRED_TESTS={'external_agents::tests::': ['external_agents::tests::approved_pg_schema2_distinguishes_config_id_manifest_digest_and_platform', 'external_agents::tests::approved_starknet_schema2_binds_linux_config_id_and_independent_manifest_digest', 'external_agents::tests::explicit_node_stop_error_propagates_before_success', 'external_agents::tests::explicit_node_stop_is_once_and_failed_stop_cannot_become_success', 'external_agents::tests::fixed_container_early_real_child_exit_is_cleaned_without_live_witness_credit', 'external_agents::tests::native_image_schema2_never_guesses_legacy_architecture_or_accepts_other_repository', 'external_agents::tests::node_setup_unwind_cleanup_does_not_repeat_success_or_panic_on_failure', 'external_agents::tests::owned_pg_bad_caps_and_unhealthy_state_fail_acceptance_but_clean_actual_child', 'external_agents::tests::owned_pg_foreign_identity_never_reaches_mutation_authority', 'external_agents::tests::starknet_actual_container_caps_and_source_command_are_required', 'external_agents::tests::starknet_external_arguments_keep_source_corpus_but_bind_owned_image_and_loopback', 'external_agents::tests::starknet_external_fixture_rejects_crossed_or_unapproved_case', 'external_agents::tests::starknet_owned_cid_requires_exact_task_parent_token_name_and_image', 'external_agents::tests::starknet_planned_container_stop_preserves_actual_clean_wait', 'external_agents::tests::starknet_planned_stop_reaps_foreground_before_or_after_control_returns', 'external_agents::tests::starknet_unexpected_pre_stop_exit_is_not_a_planned_stop', 'external_agents::tests::svm_bundle_raw_duplicate_and_unknown_field_reject_before_assets', 'external_agents::tests::svm_bundle_unconfigured_non_svm_is_unchanged_and_cross_family_bundle_rejects', 'external_agents::tests::svm_closed_tree_rejects_extra_missing_members_and_directory_links', 'external_agents::tests::svm_data_file_checks_exact_path_size_hash_and_executable_requirement', 'external_agents::tests::svm_data_hardlink_and_symlink_escape_are_not_admitted', 'external_agents::tests::svm_fixture_changed_artifact_fails_but_exact_child_is_cleaned', 'external_agents::tests::svm_fixture_real_child_stop_wait_is_recorded_once', 'external_agents::tests::svm_fixture_setup_unwind_reaps_actual_child', 'external_agents::tests::svm_listener_foreign_pid_fd_and_udp_escape_are_hard_errors', 'external_agents::tests::svm_listener_owned_faucet_is_explicit_and_not_loopback_credit', 'external_agents::tests::svm_listener_requires_numeric_fd_before_each_socket_and_rejects_duplicate_process', 'external_agents::tests::svm_shape_all_version_fields_and_schema_are_exact', 'external_agents::tests::svm_shape_each_member_map_rejects_missing_foreign_and_aliases', 'external_agents::tests::svm_shape_exact_members_are_not_execution_or_asset_acceptance', 'external_agents::tests::tron_container_requires_actual_caps_running_source_env_and_default_command', 'external_agents::tests::tron_external_arguments_bind_source_env_image_loopback_and_caps', 'external_agents::tests::tron_external_case_approval_cross_binding_and_owned_cli_are_required', 'external_agents::tests::tron_owned_cid_requires_task_parent_token_image_and_name', 'external_agents::tests::tron_planned_container_stop_cannot_credit_failure_force_lateness_or_no_live_witness'], 'external_agents::radix_fixture::tests::': ['external_agents::radix_fixture::tests::exact_source_images_and_native_platform_are_required', 'external_agents::radix_fixture::tests::cached_source_tag_must_resolve_to_the_same_native_immutable_image', 'external_agents::radix_fixture::tests::absent_or_additional_services_are_rejected', 'external_agents::radix_fixture::tests::compose_model_cannot_pull_or_restart_unbounded_services', 'external_agents::radix_fixture::tests::docker_environment_probe_worker', 'external_agents::radix_fixture::tests::docker_launch_strips_hostile_inherited_authority_for_inspect_and_compose', 'external_agents::radix_fixture::tests::bounded_client_preserves_output_and_rejects_actual_nonzero_exit', 'external_agents::radix_fixture::tests::bounded_client_kills_and_waits_its_original_process', 'external_agents::radix_fixture::tests::bounded_client_rejects_excess_output', 'external_agents::radix_fixture::tests::default_rust_fixture_path_remains_unselected', 'external_agents::radix_fixture::tests::readiness_requires_both_actual_local_native_networks_and_committed_gateway_state', 'external_agents::radix_fixture::tests::failed_resource_acceptance_still_cleans_exact_owned_containers', 'external_agents::radix_fixture::tests::cleanup_preserves_foreign_or_replaced_container', 'external_agents::radix_fixture::tests::preexisting_project_cannot_arm_cleanup']}

def pin(path):
    raw=path.read_bytes()
    return {'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}

def source():
    names=subprocess.check_output(['git','ls-files','-z','--','rust/main','rust/sealevel'],cwd=ROOT,timeout=10).decode().split('\0')
    names += ['zig/bench/native_harness_controls.py','zig/bench/cold_matrix_owner.py','.github/workflows/zig-agents.yml','.nvmrc']
    return {n:pin(ROOT/n)for n in names if n and (ROOT/n).is_file() and not(ROOT/n).is_symlink()}

def generated():
    return {str(p.relative_to(ROOT)):pin(p)for name in GENERATED for p in sorted((ROOT/name).glob('*.rs'))}

class FunctionalCensusIncomplete(RuntimeError):
    def __init__(self, observation):
        self.observation = dict(observation)
        super().__init__('Functional owned-allocation census incomplete: ' + json.dumps(observation, sort_keys=True))


def functional_allocated(root, observations=None, *, maximum_seconds=15, maximum_entries=250000):
    """Untimed helper/tool guard. Cold runner's 1s/250k census is unchanged."""
    if not (0 < maximum_seconds <= 15 and type(maximum_entries) is int and 0 < maximum_entries <= 250000):
        raise ValueError('Functional census limits must remain bounded by15s/250k')
    started = time.monotonic()
    report = {'complete': False, 'maximum_seconds': maximum_seconds, 'maximum_entries': maximum_entries, 'files_seen': 0, 'unique_inodes': 0, 'allocated_file_bytes': 0, 'elapsed_seconds_diagnostic': 0, 'reason': None}
    inodes = set()
    def check():
        report['elapsed_seconds_diagnostic'] = time.monotonic() - started
        if report['files_seen'] > maximum_entries: report['reason'] = 'entry_limit'
        elif report['elapsed_seconds_diagnostic'] > maximum_seconds: report['reason'] = 'time_limit'
        if report['reason'] is not None: raise FunctionalCensusIncomplete(report)
    def walk_error(error):
        if not isinstance(error, FileNotFoundError): raise error
    try:
        for directory, children, files in os.walk(root, followlinks=False, onerror=walk_error):
            check()
            children[:] = [name for name in children if not (Path(directory) / name).is_symlink()]
            for name in files:
                report['files_seen'] += 1
                check()
                try: row = (Path(directory) / name).lstat()
                except FileNotFoundError: continue
                key = row.st_dev, row.st_ino
                if key not in inodes:
                    inodes.add(key); report['allocated_file_bytes'] += row.st_blocks * 512
        check()
        report['complete'] = True
        return report['allocated_file_bytes']
    except BaseException as error:
        if report['reason'] is None: report['reason'] = 'exception:' + type(error).__name__
        raise
    finally:
        report['unique_inodes'] = len(inodes)
        report['elapsed_seconds_diagnostic'] = time.monotonic() - started
        if observations is not None:
            observations['calls'] = observations.get('calls', 0) + 1
            observations['maximum_files_seen'] = max(observations.get('maximum_files_seen', 0), report['files_seen'])
            observations['maximum_elapsed_seconds_diagnostic'] = max(observations.get('maximum_elapsed_seconds_diagnostic', 0), report['elapsed_seconds_diagnostic'])
            observations['last'] = report


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);parser.add_argument('--git-sha',required=True);args=parser.parse_args()
    root=args.root.resolve(strict=True)
    assert os.uname().sysname=='Linux' and root.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve(strict=True))
    assert (root/'setup-owned').read_text()==args.git_sha+'\n'
    assert re.fullmatch('[0-9a-f]{40}',args.git_sha)and subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True,timeout=10).strip()==args.git_sha
    assert shutil.disk_usage(root).free>=40*GIB
    target=root/'target';target.mkdir();output=root/'evidence';output.mkdir(exist_ok=True)
    census={};baseline_alloc=functional_allocated(root,census);before=source();old_generated=generated();ownership.enable_subreaper()
    env={k:os.environ[k]for k in ['PATH','CARGO_HOME','RUSTUP_HOME']if k in os.environ}
    (root/'home').mkdir(exist_ok=True);(root/'tmp').mkdir(exist_ok=True)
    env.update(HOME=str(root/'home'),TMPDIR=str(root/'tmp'),CARGO_TARGET_DIR=str(target),CARGO_INCREMENTAL='0',CARGO_PROFILE_DEV_DEBUG='0',CARGO_PROFILE_TEST_DEBUG='0',CARGO_BUILD_JOBS='2',CARGO_TERM_COLOR='never')
    cargo=['cargo','+1.98.0'];base=['--locked','--offline','--package','run-locally','--bin','run-locally','--features',FEATURES,'--target-dir',str(target),'-j','2']
    phases=[('compile-construction',cargo+['test',*base,'--no-run','--message-format=json-render-diagnostics'])]
    phases +=[(scope.removesuffix('::').replace('::','-'),cargo+['test',*base,scope,'--','--test-threads=1'])for scope in FILTERS]
    phases +=[('compile-normal',cargo+['build',*base,'--message-format=json-render-diagnostics']),('clippy',cargo+['clippy','--no-deps',*base,'--tests','--','-D','warnings'])]
    rows=[];deadline=time.monotonic()+150*60;primary=None
    def interrupted(sig,frame):raise ownership.TaskInterrupted('helper controls signal '+str(sig))
    for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,interrupted)
    try:
        for name,argv in phases:
            assert source()==before,'authoritative tracked Source changed'
            assert shutil.disk_usage(root).free>=6*GIB and functional_allocated(root,census)-baseline_alloc<=30*GIB
            child=None;known={};groups={};cleanup=None;error=None;peak=0;log=output/(name+'.log');start=time.monotonic()
            try:
                with log.open('wb')as stream:
                    child=subprocess.Popen(argv,cwd=ROOT/'rust/main',env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
                    groups[child.pid]=child.pid
                    while True:
                        current=ownership.processes();owned=ownership.owned_processes(current,child.pid,known,groups,True)
                        peak=max(peak,sum(row['rss_bytes']for row in owned.values()))
                        assert peak<=16*GIB,'helper tree RSS cap'
                        assert shutil.disk_usage(root).free>=6*GIB,'helper free floor'
                        assert functional_allocated(root,census)-baseline_alloc<=30*GIB,'helper task-growth cap'
                        assert log.stat().st_size<=64*1024**2,'helper log cap'
                        assert time.monotonic()<deadline,'original helper deadline'
                        event=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                        if event is not None:break
                        time.sleep(.2)
            except BaseException as failure:error={'type':type(failure).__name__,'message':str(failure)}
            finally:
                if child is not None:
                    for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,signal.SIG_IGN)
                    try:cleanup=ownership.stop_owned(child,known,groups)
                    finally:
                        for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,interrupted)
            row={'name':name,'argv':argv,'pid':None if child is None else child.pid,'exit_code':None if child is None else child.returncode,'actual_parent_wait':bool(cleanup and cleanup.get('actual_parent_wait')),'cleanup':cleanup,'error':error,'peak_tree_RSS_bytes':peak,'elapsed_seconds':time.monotonic()-start,'log':pin(log)}
            # stop_owned's receipt is authoritative; never infer it from a poll.
            row['actual_parent_wait']=bool(cleanup and cleanup.get('actual_parent_wait',False))
            rows.append(row);(output/'partial.json').write_text(json.dumps(rows,indent=2)+'\n')
            assert error is None and child is not None and child.returncode==0 and cleanup and cleanup['clean'],'helper phase/cleanup failed'
            leftovers=[r for r in cleanup.get('owned_present_before_stop',[])if r['pid']!=child.pid]
            assert not leftovers,'helper command left descendants requiring cleanup'
            now_generated=generated()
            assert all(now_generated.get(k)==v for k,v in old_generated.items()),'existing generated compiler input changed'
            old_generated=now_generated
            if 'test' in argv and '--no-run'not in argv:
                text=log.read_text();summary=re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',text)
                assert summary and int(summary[1])>0 and int(summary[2])==0 and int(summary[3])==0,'filtered fixture tests absent/failed/ignored'
                scope=next(f for f in FILTERS if f in argv)
                required=REQUIRED_TESTS.get(scope,[])
                assert all('test '+name+' ...' in text for name in required),'required new fixture test missing from actual run'
                row['required_new_tests_observed']=required
                row['actual_tests_passed']=int(summary[1]);(output/'partial.json').write_text(json.dumps(rows,indent=2)+'\n')
        assert source()==before
    except BaseException as failure:primary={'type':type(failure).__name__,'message':str(failure)}
    finally:
        (output/'authoritative-source.json').write_text(json.dumps(before,indent=2)+'\n');(output/'generated-compiler-inputs.json').write_text(json.dumps(generated(),indent=2)+'\n')
        products={}
        for row in rows:
            if row['name']not in ['compile-construction','compile-normal']:continue
            for line in Path(row['log']['path']).read_text().splitlines():
                try:event=json.loads(line)
                except json.JSONDecodeError:continue
                if event.get('reason')=='compiler-artifact'and event.get('target',{}).get('name')=='run-locally'and event.get('executable'):
                    path=Path(event['executable']);assert path.is_relative_to(target)
                    kind='construction'if event.get('profile',{}).get('test')else'normal'
                    destination=output/'products'/kind;destination.parent.mkdir(exist_ok=True)
                    shutil.copyfile(path,destination);destination.chmod(path.stat().st_mode&0o777)
                    original=pin(path);copied=pin(destination);assert original['sha256']==copied['sha256']
                    products[kind]={'producer':original,'published':copied,'artifact_relative_path':'products/'+kind}
        if primary is None and (shutil.disk_usage(root).free<6*GIB or functional_allocated(root,census)-baseline_alloc>30*GIB):
            primary={'type':'ResourceError','message':'post-publication resource bound failed'}
        result={'schema':1,'passed':primary is None,'source_commit':args.git_sha,'scope':'Compiled filtered native harness fixtures only; no native-chain/role/SDK-main/600 or timing acceptance','source_unchanged':source()==before,'Source_scope':'Git-tracked authoritative Rust main/sealevel inputs; build.rs-generated ignored ABI outputs recorded separately, preserved after creation','checks':rows,'all_owned_jobs_joined':all(r['actual_parent_wait'] and r['cleanup']['clean'] for r in rows),'products':products,'error':primary,'functional_allocation_census':census,'timing_acceptance':False,'native_case_acceptance':False}
        if primary is None and len(products)!=2:
            result['passed']=False;result['error']={'type':'ArtifactError','message':'both actual Cargo-emitted helper products required'};primary=result['error']
        (output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    if primary is not None:raise SystemExit(1)

if __name__=='__main__':main()
