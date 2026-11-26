//! `message-facts.ts` (TS #10078): grouping, per-ID isolation, byte counts and
//! projection.
const std = @import("std");
const core = @import("core");
const mf = @import("message_facts.zig");

const json = core.json;
const Value = json.Value;
const testing = std.testing;

/// A node-pg-shaped facts row, columns in the facts query's order (a subset of
/// MESSAGE_COLUMNS is enough: projection only reads keys).
fn row(a: std.mem.Allocator, id: []const u8, delivery: ?struct { domain: []const u8, height: ?[]const u8, tx: []const u8 }, buckets: ?[]const u8) !Value {
    var text: std.ArrayList(u8) = .empty;
    try text.print(a,
        \\{{"delivery_domain":{s},"delivery_height":{s},"payment_buckets":{s},"message_body":"\\x00",
        \\"id":"7","msg_id":"{s}","nonce":3,"is_delivered":{s},"origin_domain_id":1,"destination_domain_id":"-2",
        \\"delivery_occurred_at":{s},"origin_block_height":"100","destination_tx_hash":{s},"destination_block_height":{s}}}
    , .{
        if (delivery) |d| d.domain else "null",
        if (delivery) |d| (if (d.height) |h| try std.fmt.allocPrint(a, "\"{s}\"", .{h}) else "null") else "null",
        buckets orelse "null",
        try escape(a, id),
        if (delivery != null) "true" else "false",
        if (delivery != null) "\"2026-01-01 00:00:00\"" else "null",
        if (delivery) |d| try std.fmt.allocPrint(a, "\"{s}\"", .{try escape(a, d.tx)}) else "null",
        if (delivery) |d| (if (d.height) |h| try std.fmt.allocPrint(a, "\"{s}\"", .{h}) else "null") else "null",
    });
    return json.parse(a, text.items, .{});
}

/// JSON string escaping for the backslash in node-pg bytea text.
fn escape(a: std.mem.Allocator, text: []const u8) ![]const u8 {
    return std.mem.replaceOwned(u8, a, text, "\\", "\\\\");
}

const Heights = struct {
    map: []const struct { domain: u32, height: i128 },

    fn get(ctx: *const anyopaque, domain: u32) ?i128 {
        const self: *const Heights = @ptrCast(@alignCast(ctx));
        for (self.map) |entry| if (entry.domain == domain) return entry.height;
        return null;
    }

    fn frontier(self: *const Heights) mf.Frontier {
        return .{ .ctx = self, .get = get };
    }
};

fn stringify(a: std.mem.Allocator, value: Value) ![]u8 {
    return json.stringifyAlloc(a, value);
}

test "facts: one message per id, pending row and exact byte counts" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const buckets =
        \\[{"domain":1,"height":"100","count":"2","payment":"999999999999999999999","gas":"5"},  {"domain":2,
        \\ "height":null,"count":"1","payment":"1","gas":"1"}]
    ;
    const rows = [_]Value{
        try row(a, "\\xaa", .{ .domain = "2", .height = "50", .tx = "\\x01" }, buckets),
        // TS #10082: a legacy duplicate row repeating a delivery is ignored.
        try row(a, "\\xaa", .{ .domain = "3", .height = null, .tx = "\\x02" }, null),
        try row(a, "\\xbb", null, null),
    };
    var collected = try mf.collect(testing.allocator, &rows);
    defer collected.deinit();
    try testing.expectEqual(@as(usize, 2), collected.outcomes.count());
    try testing.expectEqualStrings("\\xaa", collected.outcomes.keys()[0]);
    try testing.expectEqualStrings("\\xbb", collected.outcomes.keys()[1]);
    const facts = collected.get("\\xaa").?.facts;
    try testing.expectEqual(@as(u32, 1), facts.origin);
    try testing.expectEqual(@as(u32, 4294967294), facts.destination);
    try testing.expectEqual(@as(i128, 100), facts.height);
    try testing.expectEqualSlices(u32, &.{ 1, 4294967294, 2 }, facts.dependencies.items);
    try testing.expectEqual(@as(u32, 2), facts.delivery.?.domain);
    try testing.expectEqual(@as(?i128, 50), facts.delivery.?.height);
    try testing.expectEqual(@as(usize, 2), facts.payments.len);
    try testing.expectEqualStrings("999999999999999999999", facts.payments[0].payment);
    // `{...data, origin/destination numbers, is_delivered: false}`, delivery columns null.
    const pending = try stringify(a, .{ .object = facts.pending });
    try testing.expectEqualStrings(
        \\{"message_body":"\\x00","id":"7","msg_id":"\\xaa","nonce":3,"is_delivered":false,"origin_domain_id":1,"destination_domain_id":4294967294,"delivery_occurred_at":null,"origin_block_height":"100","destination_tx_hash":null,"destination_block_height":null}
    , pending);
    // JSON.stringify(pending) + JSON.stringify(buckets) (compact) + the delivery's fields.
    const compact_buckets =
        \\[{"domain":1,"height":"100","count":"2","payment":"999999999999999999999","gas":"5"},{"domain":2,"height":null,"count":"1","payment":"1","gas":"1"}]
    ;
    const fields =
        \\{"delivery_occurred_at":"2026-01-01 00:00:00","destination_tx_hash":"\\x01","destination_block_height":"50"}
    ;
    try testing.expectEqual(pending.len + compact_buckets.len + fields.len, facts.bytes);
    const plain = collected.get("\\xbb").?.facts;
    try testing.expectEqual(jsonLen(a, plain.pending) + "null".len, plain.bytes);
}

fn jsonLen(a: std.mem.Allocator, members: []json.Member) usize {
    return (stringify(a, .{ .object = members }) catch unreachable).len;
}

test "facts: an invalid message fails only its own id" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var bad = try row(a, "\\xaa", null, null);
    bad.getPtr("origin_domain_id").?.* = .{ .string = "x" };
    const rows = [_]Value{
        bad,
        try row(a, "\\xbb", null, null),
        try row(a, "\\xcc", .{ .domain = "\"y\"", .height = "1", .tx = "\\x01" }, null),
        try row(a, "\\xdd", null, "[{\"domain\":1,\"height\":\"1\",\"count\":\"-1\",\"payment\":\"0\",\"gas\":\"0\"}]"),
    };
    var collected = try mf.collect(testing.allocator, &rows);
    defer collected.deinit();
    try testing.expectEqualStrings("Invalid origin domain", collected.get("\\xaa").?.failure);
    try testing.expect(collected.get("\\xbb").? == .facts);
    try testing.expectEqualStrings("Invalid delivery domain", collected.get("\\xcc").?.failure);
    try testing.expectEqualStrings("id must be a non-negative integer string", collected.get("\\xdd").?.failure);
}

fn heightOf(projection: mf.Projection, domain: u32) ?i128 {
    return projection.heights.get(domain);
}

test "facts: projection follows the subscriber's frontiers and records visible heights" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const buckets =
        \\[{"domain":1,"height":"100","count":"2","payment":"10","gas":"5"},
        \\ {"domain":1,"height":"120","count":"1","payment":"7","gas":"1"},
        \\ {"domain":3,"height":null,"count":"1","payment":"1","gas":"1"}]
    ;
    const rows = [_]Value{try row(a, "\\xaa", .{ .domain = "2", .height = "60", .tx = "\\x02" }, buckets)};
    var collected = try mf.collect(testing.allocator, &rows);
    defer collected.deinit();
    const facts = collected.get("\\xaa").?.facts;

    // Origin not visible: no projection.
    const hidden: Heights = .{ .map = &.{.{ .domain = 1, .height = 99 }} };
    try testing.expect((try mf.project(a, facts, hidden.frontier())) == null);

    // Delivery at 60 not visible; payments through 110 plus the NULL bucket.
    const middle: Heights = .{ .map = &.{ .{ .domain = 1, .height = 110 }, .{ .domain = 2, .height = 55 } } };
    const projected = (try mf.project(a, facts, middle.frontier())).?;
    try testing.expectEqualStrings(
        \\{"message_body":"\\x00","id":"7","msg_id":"\\xaa","nonce":3,"is_delivered":false,"origin_domain_id":1,"destination_domain_id":4294967294,"delivery_occurred_at":null,"origin_block_height":"100","destination_tx_hash":null,"destination_block_height":null,"num_payments":"3","total_payment":"11","total_gas_amount":"6"}
    , try stringify(a, projected.data));
    // The origin (100) and every payment height on domain 1, the hidden 120
    // included (TS #10085); the hidden delivery is not recorded.
    try testing.expectEqual(@as(usize, 1), projected.heights.count());
    try testing.expectEqual(@as(?i128, 120), heightOf(projected, 1));

    // No frontier anywhere: everything visible.
    const open: Heights = .{ .map = &.{} };
    const all = (try mf.project(a, facts, open.frontier())).?;
    try testing.expectEqualStrings("\\x02", all.data.get("destination_tx_hash").?.string);
    try testing.expectEqualStrings("4", all.data.get("num_payments").?.string);
    try testing.expectEqualStrings("18", all.data.get("total_payment").?.string);
    try testing.expectEqual(@as(?i128, 120), heightOf(all, 1));
    try testing.expectEqual(@as(?i128, 60), heightOf(all, 2));
}

test "facts: every payment height is recorded, visible or not (TS #10085)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const buckets =
        \\[{"domain":2,"height":"1","count":"1","payment":"1","gas":"1"},{"domain":2,"height":"17","count":"1","payment":"1","gas":"1"}]
    ;
    const rows = [_]Value{try row(a, "\\xaa", null, buckets)};
    var collected = try mf.collect(testing.allocator, &rows);
    defer collected.deinit();
    const facts = collected.get("\\xaa").?.facts;
    const frontier: Heights = .{ .map = &.{.{ .domain = 2, .height = 3 }} };
    const projected = (try mf.project(a, facts, frontier.frontier())).?;
    try testing.expectEqualStrings("1", projected.data.get("num_payments").?.string);
    try testing.expectEqual(@as(?i128, 17), heightOf(projected, 2));
}

test "facts: payment totals past 2^128 are exact decimal strings (BigInt)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // numeric(78,0) sums: 2^128 twice, and 2^128 + 1 plus 2^128 (TS `String(sum)`).
    const buckets =
        \\[{"domain":1,"height":null,"count":"1","payment":"340282366920938463463374607431768211456","gas":"340282366920938463463374607431768211457"},
        \\ {"domain":2,"height":null,"count":"0001","payment":"340282366920938463463374607431768211456","gas":"340282366920938463463374607431768211456"}]
    ;
    const rows = [_]Value{try row(a, "\\xaa", null, buckets)};
    var collected = try mf.collect(testing.allocator, &rows);
    defer collected.deinit();
    const open: Heights = .{ .map = &.{} };
    const projected = (try mf.project(a, collected.get("\\xaa").?.facts, open.frontier())).?;
    try testing.expectEqualStrings("2", projected.data.get("num_payments").?.string);
    try testing.expectEqualStrings("680564733841876926926749214863536422912", projected.data.get("total_payment").?.string);
    try testing.expectEqualStrings("680564733841876926926749214863536422913", projected.data.get("total_gas_amount").?.string);
    const json_text = try stringify(a, projected.data);
    try testing.expect(std.mem.indexOf(u8, json_text, "\"total_payment\":\"680564733841876926926749214863536422912\"") != null);
}
