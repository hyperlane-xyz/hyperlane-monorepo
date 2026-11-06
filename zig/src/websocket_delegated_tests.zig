const std = @import("std");
const fixture_curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
const transport = @import("net/websocket/transport.zig");
const fixture = @import("net/websocket/testing.zig");
const tls_fixture = @import("net/websocket/tls_testing.zig");
const wire = @import("agents/stream/protocol.zig");
const abi = @import("evm/codecs.zig");
const A = std.mem.Allocator;

fn pollFor(client: *transport.Client, tag: std.meta.Tag(transport.Event.Kind)) !transport.Event {
    var timer = try std.time.Timer.start();
    while (timer.read() < 5 * std.time.ns_per_s) {
        if (try client.poll()) |event| {
            if (std.meta.activeTag(event.kind) == tag) return event;
            if (event.kind == .failed) return event.kind.failed;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.WebSocketTestTimeout;
}

fn pollFailure(client: *transport.Client) anyerror {
    const event = try pollFor(client, .failed);
    return event.kind.failed;
}

test "native WS handshake fragmented ping masked subscribe close and partial writes" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.full);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .read_timeout_ns = std.time.ns_per_s });
    defer client.deinit();
    try client.connect(url);
    const connected = try pollFor(&client, .connected);
    try std.testing.expectEqual(@as(u64, 1), connected.generation);
    const ready = try pollFor(&client, .text);
    try std.testing.expectEqualStrings("{\"type\":\"ready\"}", ready.kind.text);
    const payload = try a.alloc(u8, 17000);
    defer a.free(payload);
    @memset(payload, 'x');
    try client.sendText(payload);
    _ = try pollFor(&client, .closed);
}

test "native WS partially sent application frame finishes before pong" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.partial_control);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer client.deinit();
    try client.connect(url);
    _ = try pollFor(&client, .connected);
    const payload = try a.alloc(u8, 512 * 1024);
    defer a.free(payload);
    @memset(payload, 'x');
    try client.sendText(payload);
    _ = try pollFor(&client, .closed);
}

test "native WS coalesced large frame preserves payload and cross-fragment UTF8" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.coalesced);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer client.deinit();
    try client.connect(url);
    _ = try pollFor(&client, .connected);
    const large = try pollFor(&client, .text);
    try std.testing.expectEqual(@as(usize, 70 * 1024), large.kind.text.len);
    for (large.kind.text) |byte| try std.testing.expectEqual(@as(u8, 'a'), byte);
    const euro = try pollFor(&client, .text);
    try std.testing.expectEqualStrings("€", euro.kind.text);
    _ = try pollFor(&client, .closed);
}

test "native WS message cap fails closed without desynchronizing ownership" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.message_limit);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .limits = .{ .message_bytes = 16 } });
    defer client.deinit();
    try client.connect(url);
    _ = try pollFor(&client, .connected);
    try std.testing.expectEqual(error.WebSocketMessageLimit, pollFailure(&client));
}

test "native wait uses socket readiness for complete not partial buffered frames" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.wait_probe);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer client.deinit();
    try client.connect(url);
    _ = try pollFor(&client, .connected);
    var timer = try std.time.Timer.start();
    try client.wait(5, null);
    try std.testing.expect(timer.read() >= 3 * std.time.ns_per_ms);
    try client.wait(200, null);
    const event = try pollFor(&client, .text);
    try std.testing.expectEqualStrings("{}", event.kind.text);
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, client.wait(0, &cancel));
}

test "native WS reconnect generations EOF cancel deadline and no WSS downgrade" {
    const a = std.testing.allocator;
    var server = try fixture.Server.init(.reconnect);
    defer server.deinit();
    try server.start();
    const url = try server.url(a, false);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer client.deinit();
    try client.connect(url);
    const first = try pollFor(&client, .connected);
    _ = try pollFor(&client, .closed);
    try client.connect(url);
    const second = try pollFor(&client, .connected);
    try std.testing.expect(second.generation > first.generation);
    _ = try pollFor(&client, .closed);

    var eof_server = try fixture.Server.init(.eof);
    defer eof_server.deinit();
    try eof_server.start();
    const eof_url = try eof_server.url(a, false);
    defer a.free(eof_url);
    try client.connect(eof_url);
    try std.testing.expectEqual(error.WebSocketEof, pollFailure(&client));

    var silent = try fixture.Server.init(.silent);
    defer silent.deinit();
    try silent.start();
    const silent_url = try silent.url(a, false);
    defer a.free(silent_url);
    var cancel = std.atomic.Value(bool).init(false);
    var cancelled = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .cancel = &cancel });
    defer cancelled.deinit();
    try cancelled.connect(silent_url);
    cancel.store(true, .release);
    try std.testing.expectEqual(error.RequestCancelled, pollFailure(&cancelled));

    var deadline_server = try fixture.Server.init(.silent);
    defer deadline_server.deinit();
    try deadline_server.start();
    const deadline_url = try deadline_server.url(a, false);
    defer a.free(deadline_url);
    var timed = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .handshake_timeout_ns = 20 * std.time.ns_per_ms });
    defer timed.deinit();
    try timed.connect(deadline_url);
    try std.testing.expectEqual(error.RequestDeadlineExceeded, pollFailure(&timed));

    var plain = try fixture.Server.init(.plain);
    defer plain.deinit();
    try plain.start();
    const secure_url = try plain.url(a, true);
    defer a.free(secure_url);
    var secure = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer secure.deinit();
    try secure.connect(secure_url);
    try std.testing.expectEqual(error.CurlConnectFailed, pollFailure(&secure));
}

test "native WSS verifies CA hostname and rejects wrong hostname or untrusted certificate" {
    const a = std.testing.allocator;
    var server = try tls_fixture.Server.init(a, .localhost);
    defer server.deinit();
    const Handshake = struct {
        fn run(peer: *tls_fixture.Server) void {
            peer.completeHandshake(true) catch {};
        }
    };
    const thread = try std.Thread.spawn(.{}, Handshake.run, .{&server});
    defer thread.join();
    const url = try server.url(a);
    defer a.free(url);
    var client = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .ca_info = server.caPath(.localhost) });
    defer client.deinit();
    try client.connect(url);
    _ = try pollFor(&client, .connected);
    const large = try pollFor(&client, .text);
    try std.testing.expectEqual(@as(usize, 256 * 1024), large.kind.text.len);
    for (large.kind.text) |byte| try std.testing.expectEqual(@as(u8, 'x'), byte);
    try client.sendClose(1000, "");

    var wrong_host = try tls_fixture.Server.init(a, .otherhost);
    defer wrong_host.deinit();
    const wrong_url = try wrong_host.url(a);
    defer a.free(wrong_url);
    var wrong_client = try transport.Client.init(a, .{ .library_path = fixture_curl_library, .ca_info = wrong_host.caPath(.otherhost) });
    defer wrong_client.deinit();
    try wrong_client.connect(wrong_url);
    try std.testing.expectEqual(error.CurlConnectFailed, pollFailure(&wrong_client));

    var untrusted = try tls_fixture.Server.init(a, .localhost);
    defer untrusted.deinit();
    const untrusted_url = try untrusted.url(a);
    defer a.free(untrusted_url);
    var untrusted_client = try transport.Client.init(a, .{ .library_path = fixture_curl_library });
    defer untrusted_client.deinit();
    try untrusted_client.connect(untrusted_url);
    try std.testing.expectEqual(error.CurlConnectFailed, pollFailure(&untrusted_client));
}

test "Rust subscription JSON sequence gas and optional fields match exactly" {
    const a = std.testing.allocator;
    const cursors = [_]wire.StreamCursor{.{ .sequence = .{ .address = "0x1234", .allow_replay = true, .after_sequence = "41", .domain = 5 } }};
    const domains = [_]u32{5};
    const streams = [_]wire.SubscribeStream{.{ .cursors = &cursors, .domains = &domains, .event_type = "dispatch" }};
    const json = try wire.serializeSubscribe(a, .{ .streams = &streams });
    defer a.free(json);
    try std.testing.expectEqualStrings("{\"streams\":[{\"cursors\":[{\"address\":\"0x1234\",\"allowReplay\":true,\"afterSequence\":\"41\",\"domain\":5}],\"domains\":[5],\"eventType\":\"dispatch\"}],\"type\":\"subscribe\"}", json);
    const gas = [_]wire.StreamCursor{.{ .gas_payment = .{ .address = "0x1234", .after_stream_cursor = "41", .domain = 5 } }};
    const gas_streams = [_]wire.SubscribeStream{.{ .cursors = &gas, .domains = &domains, .event_type = "gas_payment", .stream_cursor_version = 3 }};
    const gas_json = try wire.serializeSubscribe(a, .{ .streams = &gas_streams });
    defer a.free(gas_json);
    try std.testing.expectEqualStrings("{\"streams\":[{\"cursors\":[{\"address\":\"0x1234\",\"afterStreamCursor\":\"41\",\"domain\":5}],\"domains\":[5],\"eventType\":\"gas_payment\",\"streamCursorVersion\":3}],\"type\":\"subscribe\"}", gas_json);
    const live = [_]wire.SubscribeStream{.{ .domains = &domains, .event_type = "gas_payment" }};
    const live_json = try wire.serializeSubscribe(a, .{ .streams = &live });
    defer a.free(live_json);
    try std.testing.expectEqualStrings("{\"streams\":[{\"domains\":[5],\"eventType\":\"gas_payment\"}],\"type\":\"subscribe\"}", live_json);
}

test "Rust server envelopes StringOrNumber and malformed boundaries" {
    const a = std.testing.allocator;
    var ready = try wire.parse(a, "{\"streamCursorVersions\":{\"gas_payment\":3},\"type\":\"ready\"}");
    defer ready.deinit();
    try std.testing.expectEqual(@as(u32, 3), ready.value.ready.stream_cursor_versions[0].version);
    var event = try wire.parse(a, "{\"type\":\"event\",\"data\":{\"value\":\"payload\"},\"domain\":5,\"eventType\":\"dispatch\",\"sequence\":\"42\"}");
    defer event.deinit();
    try std.testing.expectEqualStrings("42", event.value.event.sequence.?);
    var live = try wire.parse(a, "{\"type\":\"event\",\"data\":{\"value\":\"payload\"},\"domain\":5,\"eventType\":\"gas_payment\"}");
    defer live.deinit();
    try std.testing.expect(live.value.event.sequence == null);
    var gas = try wire.parse(a, "{\"type\":\"event\",\"data\":{},\"domain\":5,\"eventType\":\"gas_payment\",\"legacyMaxStreamCursor\":\"20\",\"rowId\":\"52\",\"streamCursor\":\"42\"}");
    defer gas.deinit();
    try std.testing.expectEqualStrings("20", gas.value.event.legacy_max_stream_cursor.?);
    var marker = try wire.parse(a, "{\"type\":\"caught_up\",\"address\":\"0x1234\",\"domain\":5,\"eventType\":\"gas_payment\",\"legacyMaxStreamCursor\":\"20\",\"streamCursor\":\"42\"}");
    defer marker.deinit();
    try std.testing.expectEqualStrings("42", marker.value.caught_up.stream_cursor.?);
    var subscribed = try wire.parse(a, "{\"type\":\"subscribed\",\"streams\":[{\"domains\":[5,9],\"eventType\":\"dispatch\"}]}");
    defer subscribed.deinit();
    try std.testing.expectEqualSlices(u32, &.{ 5, 9 }, subscribed.value.subscribed[0].domains.?);
    var rollback = try wire.parse(a, "{\"type\":\"rollback\",\"domain\":1,\"eventType\":\"merkle_tree_insertion\",\"toHeight\":\"12\"}");
    defer rollback.deinit();
    try std.testing.expect(rollback.value == .rollback);
    for ([_][]const u8{ "{", "{\"type\":\"subscribed\",\"streams\":[{\"eventType\":\"dispatch\",\"unknown\":1}]}", "{\"type\":\"subscribed\",\"streams\":[{\"eventType\":\"dispatch\",\"cursors\":[{\"address\":\"0x1234\",\"domain\":5,\"unknown\":1}]}]}" }) |bad| {
        if (wire.parse(a, bad)) |value| {
            var document = value;
            defer document.deinit();
            return error.ExpectedMalformedWireFailure;
        } else |_| {}
    }
    const number: wire.StringOrNumber = .{ .number = 43 };
    const string: wire.StringOrNumber = .{ .string = "42" };
    try std.testing.expectEqual(@as(u64, 43), try number.asU64());
    try std.testing.expectEqual(@as(u32, 42), try string.asU32());
}

fn confirmationAllocation(a: A, sequence: bool) !void {
    var originals_alive = true;
    const address = try a.dupe(u8, "0x1234");
    defer if (originals_alive) a.free(address);
    const after = try a.dupe(u8, "41");
    defer if (originals_alive) a.free(after);
    const event_type = try a.dupe(u8, "dispatch");
    defer if (originals_alive) a.free(event_type);
    const domains = [_]u32{5};
    const cursors = [_]wire.StreamCursor{if (sequence) .{ .sequence = .{ .address = address, .allow_replay = true, .after_sequence = after, .domain = 5 } } else .{ .gas_payment = .{ .address = address, .after_stream_cursor = after, .domain = 5 } }};
    const streams = [_]wire.SubscribeStream{.{ .cursors = &cursors, .domains = &domains, .event_type = event_type }};
    const expected = try wire.confirmation(a, .{ .streams = &streams });
    defer wire.freeConfirmation(a, expected);
    a.free(address);
    a.free(after);
    a.free(event_type);
    originals_alive = false;
    try wire.validateSubscription(expected, expected);
    try std.testing.expectEqualStrings("0x1234", expected[0].cursors.?[0].address);
    if (sequence) {
        try std.testing.expectEqualStrings("41", expected[0].cursors.?[0].after_sequence.?);
    } else {
        try std.testing.expectEqualStrings("41", expected[0].cursors.?[0].after_stream_cursor.?);
    }
}

test "confirmation deep owns strings domains and both cursor variants" {
    try confirmationAllocation(std.testing.allocator, true);
    try confirmationAllocation(std.testing.allocator, false);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, confirmationAllocation, .{true});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, confirmationAllocation, .{false});
}

fn moveDocument(document: wire.Document) wire.Document {
    return document;
}

test "moved Document preserves arena allocator and parsed values" {
    const a = std.testing.allocator;
    const original = try wire.parse(a, "{\"streamCursorVersions\":{\"gas_payment\":3},\"type\":\"ready\"}");
    var moved = moveDocument(original);
    defer moved.deinit();
    try std.testing.expectEqual(@as(u32, 3), moved.value.ready.stream_cursor_versions[0].version);
    try std.testing.expectEqualStrings("gas_payment", moved.value.ready.stream_cursor_versions[0].event_type);
}

test "subscription acknowledgement ordering and deep comparison" {
    var state: wire.SubscriptionState = .awaiting_ready;
    try std.testing.expectError(error.SubscribedBeforeReady, state.receiveSubscribed());
    try state.receiveReady();
    try std.testing.expectError(error.DuplicateReady, state.receiveReady());
    try state.receiveSubscribed();
    try std.testing.expectError(error.DuplicateSubscribed, state.receiveSubscribed());
    const domains = [_]u32{ 5, 9 };
    const cursors = [_]wire.SubscribedCursor{.{ .address = "0x1234", .after_sequence = "41", .domain = 5 }};
    const expected = [_]wire.SubscribedStream{.{ .confirmations = 3, .cursors = &cursors, .domains = &domains, .event_type = "merkle_tree_insertion" }};
    try wire.validateSubscription(&expected, &expected);
    var wrong = expected;
    wrong[0].confirmations = 1;
    try std.testing.expectError(error.SubscriptionConfirmationMismatch, wire.validateSubscription(&expected, &wrong));
    wrong = expected;
    wrong[0].cursors = null;
    try std.testing.expectError(error.SubscriptionConfirmationMismatch, wire.validateSubscription(&expected, &wrong));
}

test "address Merkle identity and source health boundaries" {
    const a = std.testing.allocator;
    const evm = [_]u8{0} ** 31 ++ [_]u8{1};
    const formatted = try wire.formatAddress(a, evm);
    defer a.free(formatted);
    try std.testing.expectEqualStrings("0x0000000000000000000000000000000000000001", formatted);
    try std.testing.expectEqual(evm, try wire.parseAddress(a, formatted));
    const full = [_]u8{0xab} ** 32;
    const full_text = try wire.formatAddress(a, full);
    defer a.free(full_text);
    try std.testing.expectEqual(full, try wire.parseAddress(a, full_text));
    const id = try abi.hexAlloc(a, &full);
    defer a.free(id);
    const hook = try wire.formatAddress(a, full);
    defer a.free(hook);
    const json = try std.fmt.allocPrint(a, "{{\"block_number\":12,\"domain\":1,\"leaf_index\":0,\"merkle_tree_hook\":\"{s}\",\"message_id\":\"{s}\"}}", .{ hook, id });
    defer a.free(json);
    var parsed = try std.json.parseFromSlice(std.json.Value, a, json, .{});
    defer parsed.deinit();
    const decoded = try wire.decodeMerkleData(a, parsed.value, 1, full, 0);
    try std.testing.expectEqual(@as(u32, 0), decoded.insertion.leaf_index);
    try std.testing.expectEqual(@as(u64, 12), decoded.block_number);
    try std.testing.expectError(error.MerkleDomainMismatch, wire.decodeMerkleData(a, parsed.value, 2, full, 0));
    try std.testing.expectError(error.MerkleSequenceMismatch, wire.decodeMerkleData(a, parsed.value, 1, full, 1));

    var health: wire.StreamHealth = .{ .grace_ns = 10 };
    try std.testing.expect(try health.observe(100, 99, true, 0));
    try std.testing.expect(health.observeProbeFailure(5));
    try std.testing.expect(!health.observeProbeFailure(10));
    try std.testing.expect(try health.observe(100, 100, true, 10));
    try std.testing.expect(health.observeProbeFailure(10));
    try std.testing.expectError(error.StreamCursorAhead, health.observe(3, 4, true, 10));
    var stale: wire.StreamHealth = .{ .grace_ns = 10 };
    try std.testing.expect(!(try stale.observe(104, 3, false, 0)));
    try std.testing.expectError(error.StreamStale, stale.observe(104, 3, false, 10));
    try std.testing.expect(!(try wire.validateCutoverFreshness(4, 3)));
    try std.testing.expect(try wire.validateCutoverFreshness(4, 4));
    try std.testing.expectError(error.StreamCursorAhead, wire.validateCutoverFreshness(3, 4));
    try std.testing.expectEqual(@as(u64, 5042 * std.time.ns_per_ms), wire.streamRetryDelay(42, false));
    try std.testing.expectEqual(@as(u64, 305042 * std.time.ns_per_ms), wire.streamRetryDelay(42, true));
    try std.testing.expect(wire.countSampleIsStale(4, 5, 4));
    try std.testing.expect(!wire.countSampleIsStale(5, 5, 4));
}

fn schemaAllocation(a: A) !void {
    const cursors = [_]wire.StreamCursor{.{ .sequence = .{ .address = "0x1234", .allow_replay = true, .after_sequence = "41", .domain = 5 } }};
    const domains = [_]u32{5};
    const streams = [_]wire.SubscribeStream{.{ .cursors = &cursors, .domains = &domains, .event_type = "dispatch" }};
    const message: wire.SubscribeMessage = .{ .streams = &streams };
    const json = try wire.serializeSubscribe(a, message);
    defer a.free(json);
    const expected = try wire.confirmation(a, message);
    defer wire.freeConfirmation(a, expected);
    var document = try wire.parse(a, "{\"type\":\"ready\"}");
    defer document.deinit();
}

test "schema allocation failures release every owned document" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, schemaAllocation, .{});
}
