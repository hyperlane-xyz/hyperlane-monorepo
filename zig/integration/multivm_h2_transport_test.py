"""Owned Node HTTP2 dummy endpoints only; no VM, SDK, role or benchmark."""
import contextlib
import hashlib
import json
import os
import pathlib
import selectors
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest

from hpack import Encoder

from multivm_evidence import RawTcpProxy
from multivm_h2 import Connection, PREFACE
from multivm_h2_test import frame, unary


NODE_SOURCE = r"""
import http2 from 'node:http2';
import crypto from 'node:crypto';
const server = http2.createServer();
const sessions = new Set();
server.on('session', session => {
  sessions.add(session);
  session.on('error', () => {});
  session.on('close', () => sessions.delete(session));
});
server.on('stream', (stream, headers) => {
  const session = stream.session;
  const chunks = [];
  stream.on('error', () => {});
  stream.on('data', chunk => chunks.push(chunk));
  stream.on('end', () => {
    const body = Buffer.concat(chunks);
    console.log(JSON.stringify({path: headers[':path'], body_sha256: crypto.createHash('sha256').update(body).digest('hex'), body_bytes: body.length}));
    stream.respond({':status': 200, 'content-type': 'application/grpc', 'x-public-fixture': 'original'}, {waitForTrailers: true});
    stream.on('wantTrailers', () => stream.sendTrailers({'grpc-status': '0'}));
    stream.on('close', () => session.close());
    stream.end(Buffer.from([0, 0, 0, 0, 2, 8, 1]));
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({port: server.address().port})));
process.on('SIGTERM', () => {
  for (const session of sessions) session.destroy();
  server.close(() => process.exit(0));
});
"""


def read_line(stream):
    selector = selectors.DefaultSelector()
    try:
        selector.register(stream, selectors.EVENT_READ)
        if not selector.select(5):
            raise AssertionError("owned HTTP2 fixture did not report within budget")
        line = stream.readline()
        if not line:
            raise AssertionError("owned HTTP2 fixture exited without receipt")
        return json.loads(line)
    finally:
        selector.close()


class NodeEndpoint:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ziggy-h2-node-dummy-")
        self.child = None
        try:
            script = pathlib.Path(self.directory.name) / "public-http2-fixture.mjs"
            script.write_text(NODE_SOURCE)
            node = shutil.which("node")
            if node is None:
                raise AssertionError("owned dummy HTTP2 controls require explicit installed node")
            self.child = subprocess.Popen([node, script], cwd=self.directory.name, env={"PATH": os.environ["PATH"], "LANG": "C"}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.port = read_line(self.child.stdout)["port"]
            self.url = f"http://127.0.0.1:{self.port}"
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        try:
            if self.child is not None:
                if self.child.poll() is None:
                    self.child.terminate()
                try:
                    code = self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
                    raise AssertionError("owned dummy Node required forced cleanup")
                stderr = self.child.stderr.read().decode()
                self.child.stdout.close()
                self.child.stderr.close()
                if code != 0:
                    raise AssertionError(f"owned dummy Node exit {code}: {stderr}")
        finally:
            self.directory.cleanup()


def complete_frames(raw):
    frames, position = [], 0
    while len(raw) - position >= 9:
        length = int.from_bytes(raw[position:position + 3], "big")
        if len(raw) - position < length + 9:
            break
        frames.append((raw[position + 3], raw[position + 4], int.from_bytes(raw[position + 5:position + 9], "big") & 0x7fffffff, raw[position + 9:position + 9 + length]))
        position += length + 9
    return frames


class OwnedHttp2(unittest.TestCase):
    def exchange(self, *, reject_callback=False):
        failures, events, streams, received, receiver_errors = [], [], [], bytearray(), []
        entered, release, drained = threading.Event(), threading.Event(), threading.Event()
        def observe(event):
            events.append(event)
            entered.set()
            if not release.wait(5):
                raise AssertionError("owned before-forward witness gate timeout")
            if reject_callback:
                raise ValueError("actual passive observer rejected")
        with NodeEndpoint() as node:
            proxy = RawTcpProxy(node.url, lambda req, *_: streams.append(req), failures.append, h2_observer_factory=lambda: Connection(observe, failures.append))
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=5)
            client.settimeout(5)
            encoder = Encoder()
            headers = encoder.encode([(":method", "POST"), (":scheme", "http"), (":authority", f"127.0.0.1:{node.port}"), (":path", "/hyperlane.core.v1.Query/Delivered"), ("content-type", "application/grpc"), ("te", "trailers")])
            body = unary(b"public fixture mailbox and ID")
            request = PREFACE + frame(4, 0, 0) + frame(1, 4, 1, headers) + frame(0, 1, 1, body)
            def receive():
                try:
                    while True:
                        data = client.recv(65536)
                        if not data:
                            break
                        received.extend(data)
                except Exception as error:
                    receiver_errors.append(error)
                finally:
                    drained.set()
            receiver = threading.Thread(target=receive, daemon=True)
            receiver.start()
            try:
                client.sendall(request)
                self.assertTrue(entered.wait(5))
                self.assertFalse(any(kind in (0, 1) and flags & 1 and stream == 1 for kind, flags, stream, _ in complete_frames(received)), "final END_STREAM escaped before observer completed")
                self.assertFalse(drained.is_set())
                release.set()
                self.assertTrue(drained.wait(5))
                self.assertEqual(receiver_errors, [])
                self.assertTrue(any(kind in (0, 1) and flags & 1 and stream == 1 for kind, flags, stream, _ in complete_frames(received)))
                self.assertEqual(b"".join(payload for kind, _, stream, payload in complete_frames(received) if kind == 0 and stream == 1), unary(b"\x08\x01"))
                actual = read_line(node.child.stdout)
                self.assertEqual(actual, {"path": "/hyperlane.core.v1.Query/Delivered", "body_sha256": hashlib.sha256(body).hexdigest(), "body_bytes": len(body)})
            finally:
                release.set()
                with contextlib.suppress(OSError):
                    client.shutdown(socket.SHUT_RDWR)
                client.close()
                receiver.join(timeout=5)
                proxy.close()
                self.assertFalse(receiver.is_alive())
            self.assertEqual(len(streams), 1)
            self.assertEqual(streams[0]["request"], {"bytes": len(request), "sha256": hashlib.sha256(request).hexdigest()})
            self.assertEqual(streams[0]["response"], {"bytes": len(received), "sha256": hashlib.sha256(received).hexdigest()})
        return events, failures

    def test_actual_node_http2_unary_exact_stream_hashes_and_before_final_forward(self):
        events, failures = self.exchange()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["response"]["protobuf"], "0x0801")
        self.assertFalse(any(isinstance(error, str) for error in failures), failures)

    def test_observer_rejection_still_forwards_unchanged_native_http2_response(self):
        events, failures = self.exchange(reject_callback=True)
        self.assertEqual(len(events), 1)
        self.assertTrue(any(isinstance(error, str) and "actual passive observer rejected" in error for error in failures))


if __name__ == "__main__":
    unittest.main()
