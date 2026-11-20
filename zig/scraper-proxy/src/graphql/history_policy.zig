//! `history-policy.ts` `validateHistoryRequest`: which public history reads
//! (message_view, message_view_aggregate) are allowed, checked on the coerced
//! arguments before any database access. Only unconditional conjuncts
//! establish a bound; an `_or` branch cannot widen it.
const std = @import("std");
const json = @import("core").json;

const Value = json.Value;

pub const too_deep = "History filter is nested too deeply";
pub const too_many = "Too many history predicates";
pub const null_send_time = "Only non-null send times may be requested";
pub const aggregate_unidentified = "History aggregates require an exact message or transaction identifier";
pub const confirmations_unbounded = "Custom confirmations require a message or transaction identifier, or a zero-confirmation provisional feed";
pub const delivery_filter = "Delivery status filters require a provisional-only feed";
pub const ordering = "Use ID ordering for history, nonce for an identifier, or send time for a provisional-only feed";

const identifier_keys = [_][]const u8{ "id", "msg_id", "origin_tx_hash", "destination_tx_hash" };

/// The first failed assertion's message, or null when the request is allowed.
pub fn check(args: Value, aggregate: bool) ?[]const u8 {
    var state: State = .{};
    state.visit(args.get("where"), true, 0) catch return state.failure;
    const confirmations = args.get("confirmations");
    // `args.confirmations === 0` (an Int argument: a JS number).
    const overlay = confirmations != null and isZero(confirmations.?) and state.provisional;
    if (aggregate and !state.identified) return aggregate_unidentified;
    if (!isNullish(confirmations) and !state.identified and !overlay) return confirmations_unbounded;
    if (state.filters_delivery and !overlay) return delivery_filter;
    // `Array.isArray(args.order_by) ? args.order_by : [args.order_by]`.
    const order_by = args.get("order_by");
    const orders: []const Value = if (order_by) |o| (if (o == .array) o.array else @as([]const Value, &.{o})) else &.{};
    for (orders) |order| {
        if (!truthy(order) or order != .object) continue;
        for (order.object) |member| {
            if (!truthy(member.value) or std.mem.eql(u8, member.key, "id")) continue;
            const allowed = (std.mem.eql(u8, member.key, "nonce") and state.identified) or
                (std.mem.eql(u8, member.key, "send_occurred_at") and overlay);
            if (!allowed) return ordering;
        }
    }
    return null;
}

const State = struct {
    identified: bool = false,
    provisional: bool = false,
    filters_delivery: bool = false,
    predicates: usize = 0,
    failure: []const u8 = "",

    fn fail(self: *State, message: []const u8) error{Rejected} {
        self.failure = message;
        return error.Rejected;
    }

    fn visit(self: *State, where: ?Value, required: bool, depth: usize) error{Rejected}!void {
        const object = record(where) orelse return;
        if (depth > 8) return self.fail(too_deep);
        for (object) |member| {
            self.predicates += 1;
            if (self.predicates > 100) return self.fail(too_many);
            const key = member.key;
            if (std.mem.eql(u8, key, "_and") or std.mem.eql(u8, key, "_or")) {
                if (member.value == .array) {
                    if (member.value.array.len > 100) return self.fail(too_many);
                    const and_ = std.mem.eql(u8, key, "_and");
                    for (member.value.array) |child| try self.visit(child, required and and_, depth + 1);
                }
                continue;
            }
            const value = member.value;
            if (record(value) == null) continue;
            if (required and isIdentifierKey(key) and !self.identified) self.identified = identifies(value);
            if (std.mem.eql(u8, key, "is_provisional") and required and isTrue(value.get("_eq"))) self.provisional = true;
            if (std.mem.eql(u8, key, "is_delivered") and !isNullish(value.get("_eq"))) self.filters_delivery = true;
            if (std.mem.eql(u8, key, "send_occurred_at") and isTrue(value.get("_is_null"))) return self.fail(null_send_time);
        }
    }
};

/// `typeof value._eq === 'string' || typeof value._eq === 'number' ||
/// (Array.isArray(value._in) && value._in.length > 0 && value._in.every(isString))`.
fn identifies(comparison: Value) bool {
    if (comparison.get("_eq")) |eq| if (isJsString(eq) or isJsNumber(eq)) return true;
    const in = comparison.get("_in") orelse return false;
    if (in != .array or in.array.len == 0) return false;
    for (in.array) |id| if (!isJsString(id)) return false;
    return true;
}

fn isIdentifierKey(key: []const u8) bool {
    for (identifier_keys) |k| if (std.mem.eql(u8, k, key)) return true;
    return false;
}

/// `value != null && typeof value === 'object' && !Array.isArray(value)`.
fn record(value: ?Value) ?[]const json.Member {
    const v = value orelse return null;
    return if (v == .object) v.object else null;
}

fn isNullish(value: ?Value) bool {
    return value == null or value.? == .null;
}

fn isTrue(value: ?Value) bool {
    const v = value orelse return false;
    return v == .bool and v.bool;
}

fn isJsString(value: Value) bool {
    return value == .string;
}

/// JSON numbers from variables are `.number` or verbatim `.raw` text; both are JS numbers.
fn isJsNumber(value: Value) bool {
    return value == .number or value == .raw;
}

fn isZero(value: Value) bool {
    return switch (value) {
        .number => |n| n == 0,
        .raw => |s| if (std.fmt.parseFloat(f64, s)) |n| n == 0 else |_| false,
        else => false,
    };
}

/// JS `Boolean(value)` for the coerced argument shapes (enum strings, objects, null).
fn truthy(value: Value) bool {
    return switch (value) {
        .null => false,
        .bool => |b| b,
        .number => |n| n != 0 and !std.math.isNan(n),
        .raw => true,
        .string => |s| s.len > 0,
        .array, .object => true,
    };
}

fn parse(a: std.mem.Allocator, text: []const u8) !Value {
    return json.parse(a, text, .{});
}

test "history policy: the TS rejection cases (module.test.ts) and allowed reads" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Case = struct { args: []const u8, aggregate: bool = false, want: ?[]const u8 };
    // Arguments as graphql-js coerces them (literal custom scalars are strings).
    const cases = [_]Case{
        // module.test.ts 'rejects unsupported history reads before accessing PostgreSQL'
        .{ .args = "{\"where\":{\"is_delivered\":{\"_eq\":true}},\"limit\":1}", .want = delivery_filter },
        .{ .args = "{\"confirmations\":0,\"where\":{\"_or\":[{\"is_provisional\":{\"_eq\":true}},{\"is_delivered\":{\"_eq\":false}}]}}", .want = confirmations_unbounded },
        .{ .args = "{\"where\":{\"_or\":[{\"id\":{\"_eq\":\"1\"}},{}]}}", .aggregate = true, .want = aggregate_unidentified },
        .{ .args = "{\"where\":{\"msg_id\":{\"_eq\":null}}}", .aggregate = true, .want = aggregate_unidentified },
        .{ .args = "{\"order_by\":[{\"nonce\":\"desc\"}]}", .want = ordering },
        .{ .args = "{\"order_by\":[{\"send_occurred_at\":\"desc\"}]}", .want = ordering },
        // Allowed: ID-ordered pages, an identifier with nonce ordering, the provisional feed.
        .{ .args = "{\"order_by\":[{\"id\":\"desc\"}],\"limit\":500}", .want = null },
        .{ .args = "{\"where\":{\"origin_tx_hash\":{\"_eq\":\"\\\\xab\"}},\"order_by\":[{\"nonce\":\"asc\"}],\"limit\":500}", .want = null },
        .{ .args = "{\"where\":{\"origin_tx_hash\":{\"_eq\":\"0x11\"}},\"limit\":1}", .aggregate = true, .want = null },
        .{ .args = "{\"where\":{\"id\":{\"_eq\":123}},\"limit\":1}", .aggregate = true, .want = null },
        .{ .args = "{\"where\":{\"msg_id\":{\"_in\":[\"0x01\",\"0x02\"]}},\"confirmations\":3}", .want = null },
        .{ .args = "{\"where\":{\"msg_id\":{\"_in\":[]}},\"confirmations\":3}", .want = confirmations_unbounded },
        .{ .args = "{\"confirmations\":0,\"where\":{\"_and\":[{\"is_provisional\":{\"_eq\":true}},{\"is_delivered\":{\"_eq\":false}}]},\"order_by\":[{\"send_occurred_at\":\"desc\"}]}", .want = null },
        .{ .args = "{\"confirmations\":1,\"where\":{\"is_provisional\":{\"_eq\":true}}}", .want = confirmations_unbounded },
        .{ .args = "{\"where\":{\"send_occurred_at\":{\"_is_null\":true}}}", .want = null_send_time },
        .{ .args = "{\"where\":{\"send_occurred_at\":{\"_is_null\":false}}}", .want = null },
        .{ .args = "{\"where\":{\"_or\":[{\"send_occurred_at\":{\"_is_null\":true}}]}}", .want = null_send_time },
        .{ .args = "{\"order_by\":[{\"nonce\":null,\"id\":\"asc\"}]}", .want = null },
    };
    for (cases) |c| {
        const got = check(try parse(a, c.args), c.aggregate);
        if (c.want) |want| {
            std.testing.expectEqualStrings(want, got orelse "<allowed>") catch |err| {
                std.debug.print("args {s}\n", .{c.args});
                return err;
            };
        } else if (got) |message| {
            std.debug.print("args {s}: unexpected {s}\n", .{ c.args, message });
            return error.TestUnexpectedResult;
        }
    }
}

test "history policy: depth and predicate bounds" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var deep: std.ArrayList(u8) = .empty;
    try deep.appendSlice(a, "{\"where\":");
    for (0..9) |_| try deep.appendSlice(a, "{\"_and\":[");
    try deep.appendSlice(a, "{\"id\":{\"_eq\":\"1\"}}");
    for (0..9) |_| try deep.appendSlice(a, "]}");
    try deep.appendSlice(a, "}");
    try std.testing.expectEqualStrings(too_deep, check(try parse(a, deep.items), false).?);
    var wide: std.ArrayList(u8) = .empty;
    try wide.appendSlice(a, "{\"where\":{\"_or\":[");
    for (0..101) |i| try wide.print(a, "{s}{{\"id\":{{\"_eq\":\"{d}\"}}}}", .{ if (i == 0) "" else ",", i });
    try wide.appendSlice(a, "]}}");
    try std.testing.expectEqualStrings(too_many, check(try parse(a, wide.items), false).?);
}
