"""Passive bounded HTTP2/gRPC witness decoder. Never generates network bytes.

The approved caller supplies hpack4.2.0 after verifying its distribution and
interpreter closure. feed() runs before forwarding the original TCP chunk. A
decoder/callback failure latches hard evidence failure, not a modified response.
"""
from __future__ import annotations

import threading
import time
import importlib
import importlib.abc
import importlib.util
import hashlib
import pathlib
import sys

from multivm_evidence import checked_artifact, require

PREFACE = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
DELIVERED_PATHS = {"/hyperlane.core.v1.Query/Delivered", "/cosmwasm.wasm.v1.Query/SmartContractState"}
MAX_FRAME = 1024 * 1024
MAX_HEADERS = 64 * 1024
MAX_BODY = 4 * 1024 * 1024
MAX_BUFFERED = 16 * 1024 * 1024
MAX_STREAMS = 128
MAX_TABLE = 16 * 1024


class VerifiedSourceLoader(importlib.abc.Loader):
    """Compile the pinned .py bytes directly; never consult or write pyc."""
    def __init__(self, row):
        self.row = row

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        path = checked_artifact(self.row)
        raw = path.read_bytes()
        require(len(raw) == self.row["bytes"] and hashlib.sha256(raw).hexdigest() == self.row["sha256"], "hpack source changed while loading")
        module.__file__ = str(path)
        exec(compile(raw, str(path), "exec", dont_inherit=True), module.__dict__)


class VerifiedHpackFinder(importlib.abc.MetaPathFinder):
    def __init__(self, package_root, rows):
        self.root, self.rows = pathlib.Path(package_root), rows
        self.modules = {}
        for path, row in rows.items():
            relative = pathlib.Path(path).relative_to(self.root)
            if relative.suffix != ".py":
                continue
            name = "hpack" if relative.name == "__init__.py" else "hpack." + relative.stem
            require(len(relative.parts) == 1, "unexpected hpack subpackage source")
            self.modules[name] = row

    def find_spec(self, fullname, path=None, target=None):
        if fullname != "hpack" and not fullname.startswith("hpack."):
            return None
        require(fullname in self.modules, "unreviewed hpack import")
        row = self.modules[fullname]
        spec = importlib.util.spec_from_loader(fullname, VerifiedSourceLoader(row), is_package=fullname == "hpack")
        spec.origin, spec.has_location = row["path"], True
        return spec


def load_verified_hpack(package_root, rows):
    """Install only the already reviewed package, rejecting ambient imports."""
    root = pathlib.Path(package_root)
    selected = {str(checked_artifact(row)): row for row in rows if pathlib.Path(row["path"]).is_relative_to(root)}
    require(selected and all(pathlib.Path(path).parent == root for path in selected), "hpack package source closure missing/nested")
    expected_modules = {"hpack", "hpack.exceptions", "hpack.hpack", "hpack.huffman", "hpack.huffman_constants", "hpack.huffman_table", "hpack.struct", "hpack.table"}
    candidate = VerifiedHpackFinder(root, selected)
    require(set(candidate.modules) == expected_modules, "hpack source-module closure differs")
    for name, module in list(sys.modules.items()):
        if name == "hpack" or name.startswith("hpack."):
            require(name in candidate.modules and isinstance(getattr(module, "__loader__", None), VerifiedSourceLoader) and module.__loader__.row == candidate.modules[name], "ambient/unpinned hpack module already imported")
    finders = [finder for finder in sys.meta_path if isinstance(finder, VerifiedHpackFinder)]
    require(len(finders) <= 1 and (not finders or finders[0].modules == candidate.modules), "different hpack source loader already installed")
    if not finders:
        sys.meta_path.insert(0, candidate)
    module = importlib.import_module("hpack")
    require(module.__version__ == "4.2.0", "verified hpack version differs")
    return module


def _unary(raw):
    require(len(raw) >= 5 and raw[0] == 0, "uncompressed unary gRPC envelope required")
    length = int.from_bytes(raw[1:5], "big")
    require(length <= MAX_BODY - 5 and len(raw) == 5 + length, "gRPC unary envelope length differs")
    return "0x" + raw[5:].hex()


def _grpc_metadata(part):
    headers, trailers = part["headers"] or {}, part["trailers"] or {}
    for name in ("grpc-status", "content-type", "grpc-encoding", "content-encoding", "x-cosmos-block-height"):
        require(not (name in headers and name in trailers), "duplicate native gRPC header/trailer " + name)
    combined = dict(headers, **trailers)
    mime = combined.get("content-type", "").split(";", 1)[0].lower()
    require(mime in {"application/grpc", "application/grpc+proto"}, "native observed response/request MIME differs")
    for name in ("grpc-encoding", "content-encoding"):
        require(combined.get(name, "identity").lower() == "identity", "native compressed unary witness unsupported")
    return combined


class Connection:
    def __init__(self, callback, failure, *, decoder_factory=None, clock=time.monotonic_ns):
        if decoder_factory is None:
            # Import only after the shared execution approval has verified the
            # exact package closure. Module import itself performs no discovery.
            from hpack import Decoder
            decoder_factory = Decoder
        self.callback, self.failure, self.clock = callback, failure, clock
        self.lock = threading.RLock()
        self.failed = False
        self.failure_message = None
        self.directions = {name: {"buffer": bytearray(), "decoder": decoder_factory(max_header_list_size=MAX_HEADERS), "continuation": None, "settings": [], "first_frame": True} for name in ("request", "response")}
        self.preface = bytearray()
        self.preface_done = False
        self.streams = {}
        self.highest_stream = 0

    def feed(self, direction, data):
        """Observe only; caller forwards data unchanged even when this fails."""
        with self.lock:
            if self.failed:
                return
            try:
                self._feed(direction, data)
            except Exception as error:
                self.failed = True
                self.failure_message = "PassiveH2EvidenceError: " + type(error).__name__ + ": " + str(error)
                self.streams.clear()
                for state in self.directions.values():
                    state["buffer"].clear()
                    state["continuation"] = None
                try:
                    self.failure(self.failure_message)
                except Exception:
                    # Failure logging must not prevent forwarding original
                    # bytes. The connection remains irreversibly failed.
                    self.failure_message += "; failure journal also failed"

    def close(self, direction):
        with self.lock:
            if self.failed:
                return
            state = self.directions[direction]
            if state["buffer"] or state["continuation"] is not None or self.streams:
                self.failure({"kind": "peer_disconnect", "scope": "grpc_h2_" + direction, "unfinished_streams": sorted(self.streams), "buffered_bytes": len(state["buffer"]), "monotonic_ns": self.clock()})

    def _feed(self, direction, data):
        require(direction in self.directions and isinstance(data, bytes), "invalid passive H2 input")
        if direction == "request" and not self.preface_done:
            remaining = len(PREFACE) - len(self.preface)
            self.preface.extend(data[:remaining])
            require(PREFACE.startswith(self.preface), "native gRPC requires original HTTP2 prior-knowledge preface")
            data = data[remaining:]
            if len(self.preface) < len(PREFACE):
                return
            self.preface_done = True
        state = self.directions[direction]
        state["buffer"].extend(data)
        require(len(state["buffer"]) <= MAX_FRAME + 9 + 65536, "passive H2 frame buffer bound exceeded")
        while len(state["buffer"]) >= 9:
            header = state["buffer"][:9]
            length, kind, flags = int.from_bytes(header[:3], "big"), header[3], header[4]
            stream = int.from_bytes(header[5:9], "big") & 0x7fffffff
            require(length <= MAX_FRAME, "passive H2 frame size bound exceeded")
            if len(state["buffer"]) < length + 9:
                return
            payload = bytes(state["buffer"][9:9 + length])
            del state["buffer"][:9 + length]
            if state["first_frame"]:
                require(kind == 4 and stream == 0 and not flags & 1, "native HTTP2 initial SETTINGS missing")
                state["first_frame"] = False
            require(state["continuation"] is None or kind == 9 and stream == state["continuation"]["stream"], "interleaved native HTTP2 header block")
            self._frame(direction, kind, flags, stream, payload)
            buffered = sum(len(item[part]["body"]) + len(item[part]["header_block"]) for item in self.streams.values() for part in ("request", "response"))
            require(buffered <= MAX_BUFFERED, "passive H2 connection body bound exceeded")

    @staticmethod
    def _part():
        return {"headers": None, "trailers": None, "header_block": bytearray(), "body": bytearray(), "body_bytes": 0, "ended": False, "header_end_stream": False}

    def _stream(self, direction, stream):
        require(stream > 0 and stream & 1 == 1, "unexpected native server-push/zero stream")
        if stream not in self.streams:
            require(len(self.streams) < MAX_STREAMS, "excessive native streams")
            if direction == "response" and stream <= self.highest_stream:
                # Frames already in flight after a genuine RST/closed stream
                # retain HPACK state but cannot grant any receipt witness.
                self.streams[stream] = {"request": self._part(), "response": self._part(), "observe": False, "path": None, "discard": True}
                self.streams[stream]["request"]["ended"] = True
                return self.streams[stream]
            require(direction == "request" and stream > self.highest_stream, "unknown/reused native stream")
            self.highest_stream = stream
            self.streams[stream] = {"request": self._part(), "response": self._part(), "observe": False, "path": None}
        return self.streams[stream]

    def _frame(self, direction, kind, flags, stream, payload):
        state = self.directions[direction]
        if kind == 4:
            require(stream == 0 and (not flags & 1 and len(payload) % 6 == 0 or flags & 1 and not payload), "invalid native SETTINGS")
            other = "response" if direction == "request" else "request"
            if flags & 1:
                pending = self.directions[other]["settings"]
                require(pending, "native SETTINGS ack has no peer settings")
                changes = pending.pop(0)
                if 1 in changes:
                    state["decoder"].max_allowed_table_size = changes[1]
            else:
                changes = {}
                for offset in range(0, len(payload), 6):
                    name, value = int.from_bytes(payload[offset:offset + 2], "big"), int.from_bytes(payload[offset + 2:offset + 6], "big")
                    require(name not in changes, "duplicate native SETTINGS parameter")
                    if name == 1:
                        require(value <= MAX_TABLE, "native HPACK table bound exceeded")
                    elif name == 2:
                        require(value in (0, 1), "invalid native push setting")
                    elif name == 4:
                        require(value <= 0x7fffffff, "invalid native initial window")
                    elif name == 5:
                        require(16384 <= value <= 16777215, "invalid native max frame setting")
                    changes[name] = value
                require(len(state["settings"]) < 32, "native SETTINGS queue bound exceeded")
                state["settings"].append(changes)
            return
        if kind == 6:
            require(stream == 0 and len(payload) == 8, "invalid native PING")
            return
        if kind == 8:
            require(len(payload) == 4 and int.from_bytes(payload, "big") & 0x7fffffff != 0, "invalid native WINDOW_UPDATE")
            return
        if kind == 7:
            require(stream == 0 and len(payload) >= 8, "invalid native GOAWAY")
            self.failure({"kind": "peer_disconnect", "scope": "grpc_h2_goaway", "last_stream": int.from_bytes(payload[:4], "big") & 0x7fffffff, "error_code": int.from_bytes(payload[4:8], "big"), "monotonic_ns": self.clock()})
            return
        if kind == 3:
            require(stream > 0 and len(payload) == 4, "invalid native RST_STREAM")
            self.streams.pop(stream, None)
            self.failure({"kind": "peer_disconnect", "scope": "grpc_h2_rst_stream", "stream": stream, "error_code": int.from_bytes(payload, "big"), "monotonic_ns": self.clock()})
            return
        if kind == 2:
            require(stream > 0 and len(payload) == 5 and int.from_bytes(payload[:4], "big") & 0x7fffffff != stream, "invalid native PRIORITY")
            return
        if kind not in (0, 1, 9):
            require(kind != 5, "native server push unsupported")
            return  # RFC extension frames do not change HPACK or unary state.
        if kind == 0 and stream not in self.streams and 0 < stream <= self.highest_stream:
            return  # In-flight DATA after an already retired/reset stream.
        item = self._stream(direction, stream)
        part = item[direction]
        require(not part["ended"], "native frame after stream direction ended")
        if kind in (0, 1) and flags & 8:
            require(payload and payload[0] < len(payload), "invalid native frame padding")
            padding = payload[0]
            payload = payload[1:len(payload) - padding]
        if kind == 1 and flags & 32:
            require(len(payload) >= 5 and int.from_bytes(payload[:4], "big") & 0x7fffffff != stream, "invalid native HEADERS priority")
            payload = payload[5:]
        if kind == 0:
            require(part["headers"] is not None and part["trailers"] is None, "native DATA outside initial headers")
            part["body_bytes"] += len(payload)
            require(part["body_bytes"] <= MAX_BODY, "native unary body bound exceeded")
            if item["observe"]:
                part["body"].extend(payload)
            if flags & 1:
                part["ended"] = True
                self._finish(stream)
            return
        if kind == 1:
            require(part["trailers"] is None, "duplicate native trailing HEADERS")
            part["header_end_stream"] = bool(flags & 1)
        else:
            require(state["continuation"] is not None, "native CONTINUATION without HEADERS")
        part["header_block"].extend(payload)
        require(len(part["header_block"]) <= MAX_HEADERS, "native compressed header bound exceeded")
        if not flags & 4:
            state["continuation"] = {"stream": stream}
            return
        state["continuation"] = None
        headers = state["decoder"].decode(bytes(part["header_block"]))
        part["header_block"].clear()
        values = {}
        pseudo_ended = False
        for name, value in headers:
            require(isinstance(name, str) and isinstance(value, str) and name == name.lower(), "invalid native HTTP2 header text")
            if name.startswith(":"):
                require(not pseudo_ended, "native pseudo-header after ordinary header")
            else:
                pseudo_ended = True
            require(name not in values, "duplicate native unary header")
            require(name not in {"authorization", "proxy-authorization"}, "private authentication forbidden in public native tap")
            values[name] = value
        if item.get("discard"):
            # A reset has no obligation to produce END_STREAM. Decode every
            # late complete header block for HPACK state, then retire it now.
            del self.streams[stream]
            return
        if part["headers"] is None:
            part["headers"] = values
            if direction == "request":
                require(values.get(":method") == "POST" and values.get(":scheme") == "http" and isinstance(values.get(":path"), str), "native gRPC request headers differ")
                item["path"] = values[":path"]
                item["observe"] = item["path"] in DELIVERED_PATHS
        else:
            require(all(not name.startswith(":") for name in values) and part["header_end_stream"], "native unary trailers must end stream")
            part["trailers"] = values
        if part["header_end_stream"]:
            part["ended"] = True
            self._finish(stream)

    def _finish(self, stream):
        item = self.streams[stream]
        request, response = item["request"], item["response"]
        if not response["ended"]:
            return
        if item.get("discard"):
            del self.streams[stream]
            return
        require(request["ended"], "native unary response ended before complete request")
        if item["observe"]:
            require(response["headers"].get(":status") == "200", "native observed gRPC HTTP status failed")
            trailers = response["trailers"] or {}
            _grpc_metadata(request)
            metadata = _grpc_metadata(response)
            status = metadata.get("grpc-status")
            require(status is not None and status.isascii() and status.isdecimal() and int(status) < 2 ** 32, "native unary grpc-status missing/invalid")
            if status == "0":
                event = {"wire_protocol": "grpc-h2", "stream_id": stream, "status": 200, "received_monotonic_ns": self.clock(), "request": {"method": item["path"], "protobuf": _unary(bytes(request["body"])), "headers": request["headers"]}, "response": {"protobuf": _unary(bytes(response["body"])), "headers": response["headers"], "trailers": trailers}}
                self.callback(event)
            # Nonzero grpc-status is an actual remote failure, never a positive
            # witness or evidence parser error. Its original bytes pass through.
        del self.streams[stream]
