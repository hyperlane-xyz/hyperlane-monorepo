//! Ports `event-websocket.test.ts` and the protocol cases of
//! `confirmation-stream.test.ts`.
const std = @import("std");
const testing = std.testing;
const p = @import("protocol.zig");
const core = @import("core");

const Fixture = struct {
    arena: std.heap.ArenaAllocator,
    diag: p.Diag = .{},

    fn init() Fixture {
        return .{ .arena = .init(testing.allocator) };
    }
    fn deinit(self: *Fixture) void {
        self.arena.deinit();
    }
    fn parse(self: *Fixture, raw: []const u8) !p.ClientMessage {
        return p.parseClientMessage(self.arena.allocator(), raw, &self.diag);
    }
    fn subscribe(self: *Fixture, raw: []const u8) ![]const p.StreamRequest {
        const message = try self.parse(raw);
        return message.subscribe;
    }
    /// Asserts a validation failure whose message contains `expected`.
    fn rejects(self: *Fixture, raw: []const u8, expected: []const u8) !void {
        if (self.parse(raw)) |_| {
            std.debug.print("accepted: {s}\n", .{raw});
            return error.TestExpectedError;
        } else |err| {
            try testing.expectEqual(error.Invalid, err);
            if (std.mem.indexOf(u8, self.diag.message, expected) == null) {
                std.debug.print("message {s} lacks {s} for {s}\n", .{ self.diag.message, expected, raw });
                return error.TestUnexpectedResult;
            }
        }
    }
    fn params(self: *Fixture, query: []const u8) !p.QueryParams {
        return p.QueryParams.parse(self.arena.allocator(), query);
    }
};

test "accepts optional live block subscriptions alongside events" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"type":"subscribe","streams":[{"eventType":"blocks","domains":[1,42161]},{"eventType":"dispatch"}]}
    );
    try testing.expectEqual(p.StreamKind.blocks, streams[0].kind);
    try testing.expectEqualSlices(u32, &.{ 1, 42161 }, streams[0].domains.?);
    try testing.expectEqual(@as(?u64, null), streams[0].confirmations);
    for ([_][]const u8{ "\"cursors\":[]", "\"confirmations\":0", "\"domains\":[]", "\"domains\":[-1]", "\"streamCursorVersion\":3" }) |extra| {
        const raw = try std.fmt.allocPrint(f.arena.allocator(), "{{\"type\":\"subscribe\",\"streams\":[{{\"eventType\":\"blocks\",{s}}}]}}", .{extra});
        try f.rejects(raw, "");
    }
    try testing.expectEqual(false, try p.parseExplorerBlocks(&try f.params(""), &f.diag));
    try testing.expectEqual(true, try p.parseExplorerBlocks(&try f.params("blocks=true"), &f.diag));
    try testing.expectEqual(false, try p.parseExplorerBlocks(&try f.params("blocks=false"), &f.diag));
    try testing.expectError(error.Invalid, p.parseExplorerBlocks(&try f.params("blocks=oops"), &f.diag));
    try testing.expectEqualStrings("Expected blocks=true", f.diag.message);
}

test "parses indexed block hashes without losing large heights" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    const hash = "01ab" ** 16;
    const head = try p.parseHeadNotification(a,
        \\{"domain":1,"confirmedHeight":"10","headHeight":"9007199254740993","indexedHeight":"11","indexedHash":"
    ++ hash ++ "\"}", &f.diag);
    try testing.expectEqualStrings("0x" ++ hash, head.indexed_hash.?);
    try testing.expectEqual(@as(?i128, 9007199254740993), head.head_height);
    for ([_][]const u8{ "\"bad\"", "null", "123" }) |indexed_hash| {
        const raw = try std.fmt.allocPrint(a, "{{\"domain\":1,\"confirmedHeight\":\"10\",\"headHeight\":\"9\",\"indexedHeight\":\"11\",\"indexedHash\":{s}}}", .{indexed_hash});
        const parsed = try p.parseHeadNotification(a, raw, &f.diag);
        try testing.expectEqual(@as(?[]const u8, null), parsed.indexed_hash);
        try testing.expectEqual(@as(i128, 10), parsed.confirmed_height);
        try testing.expectEqual(@as(?i128, 11), parsed.indexed_height);
    }
    const missing = try p.parseHeadNotification(a,
        \\{"domain":1,"confirmedHeight":"10","indexedHeight":"11"}
    , &f.diag);
    try testing.expectEqual(@as(?[]const u8, null), missing.indexed_hash);
}

test "parses native sequence catch-up cursors" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","cursors":[
        \\{"address":"0x0000000000000000000000000000000000000001","allowReplay":true,"afterSequence":"9007199254740993","domain":1},
        \\{"address":"\\x0000000000000000000000000000000000000002","domain":42161}]},
        \\{"eventType":"merkle_tree_insertion"}]}
    );
    const cursor = streams[0].cursors.?[0];
    try testing.expectEqual(@as(i128, 9_007_199_254_740_993), cursor.after.?.value);
    try testing.expectEqualStrings("9007199254740993", cursor.after.?.text);
    try testing.expectEqualStrings("\\x0000000000000000000000000000000000000001", cursor.address);
    try testing.expectEqual(@as(?bool, true), cursor.allow_replay);
    try testing.expectEqualStrings("\\x0000000000000000000000000000000000000002", streams[0].cursors.?[1].address);
    try testing.expectEqualSlices(u32, &.{ 1, 42161 }, streams[0].domains.?);
    try testing.expect(streams[1].cursors == null);
}

test "canonicalizes padded 20-byte sequence cursor addresses for every VM" {
    var f = Fixture.init();
    defer f.deinit();
    const hook = "48e6c30b97748d1e2e03bf3e9fbe3890ca5f8cca";
    const streams = try f.subscribe(
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","cursors":[{"address":"0x
    ++ "00" ** 12 ++ hook ++
        \\","afterSequence":"-1","domain":1}]}]}
    );
    try testing.expectEqualStrings("\\x" ++ hook, streams[0].cursors.?[0].address);
    try testing.expectEqual(@as(i128, -1), streams[0].cursors.?[0].after.?.value);
}

test "accepts application pings" {
    var f = Fixture.init();
    defer f.deinit();
    try testing.expect((try f.parse("{\"type\":\"ping\"}")) == .ping);
}

test "rejects duplicate streams" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"delivery"},{"eventType":"delivery"}]}
    , "Duplicate eventType");
}

test "rejects stream-level row IDs and cursors on unsupported streams" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","afterId":"1"}]}
    , "cursor positions must be specified within a cursor");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"delivery","cursors":[{"address":"0x0000000000000000000000000000000000000001","afterId":"1","domain":1}]}]}
    , "cursors are unsupported for this stream");
}

test "parses negotiated per-domain gas payment stream cursors" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"streams":[{"cursors":[{"address":"0x0000000000000000000000000000000000000001","afterStreamCursor":"9007199254740993","domain":1}],"eventType":"gas_payment","streamCursorVersion":3}],"type":"subscribe"}
    );
    const cursor = streams[0].cursors.?[0];
    try testing.expectEqual(p.CursorKind.gas_payment, cursor.kind);
    try testing.expectEqual(@as(i128, 9_007_199_254_740_993), cursor.after.?.value);
    try testing.expectEqualSlices(u32, &.{1}, streams[0].domains.?);
    try testing.expectEqual(@as(?u8, 3), streams[0].stream_cursor_version);
}

test "accepts legacy non-cursored gas payment subscriptions" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"streams":[{"domains":[1],"eventType":"gas_payment"}],"type":"subscribe"}
    );
    try testing.expectEqualSlices(u32, &.{1}, streams[0].domains.?);
    try testing.expectEqual(@as(?u8, null), streams[0].stream_cursor_version);
    try testing.expect(streams[0].cursors == null);
}

test "rejects physical row ID and unversioned gas cursors" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"streams":[{"cursors":[{"address":"0x0000000000000000000000000000000000000001","afterId":"1","domain":1}],"eventType":"gas_payment","streamCursorVersion":3}],"type":"subscribe"}
    , "afterId is unsupported; use negotiated afterStreamCursor semantics");
    try f.rejects(
        \\{"streams":[{"cursors":[{"address":"0x0000000000000000000000000000000000000001","afterStreamCursor":"1","domain":1}],"eventType":"gas_payment"}],"type":"subscribe"}
    , "gas_payment cursors require streamCursorVersion 3");
}

test "rejects native sequence fields on gas payment cursors" {
    var f = Fixture.init();
    defer f.deinit();
    for ([_][]const u8{ "\"afterSequence\":\"1\"", "\"allowReplay\":true" }) |field| {
        const raw = try std.fmt.allocPrint(f.arena.allocator(),
            \\{{"streams":[{{"cursors":[{{"address":"0x0000000000000000000000000000000000000001","domain":1,{s}}}],"eventType":"gas_payment","streamCursorVersion":3}}],"type":"subscribe"}}
        , .{field});
        try f.rejects(raw, "native sequence fields");
    }
}

test "rejects the previous gas payment wire version" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"streams":[{"cursors":[{"address":"0x0000000000000000000000000000000000000001","afterStreamCursor":"1","domain":1}],"eventType":"gas_payment","streamCursorVersion":2}],"type":"subscribe"}
    , "requires streamCursorVersion 3");
}

test "requires explicit domains to match cursor domains" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","domains":[1,42161],"cursors":[{"address":"0x0000000000000000000000000000000000000001","domain":1}]}]}
    , "exactly match");
}

test "rejects unknown event types and invalid domains" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"message"}]}
    , "Invalid eventType");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","domains":[-1]}]}
    , "domains must contain valid domain IDs");
}

test "rejects malformed sequence cursor addresses" {
    var f = Fixture.init();
    defer f.deinit();
    _ = try f.subscribe(
        \\{"streams":[{"cursors":[{"address":"0x
    ++ "ab" ** 32 ++
        \\","domain":1}],"eventType":"dispatch"}],"type":"subscribe"}
    );
    for ([_][]const u8{ "0xabc", "0x" ++ "ab" ** 19, "0x" ++ "ab" ** 21, "0x" ++ "ab" ** 31, "0x" ++ "ab" ** 33 }) |address| {
        const raw = try std.fmt.allocPrint(f.arena.allocator(),
            \\{{"streams":[{{"cursors":[{{"address":"{s}","domain":1}}],"eventType":"dispatch"}}],"type":"subscribe"}}
        , .{address});
        try f.rejects(raw, "Invalid sequence cursor address");
    }
}

test "accepts more than 100 domains" {
    var f = Fixture.init();
    defer f.deinit();
    var raw: std.ArrayList(u8) = .empty;
    const a = f.arena.allocator();
    try raw.appendSlice(a, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[");
    for (0..101) |domain| {
        if (domain > 0) try raw.append(a, ',');
        try raw.print(a, "{d}", .{domain});
    }
    try raw.appendSlice(a, "]}]}");
    const streams = try f.subscribe(raw.items);
    try testing.expectEqual(@as(usize, 101), streams[0].domains.?.len);
}

test "parses exact-row database notifications" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    const first = try p.parseEventNotification(a, "{\"eventType\":\"merkle_tree_insertion\",\"id\":\"123\",\"domain\":42161}", &f.diag);
    try testing.expectEqual(p.EventNotification{ .domain = 42161, .event_type = .merkle_tree_insertion, .id = 123 }, first);
    const second = try p.parseEventNotification(a, "{\"eventType\":\"dispatch\",\"id\":\"124\",\"domain\":-846819108}", &f.diag);
    try testing.expectEqual(p.EventNotification{ .domain = 3448148188, .event_type = .dispatch, .id = 124 }, second);
    try testing.expectError(error.Invalid, p.parseEventNotification(a, "{\"eventType\":\"unknown\",\"id\":\"123\",\"domain\":42161}", &f.diag));
    try testing.expectEqualStrings("Invalid scraper event notification", f.diag.message);
    try testing.expectError(error.Invalid, p.parseEventNotification(a, "{\"eventType\":\"dispatch\",\"id\":\"123\",\"domain\":-2147483649}", &f.diag));
    try testing.expectError(error.Invalid, p.parseEventNotification(a, null, &f.diag));
    try testing.expectEqualStrings("Missing scraper event notification payload", f.diag.message);
    try testing.expectError(error.Invalid, p.parseEventNotification(a, "{", &f.diag));
    try testing.expectEqualStrings("Invalid scraper event notification JSON", f.diag.message);
    try testing.expectError(error.Invalid, p.parseHeadNotification(a, "[]", &f.diag));
    try testing.expectEqualStrings("Invalid scraper head notification", f.diag.message);
}

test "parses confirmation frontier notifications" {
    var f = Fixture.init();
    defer f.deinit();
    const head = try p.parseHeadNotification(f.arena.allocator(),
        \\{"domain":42161,"confirmedHeight":"102","previousConfirmedHeight":"99","headHeight":"110","indexedHeight":"108","previousIndexedHeight":"107"}
    , &f.diag);
    try testing.expectEqualDeep(p.HeadNotification{
        .confirmed_height = 102,
        .domain = 42161,
        .previous_confirmed_height = 99,
        .head_height = 110,
        .indexed_height = 108,
        .indexed_hash = null,
        .previous_indexed_height = 107,
    }, head);
}

test "normalizes only valid signed database domain encodings" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    const valid = [_]struct { []const u8, u32 }{
        .{ "-2147483648", 0x8000_0000 },     .{ "-1", 0xffff_ffff },        .{ "0", 0 },
        .{ "2147483647", 0x7fff_ffff },      .{ "2147483648", 0x8000_0000 }, .{ "4294967295", 0xffff_ffff },
        .{ "\"-2147483648\"", 0x8000_0000 }, .{ "\"4294967295\"", 0xffff_ffff },
    };
    for (valid) |case| {
        const value = try core.json.parse(a, case[0], .{});
        try testing.expectEqual(case[1], try p.parseDatabaseDomain(value, "invalid domain", &f.diag));
    }
    for ([_][]const u8{ "-2147483649", "4294967296", "1.5", "\"\"", "\" 1\"", "\"0x1\"", "\"1e3\"", "\"1.5\"" }) |raw| {
        const value = try core.json.parse(a, raw, .{});
        try testing.expectError(error.Invalid, p.parseDatabaseDomain(value, "invalid domain", &f.diag));
        try testing.expectEqualStrings("invalid domain", f.diag.message);
    }
}

test "parses Explorer message notifications" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    try testing.expectEqualStrings("\\x" ++ "ab" ** 32, try p.parseExplorerNotification(a, "{\"messageId\":\"" ++ "AB" ** 32 ++ "\"}", &f.diag));
    try testing.expectError(error.Invalid, p.parseExplorerNotification(a, "{\"messageId\":\"ab\"}", &f.diag));
    try testing.expectEqualStrings("Invalid scraper Explorer notification", f.diag.message);
}

test "validates optional shared message-ID filters" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    const id = "ab" ** 32;
    try testing.expect((try p.parseExplorerMessageIds(a, &try f.params(""), &f.diag)) == null);
    try testing.expectEqual(@as(usize, 0), (try p.parseExplorerMessageIds(a, &try f.params("messageIds="), &f.diag)).?.len);
    const ids = (try p.parseExplorerMessageIds(a, &try f.params("messageIds=0x" ++ id ++ "," ++ "AB" ** 32), &f.diag)).?;
    try testing.expectEqual(@as(usize, 1), ids.len);
    try testing.expectEqualStrings("\\x" ++ id, ids[0]);
    try testing.expectError(error.Invalid, p.parseExplorerMessageIds(a, &try f.params("messageIds=bad"), &f.diag));
    try testing.expectEqualStrings("Expected a 32-byte message ID", f.diag.message);
    var many: std.ArrayList(u8) = .empty;
    try many.appendSlice(a, "messageIds=");
    for (0..51) |index| {
        if (index > 0) try many.append(a, ',');
        try many.appendSlice(a, id);
    }
    try testing.expectError(error.Invalid, p.parseExplorerMessageIds(a, &try f.params(many.items), &f.diag));
    try testing.expectEqualStrings("messageIds must contain at most 50 valid message IDs", f.diag.message);
    // `%5Cx` decodes to a `\x` prefix.
    const escaped = (try p.parseExplorerMessageIds(a, &try f.params("messageIds=%5Cx" ++ id), &f.diag)).?;
    try testing.expectEqualStrings("\\x" ++ id, escaped[0]);
}

test "validates zero-confirmation opt-in for every event type" {
    var f = Fixture.init();
    defer f.deinit();
    for (p.EventType.all) |event_type| {
        const raw = try std.fmt.allocPrint(f.arena.allocator(),
            \\{{"type":"subscribe","streams":[{{"eventType":"{s}","domains":[1],"includeZeroConfirmations":true}}]}}
        , .{event_type.name()});
        const streams = try f.subscribe(raw);
        try testing.expectEqual(@as(?bool, true), streams[0].include_zero_confirmations);
    }
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","domains":[1],"includeZeroConfirmations":2}]}
    , "includeZeroConfirmations must be a boolean");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","includeZeroConfirmations":true}]}
    , "includeZeroConfirmations requires explicit domains or cursors");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"blocks","domains":[1],"includeZeroConfirmations":true}]}
    , "blocks supports live heads only");
}

test "validates live-only confirmations on both endpoints" {
    var f = Fixture.init();
    defer f.deinit();
    _ = try f.subscribe(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":0,"domains":[1]}]}
    );
    for ([_][]const u8{ "-1", "0.1", "\"1\"", "null", "9007199254740992" }) |confirmations| {
        const raw = try std.fmt.allocPrint(f.arena.allocator(),
            \\{{"type":"subscribe","streams":[{{"eventType":"dispatch","confirmations":{s},"domains":[1]}}]}}
        , .{confirmations});
        try f.rejects(raw, "confirmations must be a non-negative safe integer");
    }
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":0}]}
    , "confirmations requires explicit domains");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":0,"domains":[1],"cursors":[{"domain":1,"address":"0x0101010101010101010101010101010101010101"}]}]}
    , "live streams only");
    const a = f.arena.allocator();
    const custom = (try p.parseExplorerConfirmations(a, &try f.params("confirmations=2&domains=1,2"), &f.diag)).?;
    try testing.expectEqual(@as(u64, 2), custom.confirmations);
    try testing.expectEqualSlices(u32, &.{ 1, 2 }, custom.domains);
    for ([_][]const u8{ "confirmations=0", "domains=1", "confirmations=-1&domains=1", "confirmations=0&domains=" }) |query| {
        try testing.expectError(error.Invalid, p.parseExplorerConfirmations(a, &try f.params(query), &f.diag));
        try testing.expectEqualStrings("Expected confirmations=N&domains=domain,...", f.diag.message);
    }
    try testing.expectError(error.Invalid, p.parseExplorerConfirmations(a, &try f.params("confirmations=1&domains=4294967296"), &f.diag));
    try testing.expectEqualStrings("Invalid domains", f.diag.message);
    try testing.expect((try p.parseExplorerConfirmations(a, &try f.params(""), &f.diag)) == null);
}

test "client message envelope errors" {
    var f = Fixture.init();
    defer f.deinit();
    try f.rejects("{", "Invalid JSON message");
    try f.rejects("[]", "Invalid client message");
    try f.rejects("null", "Invalid client message");
    try f.rejects("{\"type\":\"subscribe\"}", "Unsupported client message type");
    try f.rejects("{\"type\":\"subscribe\",\"streams\":[]}", "Subscribe to between 1 and 5 streams");
    try f.rejects("{\"type\":\"subscribe\",\"streams\":[1]}", "Invalid eventType");
    // JSON.parse keeps the last duplicate key.
    try testing.expect((try f.parse("{\"type\":\"subscribe\",\"type\":\"ping\"}")) == .ping);
    // Numbers follow JS semantics.
    const streams = try f.subscribe("{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1e3,1000.0,1]}]}");
    try testing.expectEqualSlices(u32, &.{ 1000, 1 }, streams[0].domains.?);
}

test "BigInt cursor values keep canonical text" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","cursors":[{"address":"0x0000000000000000000000000000000000000001","afterSequence":"000123456789012345678901234567890123456789012","domain":1},{"address":"0x0000000000000000000000000000000000000002","afterSequence":5,"domain":1}]}]}
    );
    const big = streams[0].cursors.?[0].after.?;
    try testing.expectEqualStrings("123456789012345678901234567890123456789012", big.text);
    try testing.expectEqual(@as(i128, std.math.maxInt(i128)), big.value);
    try testing.expectEqualStrings("5", streams[0].cursors.?[1].after.?.text);
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","cursors":[{"address":"0x0000000000000000000000000000000000000001","afterSequence":"-2","domain":1}]}]}
    , "afterSequence must be an integer string greater than or equal to -1");
}

test "node net.isIP vectors" {
    const cases = [_]struct { []const u8, bool }{
        .{ "1.2.3.4", true },              .{ "01.2.3.4", false },             .{ "255.255.255.255", true },
        .{ "256.1.1.1", false },           .{ "::", true },                    .{ "::1", true },
        .{ "1::", true },                  .{ "1:2:3:4:5:6:7::", true },       .{ "1:2:3:4:5:6:7:8", true },
        .{ "1:2:3:4:5:6:7:8:9", false },   .{ "::ffff:1.2.3.4", true },        .{ "1:2:3:4:5:6:1.2.3.4", true },
        .{ "1:2:3:4:5:6:7:1.2.3.4", false }, .{ "fe80::1%eth0", true },        .{ "fe80::1%", false },
        .{ "1::2::3", false },             .{ ":1:2:3:4:5:6:7", false },       .{ "12345::", false },
        .{ "::1.2.3.4", true },            .{ "1:2:3:4:5::1.2.3.4", true },    .{ "1.2.3.04", false },
        .{ "", false },                    .{ " 1.2.3.4", false },             .{ "1.2.3.4 ", false },
        .{ "FE80::A", true },              .{ "fe80::1%a.b-c:d", true },       .{ "1:2:3:4:5:6:7::8", false },
        .{ "::1:2:3:4:5:6:7", true },      .{ "::1:2:3:4:5:6:7:8", false },    .{ "1.2.3", false },
        .{ "0.0.0.0", true },              .{ "1:2:3:4:5:6::1.2.3.4", false },
    };
    for (cases) |case| {
        if (p.isIp(case[0]) != case[1]) {
            std.debug.print("isIp({s}) expected {}\n", .{ case[0], case[1] });
            return error.TestUnexpectedResult;
        }
    }
}

test "URLSearchParams decoding" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    const params = try p.QueryParams.fromUrl(a, "/messages?a=1&a=2&b=x+y%20z&c&d=%zz&e=%E2%82%AC&f=%FF#frag=1");
    try testing.expectEqualStrings("1", params.get("a").?);
    try testing.expectEqualStrings("x y z", params.get("b").?);
    try testing.expectEqualStrings("", params.get("c").?);
    try testing.expectEqualStrings("%zz", params.get("d").?);
    try testing.expectEqualStrings("\u{20AC}", params.get("e").?);
    try testing.expectEqualStrings("\u{FFFD}", params.get("f").?);
    try testing.expect(params.get("frag") == null);
    try testing.expectEqual(@as(usize, 0), (try p.QueryParams.fromUrl(a, "/messages")).entries.len);
}

test "UTF-8 lossy decoding" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    try testing.expectEqualStrings("ok", try p.utf8Lossy(a, "ok"));
    try testing.expectEqualStrings("a\u{FFFD}b", try p.utf8Lossy(a, "a\xffb"));
    try testing.expectEqualStrings("\u{FFFD}\u{FFFD}", try p.utf8Lossy(a, "\xed\xa0\x80"[0..2]));
    try testing.expectEqualStrings("\u{FFFD}x", try p.utf8Lossy(a, "\xe2\x82x"));
}
