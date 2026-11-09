#!/usr/bin/env python3
"""Own one serial, dependency-inclusive cold trial on an isolated Linux CI VM."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

class TaskInterrupted(RuntimeError):
    """Cancellation must not be swallowed by subprocess EINTR retry loops."""


_SUBREAPER_ENABLED = False
GIB = 1024**3
COMPILERS = {'cargo', 'rustc', 'zig', 'clang', 'clang++', 'gcc', 'g++', 'cc1', 'cc1plus', 'cmake', 'make', 'anvil', 'validator', 'relayer', 'scraper', 'hyperlane-aleo-vm-worker', 'hypd', 'osmosisd', 'solana-test-validator', 'starknet-devnet'}


def _linux_row(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        tail = raw[raw.rindex(')') + 2:].split()
        row = {'pid': pid, 'ppid': int(tail[1]), 'pgid': int(tail[2]), 'sid': int(tail[3]), 'state': tail[0], 'start': 'linux-ticks:' + tail[19], 'rss_bytes': int(tail[21]) * os.sysconf('SC_PAGE_SIZE'), 'comm': raw[raw.index('(') + 1:raw.rindex(')')]}
        try:
            row['comm'] = Path(os.readlink(f'/proc/{pid}/exe')).name
        except PermissionError:
            row['executable_unreadable'] = True
        except FileNotFoundError:
            # Missing exe is not process absence: S may have become Z after the
            # first stat, or exec may temporarily lack an executable link.
            # Refresh EVERY field; only an absent stat can discard this PID.
            raw = Path(f'/proc/{pid}/stat').read_text()
            tail = raw[raw.rindex(')') + 2:].split()
            row = {'pid': pid, 'ppid': int(tail[1]), 'pgid': int(tail[2]), 'sid': int(tail[3]), 'state': tail[0], 'start': 'linux-ticks:' + tail[19], 'rss_bytes': int(tail[21]) * os.sysconf('SC_PAGE_SIZE'), 'comm': raw[raw.index('(') + 1:raw.rindex(')')], 'executable_unavailable': True}
        return row
    except (FileNotFoundError, ProcessLookupError):
        return None


def processes():
    env = dict(os.environ, LC_ALL='C')
    result = subprocess.run(['ps', '-eo', 'pid=,ppid=,pgid=,rss=,state=,lstart=,comm='], env=env, capture_output=True, text=True, timeout=2, check=True)
    records = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 11:
            continue
        pid, ppid, pgid, rss = map(int, fields[:4])
        if sys.platform == 'linux':
            row = _linux_row(pid)
            if row is not None:
                records[pid] = row
        else:
            try:
                records[pid] = {'pid': pid, 'ppid': ppid, 'pgid': pgid, 'rss_bytes': rss * 1024, 'start': 'ps-lstart:' + ' '.join(fields[5:10]), 'comm': Path(' '.join(fields[10:])).name, 'state': fields[4][0], 'sid': os.getsid(pid)}
            except ProcessLookupError:
                pass
    return records


def proc_fallback():
    if sys.platform != 'linux':
        raise RuntimeError('Independent proc cleanup fallback requires Linux')
    deadline = time.monotonic() + .5
    records = {}
    seen = 0
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        seen += 1
        if seen > 8192 or time.monotonic() > deadline:
            raise RuntimeError('Independent proc cleanup snapshot exceeded bounds')
        row = _linux_row(int(entry.name))
        if row is not None:
            records[row['pid']] = row
    return records


def cleanup_snapshot(errors, stage):
    try:
        return processes()
    except Exception as error:
        errors.append({'stage': stage, 'primary_snapshot_error': type(error).__name__, 'message': str(error), 'proc_fallback_attempted': sys.platform == 'linux'})
        # The primary failure remains a timing/proof failure even if independent
        # discovery proves teardown. This path never repairs a measurement.
        if sys.platform == 'linux':
            return proc_fallback()
        raise


def enable_subreaper():
    # Linux-only and unprivileged: detached task descendants reparent here, not
    # to init. This closes unseen double-fork/setsid escapes from PPID sampling.
    global _SUBREAPER_ENABLED
    if sys.platform == 'linux':
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        libc.prctl.restype = ctypes.c_int
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'Cannot enable task child subreaper')
        _SUBREAPER_ENABLED = True


def same_process(left, right):
    # Group/session changes are mutable state, never process identity.
    return left['pid'] == right['pid'] and left['start'] == right['start']


def owned_processes(records, direct_pid, known, groups, direct_unreaped):
    owned = {pid: records[pid] for pid, row in known.items() if pid in records and same_process(row, records[pid])}
    if direct_unreaped and direct_pid in records:
        if direct_pid in known and not same_process(known[direct_pid], records[direct_pid]):
            raise RuntimeError('Unreaped direct child identity changed')
        owned[direct_pid] = records[direct_pid]
    # Popen(start_new_session=True) positively creates this original session.
    # Before direct-child reap its numeric identity cannot have been reused.
    anchors = {row['sid'] for row in owned.values()}
    if direct_unreaped:
        anchors.add(direct_pid)
    if _SUBREAPER_ENABLED:
        for pid, row in records.items():
            if row['ppid'] == os.getpid() and pid != direct_pid:
                owned[pid] = {**row, 'observed_as_adopted_child': True}
                anchors.add(row['sid'])
    previous = -1
    while previous != len(owned):
        previous = len(owned)
        for pid, row in records.items():
            if row['ppid'] in owned or row['sid'] in anchors:
                adopted = owned.get(pid, {}).get('observed_as_adopted_child', False)
                owned[pid] = {**row, **({'observed_as_adopted_child': True} if adopted else {})}
                anchors.add(row['sid'])
        groups.update({row['pgid']: row['sid'] for row in owned.values()})
    known.update(owned)
    return owned


def signal_known(observed, sig):
    sent = []
    errors = []
    current = cleanup_snapshot(errors, 'signal_primary_snapshot_failed')
    for pid, row in reversed(list(observed.items())):
        if pid not in current or not same_process(row, current[pid]) or current[pid]['state'] == 'Z':
            continue
        fd = None
        try:
            if sys.platform == 'linux':
                # Pidfd binds the signal target; starttime recheck after open rejects reuse.
                fd = os.pidfd_open(pid, 0)
                raw = Path(f'/proc/{pid}/stat').read_text()
                token = 'linux-ticks:' + raw[raw.rindex(')') + 2:].split()[19]
                if token != row['start']:
                    continue
                signal.pidfd_send_signal(fd, sig)
            else:
                # Controlled local fixtures only; never the production Linux owner.
                os.kill(pid, sig)
            sent.append({'pid': pid, 'start': row['start'], 'pgid_at_signal': current[pid]['pgid'], 'signal': int(sig)})
        except (ProcessLookupError, FileNotFoundError):
            pass
        except OSError as error:
            errors.append({'pid': pid, 'error': type(error).__name__, 'errno': error.errno})
        finally:
            if fd is not None:
                os.close(fd)
    return sent, errors


def rusage_record(usage):
    raw = {name: getattr(usage, name) for name in dir(usage) if name.startswith('ru_')}
    return checked_rusage(raw)


def checked_rusage(raw):
    # ru_maxrss is a maximum, not a sum or an aggregate simultaneous RSS.
    for name in ('ru_utime', 'ru_stime', 'ru_maxrss'):
        value = raw.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError('Invalid actual wait4 usage: ' + name)
    scale = 1 if sys.platform == 'darwin' else 1024
    return {'raw': raw, 'cpu_user_seconds': raw['ru_utime'], 'cpu_system_seconds': raw['ru_stime'], 'maximum_child_RSS_bytes': raw['ru_maxrss'] * scale, 'raw_maxrss_unit': 'bytes' if scale == 1 else 'KiB'}


def stop_owned(child, known, groups, grace_seconds=10, kill_seconds=3):
    # Only this function reaps the direct child. Preserve its reserved PID/PGID
    # through the escalation decision, even if process snapshots all fail.
    direct_unreaped = child.returncode is None
    report = {'direct_unreaped_on_entry': direct_unreaped, 'original_group_authority_ends_at_reap': True, 'signals': [], 'errors': [], 'actual_parent_wait': False, 'owned_present_before_stop': [], 'remaining_identities': [], 'unanchored_session_members': [], 'actual_adopted_child_waits': []}
    def observe():
        rows = cleanup_snapshot(report['errors'], 'cleanup_primary_snapshot_failed')
        live = owned_processes(rows, child.pid, known, groups, direct_unreaped)
        if _SUBREAPER_ENABLED:
            for pid, row in list(live.items()):
                if pid != child.pid and row['ppid'] == os.getpid() and row['state'] == 'Z':
                    try:
                        waited, status, usage = os.wait4(pid, os.WNOHANG)
                        if waited:
                            receipt = {'pid': pid, 'start': row['start'], 'waited_pid': waited, 'status': status, 'actual_wait4_usage_available': False}
                            report['actual_adopted_child_waits'].append(receipt)
                            try:
                                if waited != pid or not (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                                    raise ValueError('Adopted wait4 identity/status differs')
                                receipt['rusage'] = rusage_record(usage)
                                receipt['actual_wait4_usage_available'] = True
                            except Exception as error:
                                report['errors'].append({'stage': 'adopted_wait4_usage', 'pid': pid, 'start': row['start'], 'type': type(error).__name__, 'message': str(error)})
                            live.pop(pid)
                            rows.pop(pid)
                    except (ChildProcessError, OSError) as error:
                        report['errors'].append({'stage': 'adopted_wait4', 'pid': pid, 'start': row['start'], 'type': type(error).__name__, 'message': str(error)})
        return rows, live
    def direct_exited_without_reap():
        nonlocal direct_unreaped
        if not direct_unreaped:
            return True
        try:
            event = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            return event is not None and event.si_pid == child.pid
        except ChildProcessError:
            direct_unreaped = False
            report['errors'].append({'stage': 'direct_child_reaped_outside_owner'})
            return True
        except OSError as error:
            report['errors'].append({'stage': 'direct_exit_probe', 'errno': error.errno})
            return False
    def send(sig):
        live = {}
        errors = []
        snapshot_failed = False
        try:
            rows, live = observe()
            sent, errors = signal_known(live, sig)
            report['signals'].extend(sent)
            report['errors'].extend(errors)
        except Exception as error:
            snapshot_failed = True
            report['errors'].append({'stage': 'snapshot_or_signal', 'type': type(error).__name__, 'message': str(error)})
        # Even before the first successful snapshot, this unreaped Popen child
        # and its original new session/group are positively task-owned.
        fallback = snapshot_failed or any(row.get('pid') == child.pid for row in errors) or (child.pid not in live and not direct_exited_without_reap())
        if direct_unreaped and fallback:
            try:
                os.killpg(child.pid, sig)
                report['signals'].append({'original_popen_group': child.pid, 'signal': int(sig)})
                os.kill(child.pid, sig)  # No Popen.poll/send_signal reap here.
            except ProcessLookupError:
                pass
            except OSError as error:
                report['errors'].append({'stage': 'direct_popen_signal', 'errno': error.errno})
    try:
        rows, live = observe()
        report['owned_present_before_stop'] = list(live.values())
    except Exception as error:
        report['errors'].append({'stage': 'initial_snapshot', 'type': type(error).__name__, 'message': str(error)})
    send(signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        try:
            rows, live = observe()
            if not any(row['state'] != 'Z' for row in live.values()):
                break
        except Exception as error:
            report['errors'].append({'stage': 'grace_snapshot', 'type': type(error).__name__})
        time.sleep(.05)
    snapshot_complete = True
    try:
        rows, live = observe()
    except Exception:
        snapshot_complete = False
        live = known
    direct_exited = direct_exited_without_reap()
    if not snapshot_complete or any(row.get('state') != 'Z' for row in live.values()) or not direct_exited:
        send(signal.SIGKILL)
    report['escalation_decision_before_direct_reap'] = direct_unreaped
    # Only NOW may poll/wait release the direct child's numeric identity.
    direct_unreaped = False
    deadline = time.monotonic() + kill_seconds
    while time.monotonic() < deadline:
        child.poll()
        try:
            rows, live = observe()
            if child.returncode is not None and not live:
                break
        except Exception:
            pass
        time.sleep(.05)
    try:
        report['exit_code'] = child.wait(timeout=max(.01, deadline - time.monotonic()))
        report['actual_parent_wait'] = True
    except subprocess.TimeoutExpired:
        report['errors'].append({'stage': 'direct_wait_timeout'})
    final_snapshot_complete = False
    try:
        rows, live = observe()
        final_snapshot_complete = True
        report['remaining_identities'] = list(live.values())
        # No late adoption by group/name alone. Unknown members of retired
        # captured sessions make absence UNPROVEN and fail the trial.
        sessions = set(groups.values())
        report['unanchored_session_members'] = [row for pid, row in rows.items() if row['sid'] in sessions and pid not in live]
    except Exception as error:
        report['errors'].append({'stage': 'final_snapshot', 'type': type(error).__name__, 'message': str(error)})
    report['cleanup_confirmed_absent'] = final_snapshot_complete and report['actual_parent_wait'] and not report['remaining_identities'] and not report['unanchored_session_members']
    report['clean'] = report['actual_parent_wait'] and not report['remaining_identities'] and not report['unanchored_session_members'] and not report['errors']
    return report


def allocated(root):
    total = 0
    inodes = set()
    deadline = time.monotonic() + 1
    entries = 0
    def walk_error(error):
        if not isinstance(error, FileNotFoundError):
            raise error
    for directory, children, files in os.walk(root, followlinks=False, onerror=walk_error):
        children[:] = [name for name in children if not (Path(directory) / name).is_symlink()]
        for name in files:
            entries += 1
            if entries > 250000 or time.monotonic() > deadline:
                raise RuntimeError('Bounded owned-allocation census incomplete; disk accounting unproven')
            path = Path(directory) / name
            try:
                row = path.lstat()
            except FileNotFoundError:
                continue
            key = row.st_dev, row.st_ino
            if key not in inodes:
                inodes.add(key)
                total += row.st_blocks * 512
    return total


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--compiler', required=True)
    parser.add_argument('--native-db-libs-file', type=Path, required=True)
    parser.add_argument('--libpq-library', type=Path, required=True)
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--comparison-order', choices=['rust-safe-fast', 'safe-fast-rust', 'fast-rust-safe'], required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / '.owned-cold-trial.json').write_text(json.dumps({'pid': os.getpid(), 'captured_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}) + '\n')
    command = [sys.executable, str(repo / 'zig/bench/build_matrix.py'), '--compiler', args.compiler, '--native-db-libs-file', str(args.native_db_libs_file.resolve()), '--libpq-library', str(args.libpq_library.resolve()), '--toolchain', '1.98.0', '--jobs', '2', '--cpu', 'x86_64_v3_pclmul', '--rust-features', 'relayer/aleo,validator/aleo,scraper/aleo', '--native-cold', '--optional-native-sdks', '--reclaim-phase-caches', '--min-free-GiB', '40', '--runtime-free-GiB', '6', '--phase-timeout-seconds', '7200', '--git-sha', args.git_sha, '--comparison-order', args.comparison_order, '--cache-root', str(root / 'cache'), '--output', str(root / 'matrix'), '--execute']
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] if key in os.environ}
    env.update(RUSTC_WRAPPER='', RUSTC_WORKSPACE_WRAPPER='', CCACHE_DISABLE='1', SCCACHE_DISABLE='1', LC_ALL='C')
    record = {'schema': 2, 'passed': False, 'argv': command, 'comparison_order': args.comparison_order, 'counterbalance_scope': 'compiler pairs/positions only; prerequisites fixed first; no carryover/full-block counterbalance claim', 'limits': {'initial_free_bytes': 40 * GIB, 'runtime_free_bytes': 6 * GIB, 'max_tree_RSS_bytes': 16 * GIB, 'max_owned_allocated_growth_bytes': 64 * GIB, 'owner_deadline_seconds': 14400}, 'observed': [], 'samples': [], 'actual_parent_wait': False, 'no_inferred_parent_wait_credit': True}
    child = None
    known = {}
    groups = {}
    failure = None
    started = time.monotonic()
    watched = [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]
    previous_handlers = {sig: signal.getsignal(sig) for sig in watched}
    def interrupted(sig, frame):
        raise TaskInterrupted('Owner received signal ' + str(sig))
    for sig in watched:
        signal.signal(sig, interrupted)
    try:
        if sys.platform != 'linux':
            raise RuntimeError('Real cold owner requires Linux /proc starttime and pidfd signal support')
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('Linux pidfd APIs required')
        enable_subreaper()
        baseline = allocated(root)
        if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() != args.git_sha:
            raise RuntimeError('Checkout commit differs from approved trial commit')
        if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo, text=True).strip():
            raise RuntimeError('Dirty or untracked checkout before measured trial')
        initial = processes()
        if any(row['comm'] in COMPILERS for row in initial.values()):
            raise RuntimeError('Compiler already active before timed trial')
        if shutil.disk_usage(root).free < 40 * GIB:
            raise RuntimeError('Less than 40GiB free after toolchain/source staging')
        record['initial_host'] = {'platform': sys.platform, 'uname': list(os.uname()), 'load': list(os.getloadavg()), 'cpu_count': os.cpu_count(), 'build_jobs': 2, 'jobs_scope': 'build jobs, not all compiler internal threads', 'affinity_cpu_ids': sorted(os.sched_getaffinity(0)), 'free_bytes': shutil.disk_usage(root).free, 'runner_name': os.environ.get('RUNNER_NAME'), 'run_id': os.environ.get('GITHUB_RUN_ID'), 'proc_stat_CPU_ticks': Path('/proc/stat').read_text().splitlines()[0].split()[1:]}
        cpu = Path('/proc/cpuinfo').read_text()
        record['initial_host']['CPU_model'] = next((line.split(':', 1)[1].strip() for line in cpu.splitlines() if line.startswith('model name')), None)
        with (root / 'matrix.log').open('x') as log:
            old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
            try:
                def unmask_child():
                    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                child = subprocess.Popen(command, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=unmask_child)
                groups[child.pid] = child.pid
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
            last_disk = 0.0
            growth = 0
            while True:
                current = processes()
                live = owned_processes(current, child.pid, known, groups, child.returncode is None)
                elapsed = time.monotonic() - started
                free = shutil.disk_usage(root).free
                if elapsed - last_disk >= 2:
                    growth = allocated(root) - baseline
                    last_disk = elapsed
                rss = sum(row['rss_bytes'] for row in live.values())
                record['samples'].append({'elapsed_seconds': elapsed, 'RSS_bytes': rss, 'free_bytes': free, 'allocated_growth_bytes': growth, 'load': list(os.getloadavg())})
                outside = [row for pid, row in current.items() if pid not in live and row['comm'] in COMPILERS and row['state'] != 'Z']
                if outside:
                    record['unrelated_compilers'] = outside
                    raise RuntimeError('Unexpected concurrent compiler; quiet timing ineligible')
                if elapsed > 14400 or free < 6 * GIB or rss > 16 * GIB or growth > 64 * GIB:
                    raise RuntimeError('Owned cold trial resource/deadline guard breached')
                if child.poll() is not None:
                    break
                time.sleep(.2)
            record['exit_code'] = child.wait(timeout=1)
            record['actual_parent_wait'] = True
            if child.returncode:
                raise RuntimeError('Cold matrix child failed')
        result = json.loads((root / 'matrix/results.json').read_text())
        rows = result['results']
        prefix = ['native-sdk-cold', 'url-cold', 'optional-regex-cold', 'optional-starknet-cold', 'optional-aleo-crypto-cold', 'optional-aleo-vm-cold']
        orders = {'rust-safe-fast': ['rust', 'zig-ReleaseSafe', 'zig-ReleaseFast'], 'safe-fast-rust': ['zig-ReleaseSafe', 'zig-ReleaseFast', 'rust'], 'fast-rust-safe': ['zig-ReleaseFast', 'rust', 'zig-ReleaseSafe']}
        expected = prefix + [group + '-three-agent-' + suffix for group in orders[args.comparison_order] for suffix in ['cold', 'no-change']]
        if [row['name'] for row in rows] != expected or any(row['exit_code'] != 0 or not row['source_unchanged'] or row['disk_guard_triggered'] or not row['phase_owned_quiescent'] for row in rows):
            raise RuntimeError('Incomplete/changed-order or failed full-feature matrix')
        products = {}
        for row in rows:
            for item in row['artifacts']:
                path = Path(item['path'])
                expected_sha = ''.join(item['sha256_chunks'])
                if sha(path) != expected_sha or path.stat().st_size != item['bytes']:
                    raise RuntimeError('Final runtime product differs from measured phase descriptor')
                products[str(path)] = {'path': str(path), 'bytes': item['bytes'], 'sha256': expected_sha}
        from build_matrix import identity, generated_binding_identity
        record['final_source_identity'] = identity()
        if record['final_source_identity'] != rows[-1]['source_after_sha256_chunks']:
            raise RuntimeError('Source changed between final phase and owner postflight')
        record['final_generated_binding_identity'] = generated_binding_identity()
        if record['final_generated_binding_identity'] != rows[-1]['generated_bindings_after_sha256_chunks']:
            raise RuntimeError('Generated bindings changed between final phase and owner postflight')
        record['final_runtime_artifacts'] = list(products.values())
        record['matrix_results_sha256'] = sha(root / 'matrix/results.json')
        record['passed'] = True
    except BaseException as error:
        failure = error
        record['error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        # Repeated cancellation cannot interrupt the bounded cleanup/result write.
        for sig in watched:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if child is not None:
                cleanup = stop_owned(child, known, groups)
                record['cleanup'] = cleanup
                record['actual_parent_wait'] = cleanup['actual_parent_wait']
                record['exit_code'] = cleanup.get('exit_code')
                # An exit0 parent with lingering work never grants timing acceptance.
                if cleanup['owned_present_before_stop'] or not cleanup['clean']:
                    record['passed'] = False
            record['observed'] = list(known.values())
            record['elapsed_seconds'] = time.monotonic() - started
            record['final_free_bytes'] = shutil.disk_usage(root).free
            if sys.platform == 'linux':
                record['final_proc_stat_CPU_ticks'] = Path('/proc/stat').read_text().splitlines()[0].split()[1:]
        except BaseException as cleanup_error:
            record['passed'] = False
            record['cleanup_error'] = {'type': type(cleanup_error).__name__, 'message': str(cleanup_error)}
        finally:
            (root / 'owner-result.json').write_text(json.dumps(record, indent=2) + '\n')
            for sig, previous in previous_handlers.items():
                signal.signal(sig, previous)
    if failure is not None or not record['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
