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
        return message.subscribe.streams;
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

test "accepts live gas payment subscriptions" {
    var f = Fixture.init();
    defer f.deinit();
    const streams = try f.subscribe(
        \\{"streams":[{"domains":[1],"eventType":"gas_payment"}],"type":"subscribe"}
    );
    try testing.expectEqualSlices(u32, &.{1}, streams[0].domains.?);
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
        .{ "-2147483648", 0x8000_0000 },     .{ "-1", 0xffff_ffff },             .{ "0", 0 },
        .{ "2147483647", 0x7fff_ffff },      .{ "2147483648", 0x8000_0000 },     .{ "4294967295", 0xffff_ffff },
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
    , "includeZeroConfirmations requires explicit domains");
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

/// "confirmations=N&domains=1,…,count" (domains 1..count).
fn budgetQuery(a: std.mem.Allocator, confirmations: u64, count: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.print(a, "confirmations={d}&domains=", .{confirmations});
    for (1..count + 1) |domain| try out.print(a, "{s}{d}", .{ if (domain > 1) "," else "", domain });
    return out.items;
}

test "explorer domain confirmation budget (TS #10078)" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    // `domains.size * Math.max(1, confirmations) > 10_000`; zero counts as one.
    for ([_]struct { confirmations: u64, domains: usize }{ .{ .confirmations = 20, .domains = 500 }, .{ .confirmations = 0, .domains = 512 }, .{ .confirmations = 1000, .domains = 10 } }) |ok|
        _ = (try p.parseExplorerConfirmations(a, &try f.params(try budgetQuery(a, ok.confirmations, ok.domains)), &f.diag)).?;
    for ([_]struct { confirmations: u64, domains: usize }{ .{ .confirmations = 20, .domains = 501 }, .{ .confirmations = 20, .domains = 512 }, .{ .confirmations = 1000, .domains = 11 } }) |bad| {
        try testing.expectError(error.Invalid, p.parseExplorerConfirmations(a, &try f.params(try budgetQuery(a, bad.confirmations, bad.domains)), &f.diag));
        try testing.expectEqualStrings("Subscription exceeds 10000 domain confirmation blocks", f.diag.message);
    }
    // The 1000-confirmation cap is checked first.
    try testing.expectError(error.Invalid, p.parseExplorerConfirmations(a, &try f.params(try budgetQuery(a, 1001, 20)), &f.diag));
    try testing.expectEqualStrings("confirmations must not exceed 1000", f.diag.message);
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

test "rejects replay options for every agent event stream" {
    var f = Fixture.init();
    defer f.deinit();
    const message = "Agent streams are live-only; replay cursors are unsupported. Recover history through RPC.";
    for (p.SUBSCRIPTION_TYPES) |event_type| {
        for ([_][]const u8{
            \\"cursors":[{"domain":1,"address":"0x0101010101010101010101010101010101010101","afterSequence":"-1"}]
            ,
            \\"cursors":[]
            ,
            \\"cursors":null
            ,
            \\"streamCursorVersion":3
            ,
            \\"afterId":"1"
            ,
            \\"afterSequence":"1"
            ,
            \\"afterStreamCursor":"1"
            ,
            \\"allowReplay":false
            ,
        }) |replay| {
            const raw = try std.fmt.allocPrint(f.arena.allocator(),
                \\{{"type":"subscribe","streams":[{{"eventType":"{s}","domains":[1],{s}}}]}}
            , .{ event_type, replay });
            try f.rejects(raw, message);
            try testing.expectEqualStrings(message, f.diag.message);
        }
    }
    // Checked before the domains and the blocks options.
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"blocks","domains":[],"confirmations":1,"allowReplay":true}]}
    , message);
    // Domains are now validated before the blocks options.
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"blocks","domains":[],"confirmations":1}]}
    , "domains must contain valid domain IDs");
    try f.rejects(
        \\{"type":"subscribe","streams":[{"eventType":"blocks","confirmations":1}]}
    , "blocks supports live heads only, without confirmations");
}

test "node net.isIP vectors" {
    const cases = [_]struct { []const u8, bool }{
        .{ "1.2.3.4", true },                .{ "01.2.3.4", false },             .{ "255.255.255.255", true },
        .{ "256.1.1.1", false },             .{ "::", true },                    .{ "::1", true },
        .{ "1::", true },                    .{ "1:2:3:4:5:6:7::", true },       .{ "1:2:3:4:5:6:7:8", true },
        .{ "1:2:3:4:5:6:7:8:9", false },     .{ "::ffff:1.2.3.4", true },        .{ "1:2:3:4:5:6:1.2.3.4", true },
        .{ "1:2:3:4:5:6:7:1.2.3.4", false }, .{ "fe80::1%eth0", true },          .{ "fe80::1%", false },
        .{ "1::2::3", false },               .{ ":1:2:3:4:5:6:7", false },       .{ "12345::", false },
        .{ "::1.2.3.4", true },              .{ "1:2:3:4:5::1.2.3.4", true },    .{ "1.2.3.04", false },
        .{ "", false },                      .{ " 1.2.3.4", false },             .{ "1.2.3.4 ", false },
        .{ "FE80::A", true },                .{ "fe80::1%a.b-c:d", true },       .{ "1:2:3:4:5:6:7::8", false },
        .{ "::1:2:3:4:5:6:7", true },        .{ "::1:2:3:4:5:6:7:8", false },    .{ "1.2.3", false },
        .{ "0.0.0.0", true },                .{ "1:2:3:4:5:6::1.2.3.4", false },
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

/// `{"…": <value>}` messages where `<value>` is nested `depth` levels deep.
fn deep(a: std.mem.Allocator, prefix: []const u8, depth: usize, open: u8, close: u8, leaf: []const u8, suffix: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, prefix);
    try out.appendNTimes(a, open, depth);
    try out.appendSlice(a, leaf);
    try out.appendNTimes(a, close, depth);
    try out.appendSlice(a, suffix);
    return out.items;
}

/// Outcome of a client message as text (pong / subscribe count / error).
fn outcome(raw: []const u8) ![]const u8 {
    var f = Fixture.init();
    defer f.deinit();
    const message = f.parse(raw) catch |err| {
        if (err != error.Invalid) return err;
        return testing.allocator.dupe(u8, f.diag.message);
    };
    return testing.allocator.dupe(u8, switch (message) {
        .ping => "ping",
        .subscribe => "subscribe",
    });
}

test "deeply nested client messages are handled like their shallow equivalents (JSON.parse has no depth limit)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Close to /agents maxPayload (64 KiB): ~32k levels.
    const depth = 32_000;
    const cases = [_]struct { deep: []const u8, shallow: []const u8 }{
        .{ .deep = try deep(a, "", depth, '[', ']', "1", ""), .shallow = "[1]" },
        .{ .deep = try deep(a, "{\"type\":\"ping\",\"x\":", depth, '[', ']', "", "}"), .shallow = "{\"type\":\"ping\",\"x\":[]}" },
        .{ .deep = try deep(a, "{\"type\":\"subscribe\",\"streams\":[", depth, '[', ']', "", "]}"), .shallow = "{\"type\":\"subscribe\",\"streams\":[[]]}" },
        .{ .deep = try deep(a, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":", depth, '[', ']', "1", "}]}"), .shallow = "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[[1]]}]}" },
        .{ .deep = try deep(a, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"cursors\":", depth, '[', ']', "", "}]}"), .shallow = "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"cursors\":[[]]}]}" },
        .{ .deep = try deep(a, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1],\"extra\":", depth / 2, '{', '}', "", "}]}"), .shallow = "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1],\"extra\":{}}]}" },
    };
    for (cases) |case| {
        // Nested objects: rebuild with keys so the JSON is valid.
        const deep_raw = if (std.mem.indexOf(u8, case.deep, "\"extra\":{{") != null) blk: {
            var out: std.ArrayList(u8) = .empty;
            try out.appendSlice(a, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1],\"extra\":");
            for (0..depth / 2) |_| try out.appendSlice(a, "{\"a\":");
            try out.appendSlice(a, "1");
            try out.appendNTimes(a, '}', depth / 2);
            try out.appendSlice(a, "}]}");
            break :blk out.items;
        } else case.deep;
        const got = try outcome(deep_raw);
        defer testing.allocator.free(got);
        const want = try outcome(case.shallow);
        defer testing.allocator.free(want);
        try testing.expectEqualStrings(want, got);
    }
}

// ---------------------------------------------------------------------------
// `domain-confirmations.test.ts`

fn groupsOf(a: std.mem.Allocator, message: p.ClientMessage, index: usize) ![]const p.StreamRequest {
    return p.splitConfirmationStreams(a, message.subscribe.streams[index], message.subscribe.confirmations_by_domain);
}

test "domain overrides take precedence for every event type, including zero" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    for ([_][]const u8{ "dispatch", "delivery", "gas_payment", "merkle_tree_insertion" }) |event_type| {
        for ([_]?u64{ null, 12 }) |confirmations| {
            const extra = if (confirmations) |c| try std.fmt.allocPrint(a, ",\"confirmations\":{d}", .{c}) else "";
            const raw = try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\",\"confirmationsByDomain\":{{\"1\":0,\"2\":3,\"5\":3}},\"streams\":[{{\"eventType\":\"{s}\",\"domains\":[1,2,3,4,5]{s}}}]}}", .{ event_type, extra });
            const message = try f.parse(raw);
            const groups = try groupsOf(a, message, 0);
            try testing.expectEqual(@as(usize, 3), groups.len);
            try testing.expectEqual(@as(?u64, 0), groups[0].confirmations);
            try testing.expectEqualSlices(u32, &.{1}, groups[0].domains.?);
            try testing.expectEqual(@as(?u64, 3), groups[1].confirmations);
            try testing.expectEqualSlices(u32, &.{ 2, 5 }, groups[1].domains.?);
            try testing.expectEqual(confirmations, groups[2].confirmations);
            try testing.expectEqualSlices(u32, &.{ 3, 4 }, groups[2].domains.?);
            try testing.expectEqualSlices(u32, &.{ 1, 2, 3, 4, 5 }, message.subscribe.streams[0].domains.?);
            for (groups) |group| try testing.expectEqual(message.subscribe.streams[0].kind, group.kind);
        }
    }
}

test "omitted or empty domain overrides retain legacy subscriptions" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    for ([_][]const u8{ "", ",\"confirmationsByDomain\":{}" }) |map| {
        for ([_][]const u8{ "{\"eventType\":\"dispatch\"}", "{\"eventType\":\"dispatch\",\"domains\":[1],\"confirmations\":2}" }) |stream| {
            const message = try f.parse(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\"{s},\"streams\":[{s}]}}", .{ map, stream }));
            try testing.expectEqual(map.len > 0, message.subscribe.confirmations_by_domain != null);
            const groups = try groupsOf(a, message, 0);
            try testing.expectEqual(@as(usize, 1), groups.len);
            try testing.expectEqual(message.subscribe.streams[0].confirmations, groups[0].confirmations);
            try testing.expectEqual(message.subscribe.streams[0].domains, groups[0].domains);
        }
    }
}

test "merges domain overrides with matching legacy confirmations" {
    var f = Fixture.init();
    defer f.deinit();
    const message = try f.parse("{\"type\":\"subscribe\",\"confirmationsByDomain\":{\"1\":3,\"3\":0},\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2,3],\"confirmations\":3}]}");
    const groups = try groupsOf(f.arena.allocator(), message, 0);
    try testing.expectEqual(@as(usize, 2), groups.len);
    try testing.expectEqual(@as(?u64, 3), groups[0].confirmations);
    try testing.expectEqualSlices(u32, &.{ 1, 2 }, groups[0].domains.?);
    try testing.expectEqual(@as(?u64, 0), groups[1].confirmations);
    try testing.expectEqualSlices(u32, &.{3}, groups[1].domains.?);
}

test "supports the full uint32 domain range, Object.entries order, and leaves block streams unchanged" {
    var f = Fixture.init();
    defer f.deinit();
    const message = try f.parse("{\"type\":\"subscribe\",\"confirmationsByDomain\":{\"4294967295\":5,\"7\":1,\"0\":0},\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[0,4294967295,7]},{\"eventType\":\"blocks\"}]}");
    const entries = message.subscribe.confirmations_by_domain.?;
    try testing.expectEqual(@as(usize, 3), entries.len);
    try testing.expectEqual(p.DomainConfirmations{ .domain = 0, .confirmations = 0 }, entries[0]);
    try testing.expectEqual(p.DomainConfirmations{ .domain = 7, .confirmations = 1 }, entries[1]);
    try testing.expectEqual(p.DomainConfirmations{ .domain = 4294967295, .confirmations = 5 }, entries[2]);
    try testing.expectEqual(@as(?[]const u32, null), message.subscribe.streams[1].domains);
}

test "rejects malformed domain maps and confirmation values" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    for ([_][]const u8{ "null", "[]", "1", "\"1\"" }) |value| {
        try f.rejects(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\",\"confirmationsByDomain\":{s},\"streams\":[{{\"eventType\":\"dispatch\",\"domains\":[1]}}]}}", .{value}), "confirmationsByDomain must be a domain-to-confirmations object");
    }
    for ([_][]const u8{ "-1", "4294967296", "01", "1.5", "1e3", "", "__proto__", "-0", " 1" }) |key| {
        try f.rejects(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\",\"confirmationsByDomain\":{{\"{s}\":2}},\"streams\":[{{\"eventType\":\"dispatch\",\"domains\":[1]}}]}}", .{key}), "confirmationsByDomain keys must be uint32 domain IDs");
    }
    for ([_][]const u8{ "null", "-1", "1.5", "\"2\"", "9007199254740992" }) |value| {
        try f.rejects(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\",\"confirmationsByDomain\":{{\"1\":{s}}},\"streams\":[{{\"eventType\":\"dispatch\",\"domains\":[1]}}]}}", .{value}), "confirmations must be a non-negative safe integer");
    }
    // Index keys are checked first: the count error wins over a later bad key.
    try f.rejects("{\"type\":\"subscribe\",\"confirmationsByDomain\":{\"x\":1,\"5\":-1},\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[5]}]}", "confirmations must be a non-negative safe integer");
    // -0 is a non-negative safe integer.
    const zero = try f.parse("{\"type\":\"subscribe\",\"confirmationsByDomain\":{\"1\":-0},\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    try testing.expectEqual(@as(u64, 0), zero.subscribe.confirmations_by_domain.?[0].confirmations);
}

test "requires explicit domains and rejects replay regardless of domain overrides" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    for ([_][]const u8{
        "{\"eventType\":\"dispatch\",\"domains\":[1]}",
        "{\"eventType\":\"blocks\",\"domains\":[2]}",
        "{\"eventType\":\"dispatch\",\"domains\":[1]},{\"eventType\":\"blocks\",\"domains\":[2]}",
    }) |streams| {
        try f.rejects(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\",\"confirmationsByDomain\":{{\"2\":0}},\"streams\":[{s}]}}", .{streams}), "Unused confirmationsByDomain domain 2");
    }
    try f.rejects("{\"type\":\"subscribe\",\"confirmationsByDomain\":{\"1\":2},\"streams\":[{\"eventType\":\"dispatch\"}]}", "confirmationsByDomain requires explicit event stream domains");
    for ([_][]const u8{ "", ",\"confirmationsByDomain\":{}", ",\"confirmationsByDomain\":{\"1\":0}", ",\"confirmationsByDomain\":{\"2\":0}" }) |map| {
        try f.rejects(try std.fmt.allocPrint(a, "{{\"type\":\"subscribe\"{s},\"streams\":[{{\"eventType\":\"dispatch\",\"domains\":[1],\"cursors\":[]}}]}}", .{map}), "live-only");
    }
    // Stream errors come before map errors.
    try f.rejects("{\"type\":\"subscribe\",\"confirmationsByDomain\":null,\"streams\":[{\"eventType\":\"dispatch\"},{\"eventType\":\"dispatch\"}]}", "Duplicate eventType subscription");
}

// ---------------------------------------------------------------------------
// `validator-protocol.test.ts`

test "requires one domain and preserves canonical or explicit confirmations" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    for ([_]u32{ 0, 1, 4294967295 }) |domain| {
        const params = try f.params(try std.fmt.allocPrint(a, "domain={d}", .{domain}));
        try testing.expectEqual(p.ValidatorSubscription{ .domain = domain }, p.parseValidatorSubscription(&params).?);
        for ([_]u64{ 0, 2, 9007199254740991 }) |confirmations| {
            const with = try f.params(try std.fmt.allocPrint(a, "domain={d}&confirmations={d}", .{ domain, confirmations }));
            try testing.expectEqual(p.ValidatorSubscription{ .domain = domain, .confirmations = confirmations }, p.parseValidatorSubscription(&with).?);
        }
    }
    const padded = try f.params("domain=0001&confirmations=007&");
    try testing.expectEqual(p.ValidatorSubscription{ .domain = 1, .confirmations = 7 }, p.parseValidatorSubscription(&padded).?);
}

test "rejects ambiguous domains, unsafe counts and extra validator options" {
    var f = Fixture.init();
    defer f.deinit();
    for ([_][]const u8{
        "",                                  "domain=",                                  "domain=-1",
        "domain=4294967296",                 "domain=1,2",                               "domain=1&domain=2",
        "domain=1&domain=1",                 "domain=1.5",                               "domain=1e2",
        "domains=1",                         "domain=1&confirmations=",                  "domain=1&confirmations=-1",
        "domain=1&confirmations=1.5",        "domain=1&confirmations=NaN",               "domain=1&confirmations=9007199254740992",
        "domain=1&confirmations=safe",       "domain=1&confirmations=0&confirmations=0", "domain=1&blocks=true",
        "domain=1&eventType=dispatch",       "domain=1&includeZeroConfirmations=true",   "domain=1&afterSequence=0",
        "domain=1&confirmationsByDomain={}", "domain=1&%64omain=2",                      "domain",
        "=1&domain=1",                       "domain=+1",
    }) |query| {
        const params = try f.params(query);
        if (p.parseValidatorSubscription(&params)) |accepted| {
            std.debug.print("accepted {s}: {any}\n", .{ query, accepted });
            return error.TestUnexpectedResult;
        }
    }
}

test "accepts only ping after URL negotiation" {
    var f = Fixture.init();
    defer f.deinit();
    const a = f.arena.allocator();
    try testing.expect(p.isValidatorPing(try core.json.parse(a, "{ \"type\": \"ping\" }", .{})));
    try testing.expect(p.isValidatorPing(try core.json.parse(a, "{\"type\":\"x\",\"type\":\"ping\"}", .{})));
    for ([_][]const u8{ "null", "[]", "1", "{}", "{\"type\":\"subscribe\",\"streams\":[]}", "{\"type\":\"ping\",\"domain\":2}" }) |raw| {
        try testing.expect(!p.isValidatorPing(try core.json.parse(a, raw, .{})));
    }
}
