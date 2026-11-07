"""Bounded untimed helper/tool allocation census; no process or build effects."""
import json
import os
from pathlib import Path
import time

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

