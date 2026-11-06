#!/usr/bin/env python3
"""Reclaim only compiler outputs under a marked, fresh build-matrix cache.

Runtime artifacts stay at their original paths and receive immutable digest pins.
All work runs outside measured compiler intervals. Never touches source/downloads
or the caller's global compiler caches.
"""
from __future__ import annotations
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

MARKER = '.ziggy-build-matrix-owner.json'
COMPILER_DIRS = {'deps', 'build', 'incremental', '.fingerprint'}
DYNAMIC_SUFFIXES = {'.dylib', '.so', '.dll'}
ASSET_SUFFIXES = {'.params', '.parameters', '.proving', '.verifying', '.srs', '.vk', '.pk', '.aleo', '.dat', '.bytes'}

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    value = h.hexdigest()
    return [value[:32], value[32:]]

def mark(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('Expected fresh empty task cache before ownership marker')
    (root / MARKER).write_text(json.dumps({'schema': 1, 'purpose': 'ziggy-agent-build-matrix', 'root': str(root)}) + '\n')

def require_owned(root, path):
    root = Path(root).resolve()
    marker = root / MARKER
    if marker.is_symlink() or not marker.is_file():
        raise ValueError('Missing task cache ownership marker')
    value = json.loads(marker.read_text())
    if value != {'schema': 1, 'purpose': 'ziggy-agent-build-matrix', 'root': str(root)}:
        raise ValueError('Unexpected task cache ownership marker')
    path = Path(path)
    if path.is_symlink() or not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise ValueError('Reclamation outside task cache or through symlink rejected')
    return path.resolve()

def candidates(root, target):
    target = require_owned(root, target)
    output = []
    if not target.exists():
        return output
    for directory, children, _ in os.walk(target, followlinks=False):
        parent = Path(directory)
        children[:] = [name for name in children if not (parent / name).is_symlink()]
        if parent.name in {'release', 'debug'}:
            for name in COMPILER_DIRS:
                path = parent / name
                if path.is_symlink():
                    raise ValueError('Compiler output directory symlink rejected')
                if path.is_dir():
                    output.append(require_owned(root, path))
            children[:] = [name for name in children if name not in COMPILER_DIRS]
    return sorted(set(output))

def dynamic_dependencies(path, target):
    """Read loader metadata; retain absolute and ordinary in-target rpath peers."""
    if platform.system() == 'Darwin':
        result = subprocess.run(['otool', '-L', str(path)], text=True, capture_output=True)
        names = [line.strip().split(' (', 1)[0] for line in result.stdout.splitlines()[1:]] if result.returncode == 0 else []
    else:
        result = subprocess.run(['ldd', str(path)], text=True, capture_output=True)
        names = []
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                value = line.strip().split(' (', 1)[0]
                if ' => ' in value:
                    value = value.split(' => ', 1)[1]
                names.append(value)
    found = set()
    for name in names:
        options = []
        if name.startswith('/'):
            options.append(Path(name))
        elif name.startswith('@loader_path/'):
            options.append(path.parent / name[len('@loader_path/'):])
        elif name.startswith('@rpath/'):
            basename = name[len('@rpath/'):]
            options.extend([path.parent / basename, path.parent / 'deps' / basename, target / 'release' / basename, target / 'release/deps' / basename])
        for value in options:
            if value.exists() and value.resolve().is_relative_to(target):
                found.add(value.resolve())
    return found

def load_libraries(paths):
    loaded = []
    for path in sorted(paths):
        if path.suffix not in DYNAMIC_SUFFIXES:
            continue
        # Isolated process, no inherited credentials, loader overrides or SDK
        # initialization calls. Loading verifies the retained dependency closure.
        command = [sys.executable, '-c', 'import ctypes,sys; ctypes.CDLL(sys.argv[1])', str(path)]
        result = subprocess.run(command, env={'PATH': os.defpath}, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Runtime library load failed: ' + str(path) + ': ' + result.stderr[-1000:])
        loaded.append(str(path))
    return loaded

def runtime_files(target, directory_candidates, artifacts):
    keep = {Path(path).resolve() for path in artifacts if Path(path).is_file()}
    for directory, children, files in os.walk(target, followlinks=False):
        parent = Path(directory)
        if parent in directory_candidates:
            children[:] = []
            continue
        children[:] = [name for name in children if not (parent / name).is_symlink()]
        if parent.name in {'release', 'debug'}:
            for name in files:
                path = parent / name
                if path.is_file() and (os.access(path, os.X_OK) or path.suffix in DYNAMIC_SUFFIXES or path.suffix == '.a'):
                    keep.add(path.resolve())
    # Assets/licenses inside build outputs are conservatively retained in place.
    for candidate in directory_candidates:
        for directory, _, files in os.walk(candidate, followlinks=False):
            for name in files:
                path = Path(directory) / name
                if path.is_symlink():
                    continue
                asset = path.suffix in ASSET_SUFFIXES or (candidate.name != 'incremental' and path.suffix == '.bin')
                license_ = name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE'))
                if asset or license_:
                    keep.add(path.resolve())
    # Cargo often embeds an absolute install ID pointing at this same file in
    # deps. Preserve it even when the top-level library is a separate hardlink.
    for path in list(keep):
        if path.suffix in DYNAMIC_SUFFIXES:
            peer = path.parent / 'deps' / path.name
            if peer.is_file():
                keep.add(peer.resolve())
    queue = list(keep)
    while queue:
        path = queue.pop()
        if path.suffix in DYNAMIC_SUFFIXES or os.access(path, os.X_OK):
            for dependency in dynamic_dependencies(path, target):
                if dependency not in keep:
                    keep.add(dependency)
                    queue.append(dependency)
    return keep

def pin(root, path):
    checksum = digest(path)
    destination = Path(root) / 'artifact-pins' / checksum[0] / path.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    method = 'existing'
    if not destination.exists():
        try:
            os.link(path, destination)
            method = 'hardlink'
        except OSError:
            shutil.copy2(path, destination)
            method = 'copy'
    if digest(destination) != checksum:
        raise ValueError('Artifact pin digest mismatch')
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256_chunks': checksum, 'pin': str(destination), 'pin_method': method}

def remove_except(path, keep):
    if path.resolve() in keep:
        return {'files': 0, 'logical_bytes': 0, 'allocated_bytes_upper_bound': 0}
    total = {'files': 0, 'logical_bytes': 0, 'allocated_bytes_upper_bound': 0}
    if path.is_symlink():
        path.unlink()
        return total
    if path.is_dir():
        for child in list(path.iterdir()):
            result = remove_except(child, keep)
            for key, value in result.items():
                total[key] += value
        if not any(path.iterdir()):
            path.rmdir()
    else:
        info = path.stat()
        total.update(files=1, logical_bytes=info.st_size, allocated_bytes_upper_bound=getattr(info, 'st_blocks', 0) * 512)
        path.unlink()
    return total

def reclaim(root, target, artifacts=(), extra_preserve=()):
    start = time.monotonic()
    root = Path(root).resolve()
    target = require_owned(root, target)
    dirs = candidates(root, target)
    keep = runtime_files(target, dirs, artifacts)
    for path in extra_preserve:
        path = require_owned(root, path)
        if path.is_file():
            keep.add(path)
        elif path.is_dir():
            keep.update(p.resolve() for p in path.rglob('*') if p.is_file() and not p.is_symlink())
    for path in keep:
        require_owned(root, path)
    before_loads = load_libraries(keep)
    preserved = [pin(root, path) for path in sorted(keep)]
    plans = root / 'reclamation-plans'
    plans.mkdir(exist_ok=True)
    plan_path = plans / (target.name + '.json')
    plan_path.write_text(json.dumps({'target': str(target), 'compiler_directories': [str(path) for path in dirs], 'preserved_artifacts': preserved, 'dylibs_loaded_before': before_loads, 'outside_measured_intervals': True}, indent=2) + '\n')
    free_before = shutil.disk_usage(root).free
    removed = []
    for path in dirs:
        removed.append({'path': str(path), **remove_except(path, keep)})
    for row in preserved:
        if digest(row['path']) != row['sha256_chunks'] or digest(row['pin']) != row['sha256_chunks']:
            raise ValueError('Preserved runtime artifact changed during reclamation')
    after_loads = load_libraries(keep)
    return {'target': str(target), 'preservation_plan': str(plan_path), 'outside_measured_intervals': True, 'elapsed_seconds': time.monotonic() - start, 'compiler_directories': removed, 'preserved_artifacts': preserved, 'all_preserved_hashes_identical': True, 'dylibs_loaded_before': before_loads, 'dylibs_loaded_after': after_loads, 'free_disk_bytes_before': free_before, 'free_disk_bytes_after': shutil.disk_usage(root).free, 'free_disk_delta_bytes': shutil.disk_usage(root).free - free_before, 'space_qualification': 'Logical and allocated deletion totals are upper bounds: hardlinks, APFS clones and unrelated host writes can change physical reclamation. Free-space delta is observed, not attributed exclusively.', 'source_downloads_toolchains_untouched': True}

def reclaim_zig(root, paths, artifacts):
    """Generated task-owned Zig local/global caches, only after their paired run."""
    start = time.monotonic()
    root = Path(root).resolve()
    preserved = []
    for path in artifacts:
        path = require_owned(root, path)
        if path.is_file():
            preserved.append(pin(root, path))
    removed = []
    before = shutil.disk_usage(root).free
    for path in paths:
        path = require_owned(root, path)
        if path.name.startswith(('zig-local-', 'zig-global-')) and path.exists():
            removed.append({'path': str(path), **remove_except(path, set())})
        elif path.exists():
            raise ValueError('Unexpected generated Zig cache name')
    for row in preserved:
        if digest(row['path']) != row['sha256_chunks']:
            raise ValueError('Installed Zig binary changed during reclamation')
    return {'outside_measured_intervals': True, 'elapsed_seconds': time.monotonic() - start, 'compiler_directories': removed, 'preserved_artifacts': preserved, 'all_preserved_hashes_identical': True, 'free_disk_bytes_before': before, 'free_disk_bytes_after': shutil.disk_usage(root).free, 'free_disk_delta_bytes': shutil.disk_usage(root).free - before, 'scope': 'Only generated local/global caches beneath marked task root; user global cache untouched; source-edit/no-change cache reuse is not claimed after this event.'}
