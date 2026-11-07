"""Passive HTTP2 framing/HPACK controls; exact pinned test dependency only."""
import unittest

from hpack import Encoder

import multivm_h2 as h2


def frame(kind, flags, stream, payload=b""):
    return len(payload).to_bytes(3, "big") + bytes([kind, flags]) + stream.to_bytes(4, "big") + payload


def unary(payload):
    return b"\0" + len(payload).to_bytes(4, "big") + payload


class PassiveH2(unittest.TestCase):
    def fixture(self):
        events, failures = [], []
        connection = h2.Connection(events.append, failures.append, clock=lambda: 123)
        client, server = Encoder(), Encoder()
        connection.feed("request", h2.PREFACE + frame(4, 0, 0))
        connection.feed("response", frame(4, 0, 0))
        connection.feed("request", frame(4, 1, 0))
        connection.feed("response", frame(4, 1, 0))
        return connection, client, server, events, failures

    def request(self, encoder, stream=1, path="/hyperlane.core.v1.Query/Delivered", payload=b"actual public request"):
        headers = encoder.encode([(":method", "POST"), (":scheme", "http"), (":authority", "127.0.0.1:9000"), (":path", path), ("content-type", "application/grpc"), ("te", "trailers")])
        return frame(1, 4, stream, headers) + frame(0, 1, stream, unary(payload))

    def response(self, encoder, stream=1, payload=b"\x08\x01", status="0"):
        headers = encoder.encode([(":status", "200"), ("content-type", "application/grpc"), ("x-public-fixture", "kept")])
        trailers = encoder.encode([("grpc-status", status)])
        return frame(1, 4, stream, headers) + frame(0, 0, stream, unary(payload)) + frame(1, 5, stream, trailers)

    def test_every_single_split_correlates_unary_huffman_dynamic_headers_before_endstream(self):
        for split in range(1, 120):
            connection, client, server, events, failures = self.fixture()
            request, response = self.request(client), self.response(server)
            # Crossing arbitrary frame/header/HPACK/gRPC length boundaries must
            # not fabricate an earlier complete response or lose dynamic state.
            connection.feed("request", request[:split])
            connection.feed("request", request[split:])
            connection.feed("response", response[:-1])
            self.assertEqual(events, [])
            connection.feed("response", response[-1:])
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["request"]["protobuf"], "0x" + b"actual public request".hex())
            self.assertEqual(events[0]["response"]["protobuf"], "0x0801")
            self.assertEqual(events[0]["received_monotonic_ns"], 123)
            connection.feed("request", self.request(client, 3))
            connection.feed("response", self.response(server, 3))
            self.assertEqual([row["stream_id"] for row in events], [1, 3])
            self.assertEqual(failures, [])
            self.assertEqual(connection.streams, {})

    def test_continuation_padding_priority_and_settings_table_update(self):
        connection, client, server, events, failures = self.fixture()
        connection.feed("response", frame(4, 0, 0, b"\x00\x01" + (128).to_bytes(4, "big")))
        connection.feed("request", frame(4, 1, 0))
        client.header_table_size = 128
        block = client.encode([(":method", "POST"), (":scheme", "http"), (":path", "/hyperlane.core.v1.Query/Delivered"), ("content-type", "application/grpc")])
        split = len(block) // 2
        first = b"\x03" + bytes(5) + block[:split] + bytes(3)
        connection.feed("request", frame(1, 8 | 32, 1, first) + frame(9, 4, 1, block[split:]))
        connection.feed("request", frame(0, 1 | 8, 1, b"\x02" + unary(b"public") + bytes(2)))
        connection.feed("response", self.response(server))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["request"]["protobuf"], "0x" + b"public".hex())
        self.assertEqual(failures, [])
        self.assertEqual(connection.directions["request"]["decoder"].header_table_size, 128)

    def test_opaque_other_api_keeps_hpack_state_without_inventing_receipt(self):
        connection, client, server, events, failures = self.fixture()
        connection.feed("request", self.request(client, path="/cosmos.auth.v1beta1.Query/Account"))
        connection.feed("response", self.response(server, payload=b"not a delivery"))
        self.assertEqual(events, [])
        connection.feed("request", self.request(client, 3, path="/cosmwasm.wasm.v1.Query/SmartContractState"))
        connection.feed("response", self.response(server, 3))
        self.assertEqual(len(events), 1)
        self.assertEqual(failures, [])

    def test_remote_grpc_failure_is_not_a_positive_and_native_reset_keeps_dynamic_state(self):
        connection, client, server, events, failures = self.fixture()
        connection.feed("request", self.request(client))
        connection.feed("response", self.response(server, status="5"))
        self.assertEqual((events, failures), ([], []))
        connection.feed("request", self.request(client, 3))
        connection.feed("request", frame(3, 0, 3, (8).to_bytes(4, "big")))
        connection.feed("response", self.response(server, 3))
        self.assertEqual(events, [])
        self.assertEqual(failures[0]["kind"], "peer_disconnect")
        connection.feed("request", self.request(client, 5))
        connection.feed("response", self.response(server, 5))
        self.assertEqual([row["stream_id"] for row in events], [5])
        self.assertFalse(connection.failed)

    def test_malformed_header_framing_grpc_and_allocation_bounds_latch_hard_failure(self):
        cases = ["preface", "interleaved", "invalid_hpack", "padding", "length", "compressed", "multi_unary", "table_bound", "missing_status", "no_request_end", "callback"]
        for name in cases:
            with self.subTest(name=name):
                connection, client, server, events, failures = self.fixture()
                if name == "preface":
                    connection = h2.Connection(events.append, failures.append)
                    connection.feed("request", b"POST / HTTP/1.1\r\n")
                elif name == "interleaved":
                    connection.feed("request", frame(1, 0, 1, b"\x82") + frame(6, 0, 0, bytes(8)))
                elif name == "invalid_hpack":
                    connection.feed("request", frame(1, 4, 1, b"\xff" * 8))
                elif name == "padding":
                    connection.feed("request", frame(1, 8 | 4, 1, b"\x05x"))
                elif name == "length":
                    connection.feed("request", (h2.MAX_FRAME + 1).to_bytes(3, "big") + bytes([0, 0]) + (1).to_bytes(4, "big"))
                elif name == "table_bound":
                    connection.feed("response", frame(4, 0, 0, b"\x00\x01" + (h2.MAX_TABLE + 1).to_bytes(4, "big")))
                else:
                    request = self.request(client)
                    if name == "no_request_end":
                        # Keep complete request body but omit its END_STREAM.
                        reader = bytearray(request)
                        header_length = int.from_bytes(reader[:3], "big")
                        reader[9 + header_length + 4] = 0
                        request = bytes(reader)
                    connection.feed("request", request)
                    if name == "callback":
                        def reject(_):
                            raise ValueError("actual observer rejected")
                        connection.callback = reject
                    header = server.encode([(":status", "200"), ("content-type", "application/grpc")])
                    body = unary(b"\x08\x01")
                    if name == "compressed":
                        body = b"\x01" + body[1:]
                    if name == "multi_unary":
                        body += unary(b"\x08\x01")
                    tail = server.encode([] if name == "missing_status" else [("grpc-status", "0")])
                    connection.feed("response", frame(1, 4, 1, header) + frame(0, 0, 1, body) + frame(1, 5, 1, tail))
                self.assertTrue(connection.failed)
                self.assertTrue(failures)
                self.assertIsInstance(failures[-1], str)
                self.assertEqual(events, [])
                # A malformed stream cannot recover into later fake acceptance.
                connection.feed("request", self.request(client, 7))
                connection.feed("response", self.response(server, 7))
                self.assertEqual(events, [])

    def test_native_disconnect_only_notice_and_never_positive(self):
        connection, client, server, events, failures = self.fixture()
        connection.feed("request", self.request(client))
        connection.feed("response", self.response(server)[:-1])
        connection.close("response")
        self.assertEqual(events, [])
        self.assertFalse(connection.failed)
        self.assertEqual(failures[-1]["kind"], "peer_disconnect")

    def test_more_than_stream_cap_resets_retire_immediately_and_late_headers_keep_hpack(self):
        connection, client, server, events, failures = self.fixture()
        for index in range(h2.MAX_STREAMS + 30):
            stream = index * 2 + 1
            connection.feed("request", self.request(client, stream))
            connection.feed("request", frame(3, 0, stream, (8).to_bytes(4, "big")))
            self.assertEqual(connection.streams, {})
            # A genuine reset need not ever produce END_STREAM. Late headers
            # may still alter HPACK and later live streams may reference them.
            headers = server.encode([(":status", "200"), ("content-type", "application/grpc"), ("x-late-reset", str(index))])
            split = len(headers) // 2
            connection.feed("response", frame(1, 0, stream, headers[:split]))
            connection.feed("response", frame(9, 4, stream, headers[split:]))
            connection.feed("response", frame(0, 0, stream, unary(b"\x08\x01")))
            self.assertEqual(connection.streams, {})
            self.assertFalse(connection.failed)
        self.assertEqual(events, [])
        stream += 2
        connection.feed("request", self.request(client, stream))
        headers = server.encode([(":status", "200"), ("content-type", "application/grpc"), ("x-late-reset", str(h2.MAX_STREAMS + 29))])
        connection.feed("response", frame(1, 4, stream, headers) + frame(0, 0, stream, unary(b"\x08\x01")) + frame(1, 5, stream, server.encode([("grpc-status", "0")])))
        self.assertEqual([row["stream_id"] for row in events], [stream])
        self.assertEqual(len(failures), h2.MAX_STREAMS + 30)
        self.assertTrue(all(row["kind"] == "peer_disconnect" for row in failures))

    def test_runtime_mime_compression_and_duplicate_metadata_rules_before_witness(self):
        for mime in ["application/grpc", "Application/GRPC+Proto;charset=utf-8"]:
            connection, client, server, events, failures = self.fixture()
            connection.feed("request", self.request(client))
            headers = server.encode([(":status", "200"), ("content-type", mime), ("grpc-encoding", "IDENTITY"), ("content-encoding", "identity")])
            connection.feed("response", frame(1, 4, 1, headers) + frame(0, 0, 1, unary(b"\x08\x01")) + frame(1, 5, 1, server.encode([("grpc-status", "0")])))
            self.assertEqual((len(events), failures), (1, []))
        cases = ["invalid_mime", "content_compressed", "trailer_compressed", "duplicate_status", "duplicate_type", "duplicate_grpc_encoding", "duplicate_content_encoding", "duplicate_height"]
        for name in cases:
            with self.subTest(name=name):
                connection, client, server, events, failures = self.fixture()
                connection.feed("request", self.request(client))
                headers = [(":status", "200"), ("content-type", "application/grpc")]
                trailers = [("grpc-status", "0")]
                if name == "invalid_mime":
                    headers[1] = ("content-type", "application/grpc-web")
                elif name == "content_compressed":
                    headers.append(("content-encoding", "gzip"))
                elif name == "trailer_compressed":
                    trailers.append(("grpc-encoding", "gzip"))
                elif name == "duplicate_status":
                    headers.append(("grpc-status", "0"))
                else:
                    key = {"duplicate_type": "content-type", "duplicate_grpc_encoding": "grpc-encoding", "duplicate_content_encoding": "content-encoding", "duplicate_height": "x-cosmos-block-height"}[name]
                    value = "application/grpc" if key == "content-type" else "10" if key == "x-cosmos-block-height" else "identity"
                    if key != "content-type":
                        headers.append((key, value))
                    trailers.append((key, value))
                connection.feed("response", frame(1, 4, 1, server.encode(headers)) + frame(0, 0, 1, unary(b"\x08\x01")) + frame(1, 5, 1, server.encode(trailers)))
                self.assertTrue(connection.failed)
                self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
