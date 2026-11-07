#!/usr/bin/env python3
"""Owned dummy byte transports only. No chain, agent, SDK, build or download."""
import contextlib
import hashlib
import json
import socket
import struct
import threading
import unittest
import urllib.parse
from unittest import mock

from multivm_evidence import HttpFrames, RawTcpProxy, TransparentProxy


class DummyEndpoint:
    def __init__(self, handler):
        self.handler = handler
        self.stopping = threading.Event()
        self.connections = []
        self.errors = []

    def __enter__(self):
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.1)
        self.url = f"http://127.0.0.1:{self.listener.getsockname()[1]}"
        def run():
            try:
                while not self.stopping.is_set():
                    try:
                        connection, _ = self.listener.accept()
                        break
                    except socket.timeout:
                        continue
                else:
                    return
                self.connections.append(connection)
                connection.settimeout(3)
                self.handler(connection)
            except OSError as error:
                if not self.stopping.is_set():
                    self.errors.append(error)
            finally:
                for connection in self.connections:
                    connection.close()
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stopping.set()
        self.listener.close()
        for connection in self.connections:
            with contextlib.suppress(OSError):
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
        self.thread.join(timeout=4)
        if self.thread.is_alive():
            raise AssertionError("owned dummy endpoint thread did not retire")
        if self.errors:
            raise self.errors[0]


def receive_frame(connection, response=False):
    parser = HttpFrames(response=response)
    while True:
        data = connection.recv(65536)
        frames = parser.feed(data, eof=not data)
        if frames:
            return frames[0]
        if not data:
            raise AssertionError("dummy peer closed before complete frame")


class TransportTests(unittest.TestCase):
    def test_http_exact_bytes_and_observation_completes_before_forward(self):
        body = b'{"jsonrpc":"2.0","id":7,"method":"fixture","params":[]}'
        request = b"POST /public-rpc HTTP/1.1\r\nHost: fixture.local\r\nX-Public: Case Kept\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        response = b'HTTP/1.1 200 Public Fixture\r\nX-Public: AbC\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"id":7\r\na\r\n,"result":\r\n5\r\ntrue}\r\n0\r\n\r\n'
        observed, failures, requests = [], [], []
        entered, release = threading.Event(), threading.Event()
        def endpoint(connection):
            requests.append(receive_frame(connection)["wire"])
            connection.sendall(response)
        def observe(req, result, status, ns, frame):
            observed.append((req, result, status, ns, frame))
            entered.set()
            if not release.wait(3):
                raise AssertionError("dummy callback release missing")
        with DummyEndpoint(endpoint) as node:
            proxy = TransparentProxy(node.url, observe, failures.append)
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
            try:
                client.sendall(request)
                self.assertTrue(entered.wait(3))
                client.settimeout(0.05)
                with self.assertRaises(socket.timeout):
                    client.recv(1)
                release.set()
                client.settimeout(3)
                actual = receive_frame(client, response=True)
                self.assertEqual(actual["wire"], response)
                self.assertEqual(requests, [request])
                self.assertEqual(observed[0][1], {"id": 7, "result": True})
                self.assertEqual(observed[0][2], 200)
                self.assertEqual(observed[0][0]["wire"], request)
                self.assertEqual(observed[0][4]["wire"], response)
            finally:
                release.set()
                client.close()
                proxy.close()
            self.assertFalse(failures)
            self.assertTrue(all(not worker.is_alive() for worker in proxy.workers))

    def test_invalid_json_response_is_forwarded_exactly_and_evidence_fails(self):
        body = b'{"id":1,"method":"fixture","params":[]}'
        request = b"POST / HTTP/1.1\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        response = b"HTTP/1.1 503 Busy\r\nContent-Length: 9\r\n\r\nnot-json!"
        calls, failures = [], []
        def endpoint(connection):
            receive_frame(connection)
            connection.sendall(response)
        with DummyEndpoint(endpoint) as node:
            proxy = TransparentProxy(node.url, lambda *args: calls.append(args), failures.append)
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
            try:
                client.sendall(request)
                self.assertEqual(receive_frame(client, response=True)["wire"], response)
                self.assertFalse(calls)
                self.assertTrue(any("InvalidJsonResponse" in failure for failure in failures))
            finally:
                client.close()
                proxy.close()

    def test_http_observer_rejection_does_not_rewrite_node_result(self):
        body = b'{"id":1,"method":"fixture","params":[]}'
        request = b"POST / HTTP/1.1\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        response = b'HTTP/1.1 200 OK\r\nContent-Length: 22\r\n\r\n{"id":1,"result":true}'
        failures = []
        def endpoint(connection):
            receive_frame(connection)
            connection.sendall(response)
        def reject(*_):
            raise ValueError("intentional evidence rejection")
        with DummyEndpoint(endpoint) as node:
            proxy = TransparentProxy(node.url, reject, failures.append)
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
            try:
                client.sendall(request)
                self.assertEqual(receive_frame(client, response=True)["wire"], response)
                self.assertTrue(any("intentional evidence rejection" in failure for failure in failures))
            finally:
                client.close()
                proxy.close()

    def test_h2_preface_binary_bytes_and_halfclose_are_transparent(self):
        request = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" + bytes(range(256))
        response = b"\x00\x00\x00\x04\x00\x00\x00\x00\x00" + bytes(reversed(range(256)))
        requests, observations, failures = [], [], []
        def endpoint(connection):
            data = bytearray()
            while True:
                part = connection.recv(4096)
                if not part:
                    break
                data.extend(part)
            requests.append(bytes(data))
            connection.sendall(response)
            connection.shutdown(socket.SHUT_WR)
        with DummyEndpoint(endpoint) as node:
            proxy = RawTcpProxy(node.url, lambda *args: observations.append(args), failures.append)
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
            try:
                client.sendall(request)
                client.shutdown(socket.SHUT_WR)
                actual = bytearray()
                while True:
                    data = client.recv(4096)
                    if not data:
                        break
                    actual.extend(data)
                self.assertEqual(bytes(actual), response)
                self.assertEqual(requests, [request])
            finally:
                client.close()
                proxy.close()
            self.assertFalse(failures)
            self.assertEqual(len(observations), 1)
            streams = observations[0][0]
            self.assertEqual(streams["request"], {"bytes": len(request), "sha256": hashlib.sha256(request).hexdigest()})
            self.assertEqual(streams["response"], {"bytes": len(response), "sha256": hashlib.sha256(response).hexdigest()})
            self.assertEqual(streams["transport"], "tcp")

    def test_owned_cancel_retires_idle_http_and_h2_threads(self):
        for proxy_type in (TransparentProxy, RawTcpProxy):
            with self.subTest(proxy=proxy_type.__name__):
                accepted = threading.Event()
                def endpoint(connection):
                    accepted.set()
                    while connection.recv(4096):
                        pass
                failures = []
                with DummyEndpoint(endpoint) as node:
                    proxy = proxy_type(node.url, lambda *_: None, failures.append)
                    client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
                    try:
                        self.assertTrue(accepted.wait(3))
                        proxy.close()
                        self.assertFalse(proxy.thread.is_alive())
                        self.assertTrue(all(not worker.is_alive() for worker in proxy.workers))
                        self.assertEqual(proxy.listener.fileno(), -1)
                        self.assertFalse(failures)
                    finally:
                        client.close()
                        if proxy.thread.is_alive():
                            proxy.close()

    def test_abrupt_client_disconnect_is_recorded_without_synthesized_rpc_or_leaked_thread(self):
        requested, release = threading.Event(), threading.Event()
        reports = []
        def endpoint(connection):
            receive_frame(connection)
            requested.set()
            release.wait(3)
        with DummyEndpoint(endpoint) as node:
            proxy = TransparentProxy(node.url, lambda *_: self.fail("no node result exists"), reports.append)
            client = socket.create_connection(("127.0.0.1", proxy.listener.getsockname()[1]), timeout=3)
            try:
                body = b'{"id":1,"method":"fixture","params":[]}'
                client.sendall(b"POST / HTTP/1.1\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
                self.assertTrue(requested.wait(3))
                client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                client.close()
                # Request worker observes RST and shuts its owned upstream;
                # endpoint then exits without generating any fake RPC result.
                release.set()
                for worker in proxy.workers:
                    worker.join(timeout=3)
                self.assertTrue(all(not worker.is_alive() for worker in proxy.workers))
                self.assertTrue(any(isinstance(row, dict) and row.get("kind") == "peer_disconnect" for row in reports))
            finally:
                release.set()
                client.close()
                proxy.close()




class ExpectedCwUnavailablePeerTests(unittest.TestCase):
    def context(self):
        return {"scenario":"cosmwasm","chain":"cosmostest99990","domain":99990,"field":"grpcurls","ordinal":0,
                "upstream":"http://localhost:1337","healthy_fallback":"http://127.0.0.1:26603",
                "error_type":"ConnectionRefusedError","phase":"upstream_connect","role":"relayer","case_inputs_sha256":"a"*64}
    def proxy(self, context):
        proxy = RawTcpProxy.__new__(RawTcpProxy)
        proxy.upstream = urllib.parse.urlsplit("http://localhost:1337")
        proxy.expected_unavailable = context
        proxy.failure = mock.Mock()
        return proxy
    def test_only_expected_upstream_connect_refusal_produces_notice_without_receipt(self):
        proxy = self.proxy(self.context())
        with mock.patch("multivm_evidence.socket.create_connection", side_effect=ConnectionRefusedError("public fixture refused")):
            self.assertIsNone(proxy._open_upstream())
        notice = proxy.failure.call_args.args[0]
        self.assertEqual(notice["kind"],"expected_source_endpoint_unavailable")
        self.assertEqual(notice["error_type"],"ConnectionRefusedError")
        self.assertIs(notice["positive_receipt_credit"],False)
        self.assertEqual(notice["context"],self.context())
    def test_real_node_refusal_and_nonrefusal_transport_errors_stay_hard(self):
        for context,error in [(None,ConnectionRefusedError("actual node")),(self.context(),TimeoutError("timeout")),(self.context(),ValueError("malformed observer"))]:
            proxy = self.proxy(context)
            with mock.patch("multivm_evidence.socket.create_connection", side_effect=error):
                with self.assertRaises(type(error)):proxy._open_upstream()
            proxy.failure.assert_not_called()
    def test_crossed_family_endpoint_scope_or_ordinal_rejects_before_socket_creation(self):
        for key,value in [("scenario","cosmosnative"),("field","rpcurls"),("ordinal",1),("upstream","http://127.0.0.1:26603"),("healthy_fallback","http://127.0.0.1:26613"),("phase","response_parse"),("error_type","TimeoutError")]:
            context = dict(self.context(),**{key:value})
            with self.subTest(key=key),mock.patch("multivm_evidence.socket.socket") as socket_factory:
                with self.assertRaises(ValueError):RawTcpProxy("http://localhost:1337",lambda *_:None,lambda *_:None,expected_unavailable=context)
                socket_factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
