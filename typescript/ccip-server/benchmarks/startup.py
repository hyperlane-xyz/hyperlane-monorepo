import argparse
import json
import signal
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


parser = argparse.ArgumentParser(description='Compare local CCIP bundles with synthetic registry data and outbound networking disabled')
parser.add_argument('parent_bundle', type=Path)
parser.add_argument('head_bundle', type=Path)
parser.add_argument('--node', default='node')
parser.add_argument('--rounds', type=int, default=5)
args = parser.parse_args()
if args.rounds < 1:
    parser.error('--rounds must be positive')
node_path = shutil.which(args.node)
if node_path is None:
    parser.error(f'Node executable not found: {args.node}')
node = str(Path(node_path).resolve())
workspace = tempfile.TemporaryDirectory(prefix='ccip-startup-benchmark-')
base = Path(workspace.name)
registry = base / 'registry'
chain = registry / 'chains' / 'ethereum'
chain.mkdir(parents=True)
(registry / 'deployments' / 'warp_routes').mkdir(parents=True)
(chain / 'metadata.yaml').write_text(json.dumps({'name': 'ethereum', 'chainId': 1, 'domainId': 1, 'protocol': 'ethereum', 'rpcUrls': [{'http': 'http://127.0.0.1:9'}], 'nativeToken': {'name': 'Ether', 'symbol': 'ETH', 'decimals': 18}}))
(chain / 'addresses.yaml').write_text(json.dumps({'interchainAccountRouter': '0x' + '11' * 20, 'mailbox': '0x' + '22' * 20}))
(base / 'ccip-network-disabled.mjs').write_text("import net from 'node:net';\nnet.Socket.prototype.connect=function(){throw new Error('Outbound network disabled for bundle benchmark');};\nglobalThis.fetch=async()=>{throw new Error('Outbound fetch disabled for bundle benchmark');};\nprocess.on('SIGUSR2',()=>{global.gc?.();process.stdout.write('BENCH_MEMORY '+JSON.stringify(process.memoryUsage())+'\\n');});\n")
bundles = {'parent': args.parent_bundle.resolve(), 'head': args.head_bundle.resolve()}

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]
rows = []
for repeat in range(args.rounds):
    for mode, bundle in bundles.items():
        port = free_port()
        metrics = free_port()
        env = {
            'NODE_ENV': 'test',
            'LOG_FORMAT': 'json',
            'SERVER_PORT': str(port),
            'PROMETHEUS_PORT': str(metrics),
            'REGISTRY_URI': str(registry),
            'SERVER_BASE_URL': f'http://127.0.0.1:{port}',
            'ENABLED_MODULES': 'cctp,callCommitments',
            'HYPERLANE_EXPLORER_URL': 'http://127.0.0.1:9',
            'CCTP_ATTESTATION_URL': 'http://127.0.0.1:9',
            'DATABASE_URL': 'postgresql://unused:unused@127.0.0.1:9/unused',
        }
        with tempfile.TemporaryDirectory() as tmp:
            logpath = Path(tmp) / 'log'
            log = logpath.open('w')
            start = time.perf_counter()
            proc = subprocess.Popen([node, '--expose-gc', '--import', str(base / 'ccip-network-disabled.mjs'), str(bundle)], env=env, cwd=registry, stdout=log, stderr=subprocess.STDOUT, text=True)
            row = {'mode': mode}
            try:
                deadline = time.time() + 20
                while time.time() < deadline and proc.poll() is None:
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=0.1) as r:
                            assert r.status == 200
                        with urllib.request.urlopen(f'http://127.0.0.1:{metrics}/metrics', timeout=0.1) as r:
                            assert r.status == 200
                        row['readyMs'] = (time.perf_counter() - start) * 1000
                        break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(0.01)
                if 'readyMs' not in row:
                    raise RuntimeError(logpath.read_text()[-1500:])
                proc.send_signal(signal.SIGUSR2)
                deadline = time.time() + 5
                while time.time() < deadline:
                    samples = [line[13:] for line in logpath.read_text().splitlines() if line.startswith('BENCH_MEMORY ')]
                    if samples:
                        row.update(json.loads(samples[-1]))
                        break
                    time.sleep(0.01)
                if 'heapUsed' not in row:
                    raise RuntimeError('Missing memory sample')
            finally:
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                log.close()
            rows.append(row)
print(json.dumps({'samples': rows}))
print(json.dumps({mode: {key: statistics.median((row[key] for row in rows if row['mode'] == mode)) for key in ['readyMs', 'heapUsed', 'rss']} for mode in bundles}))
print(json.dumps({mode: {'files': sum((1 for p in bundle.parent.rglob('*') if p.is_file())), 'bytes': sum((p.stat().st_size for p in bundle.parent.rglob('*') if p.is_file()))} for mode, bundle in bundles.items()}))
workspace.cleanup()
