//! Source-accurate JSON codecs for delegated relayer HTTP handlers.
//!
//! Rust serde's externally tagged gas enum and Hyperlane message representation
//! are intentionally encoded by hand; generic Zig struct stringification would
//! change field naming and hash/body representations.
const std = @import("std");
const http = @import("../http.zig");
const settings = @import("../../settings/types.zig");
const settings_root = @import("../../settings/root.zig");
const value_view = @import("../../settings/value.zig").View;
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;

pub const GasPolicy = @FieldType(settings.GasEnforcement, "policy");
pub const Hash = [32]u8;

pub fn errorBody(a: A, message: []const u8) ![]u8 {
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    try out.writer.writeAll("{\"message\":");
    try writeString(&out.writer, message);
    try out.writer.writeByte('}');
    const result = try a.dupe(u8, out.written());
    out.deinit();
    return result;
}

pub fn writeString(w: *std.Io.Writer, text: []const u8) !void {
    try w.writeByte('"');
    for (text) |byte| {
        switch (byte) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0x08 => try w.writeAll("\\b"),
            0x0c => try w.writeAll("\\f"),
            else => {
                if (byte < 0x20) {
                    try w.print("\\u{x:0>4}", .{byte});
                } else {
                    try w.writeByte(byte);
                }
            },
        }
    }
    try w.writeByte('"');
}

pub fn writePrefixedHash(w: *std.Io.Writer, hash: Hash) !void {
    const hex = "0123456789abcdef";
    try w.writeAll("0x");
    for (hash) |byte| {
        try w.writeByte(hex[byte >> 4]);
        try w.writeByte(hex[byte & 15]);
    }
}

pub fn writeUnprefixedHash(w: *std.Io.Writer, hash: Hash) !void {
    const hex = "0123456789abcdef";
    for (hash) |byte| {
        try w.writeByte(hex[byte >> 4]);
        try w.writeByte(hex[byte & 15]);
    }
}

pub fn parseHash(text: []const u8) !Hash {
    const digits = if (std.mem.startsWith(u8, text, "0x") or std.mem.startsWith(u8, text, "0X")) text[2..] else text;
    if (digits.len != 32 * 2) return error.InvalidHash;
    var out: Hash = undefined;
    _ = std.fmt.hexToBytes(&out, digits) catch return error.InvalidHash;
    return out;
}

fn integer(value: std.json.Value, comptime T: type) !T {
    if (value != .integer) return error.InvalidJsonFieldType;
    return std.math.cast(T, value.integer) orelse error.InvalidJsonFieldValue;
}

pub fn parseMessage(value: std.json.Value, a: A) !protocol.Message {
    if (value != .object) return error.InvalidJsonFieldType;
    const object = value.object;
    const body_value = object.get("body") orelse return error.MissingMessageBody;
    if (body_value != .array) return error.InvalidMessageBody;
    const bytes = try a.alloc(u8, body_value.array.items.len);
    errdefer a.free(bytes);
    for (body_value.array.items, bytes) |item, *byte| {
        const number = try integer(item, u8);
        byte.* = number;
    }
    errdefer if (bytes.len == 0) a.free(bytes);
    return .{
        .version = try integer(object.get("version") orelse return error.MissingMessageVersion, u8),
        .nonce = try integer(object.get("nonce") orelse return error.MissingMessageNonce, u32),
        .origin = try integer(object.get("origin") orelse return error.MissingMessageOrigin, u32),
        .sender = try parseAddressValue(object.get("sender") orelse return error.MissingMessageSender),
        .destination = try integer(object.get("destination") orelse return error.MissingMessageDestination, u32),
        .recipient = try parseAddressValue(object.get("recipient") orelse return error.MissingMessageRecipient),
        .body = bytes,
    };
}

fn parseAddressValue(value: std.json.Value) !Hash {
    if (value != .string) return error.InvalidJsonFieldType;
    return parseHash(value.string) catch error.InvalidMessageAddress;
}

pub fn writeMessage(w: *std.Io.Writer, message: protocol.Message) !void {
    try w.writeAll("{\"version\":");
    try w.print("{d}", .{message.version});
    try w.writeAll(",\"nonce\":");
    try w.print("{d}", .{message.nonce});
    try w.writeAll(",\"origin\":");
    try w.print("{d}", .{message.origin});
    try w.writeAll(",\"sender\":\"");
    try writePrefixedHash(w, message.sender);
    try w.writeAll("\",\"destination\":");
    try w.print("{d}", .{message.destination});
    try w.writeAll(",\"recipient\":\"");
    try writePrefixedHash(w, message.recipient);
    try w.writeAll("\",\"body\":[");
    for (message.body, 0..) |byte, index| {
        if (index != 0) try w.writeByte(',');
        try w.print("{d}", .{byte});
    }
    try w.writeAll("]}");
}

pub fn parseMatching(a: A, value: std.json.Value) !settings.MatchingList {
    return settings_root.parseMatching(a, value_view{ .value = value });
}

pub fn parseGasPolicy(value: std.json.Value) !GasPolicy {
    if (value == .string) {
        if (std.mem.eql(u8, value.string, "None")) return .none;
        return error.InvalidGasPolicy;
    }
    if (value != .object or value.object.count() != 1) return error.InvalidGasPolicy;
    const kind = value.object.keys()[0];
    const payload = value.object.values()[0];
    if (std.mem.eql(u8, kind, "None")) {
        if (payload != .null and payload != .object) return error.InvalidGasPolicy;
        if (payload == .object and payload.object.count() != 0) return error.InvalidGasPolicy;
        return .none;
    }
    if (std.mem.eql(u8, kind, "Minimum")) {
        if (payload != .object) return error.InvalidGasPolicy;
        if (payload.object.count() != 1) return error.InvalidGasPolicy;
        const payment = payload.object.get("payment") orelse return error.MissingGasPayment;
        return .{ .minimum = try parseU256(payment) };
    }
    if (std.mem.eql(u8, kind, "OnChainFeeQuoting")) {
        if (payload != .object) return error.InvalidGasPolicy;
        if (payload.object.count() != 2) return error.InvalidGasPolicy;
        const numerator = payload.object.get("gas_fraction_numerator") orelse return error.MissingGasFraction;
        const denominator = payload.object.get("gas_fraction_denominator") orelse return error.MissingGasFraction;
        const bottom = try parseU256(denominator);
        if (bottom == 0 or bottom > std.math.maxInt(u64)) return error.InvalidGasFraction;
        const top = try parseU256(numerator);
        if (top > std.math.maxInt(u64)) return error.InvalidGasFraction;
        return .{ .on_chain_fee_quoting = .{ .numerator = @intCast(top), .denominator = @intCast(bottom) } };
    }
    return error.InvalidGasPolicy;
}

fn parseU256(value: std.json.Value) !u256 {
    switch (value) {
        .string => |text| {
            if (std.mem.startsWith(u8, text, "0x") or std.mem.startsWith(u8, text, "0X")) {
                return std.fmt.parseInt(u256, text[2..], 16) catch error.InvalidGasAmount;
            }
            return std.fmt.parseInt(u256, text, 10) catch error.InvalidGasAmount;
        },
        .integer => |number| {
            if (number < 0) return error.InvalidGasAmount;
            return @intCast(number);
        },
        .number_string => |text| return std.fmt.parseInt(u256, text, 10) catch error.InvalidGasAmount,
        else => return error.InvalidGasAmount,
    }
}

pub fn writeGasPolicy(w: *std.Io.Writer, policy: GasPolicy) !void {
    switch (policy) {
        .none => try w.writeAll("\"None\""),
        .minimum => |payment| {
            try w.writeAll("{\"Minimum\":{\"payment\":\"");
            try w.print("{d}", .{payment});
            try w.writeAll("\"}}");
        },
        .on_chain_fee_quoting => |fraction| {
            try w.writeAll("{\"OnChainFeeQuoting\":{\"gas_fraction_numerator\":");
            try w.print("{d}", .{fraction.numerator});
            try w.writeAll(",\"gas_fraction_denominator\":");
            try w.print("{d}", .{fraction.denominator});
            try w.writeAll("}}");
        },
    }
}

/// Formats the Rust `{:?}` representation used verbatim by GET /igp_rules.
pub fn writeMatchingRuleDebug(w: *std.Io.Writer, rule: settings.Rule) !void {
    try w.writeAll("ListElement { message_id: ");
    try writeFilterDebug(Hash, w, rule.message_id);
    try w.writeAll(", origin_domain: ");
    try writeFilterDebug(u32, w, rule.origin_domain);
    try w.writeAll(", sender_address: ");
    try writeFilterDebug(Hash, w, rule.sender_address);
    try w.writeAll(", destination_domain: ");
    try writeFilterDebug(u32, w, rule.destination_domain);
    try w.writeAll(", recipient_address: ");
    try writeFilterDebug(Hash, w, rule.recipient_address);
    try w.writeAll(", body_regex: ");
    if (rule.body_regex) |pattern| {
        try w.writeAll("Some(RegexWrapper(Regex(\"");
        try writeString(w, pattern);
        try w.writeAll("\")))");
    } else {
        try w.writeAll("None");
    }
    try w.writeAll(" }");
}

fn writeFilterDebug(comptime T: type, w: *std.Io.Writer, filter: settings.Filter(T)) !void {
    switch (filter) {
        .wildcard => try w.writeAll("*"),
        .values => |values| {
            try w.writeAll("Enumerated([");
            for (values, 0..) |item, index| {
                if (index != 0) try w.writeAll(", ");
                if (T == Hash) {
                    try writePrefixedHash(w, item);
                } else {
                    try w.print("{d}", .{item});
                }
            }
            try w.writeAll("])");
        },
    }
}

pub fn finish(out: *std.Io.Writer.Allocating, a: A) ![]u8 {
    const result = try a.dupe(u8, out.written());
    out.deinit();
    return result;
}

pub fn response(out: *std.Io.Writer.Allocating, a: A, status: u16, headers: []const http.Header) !http.Response {
    const result = try http.Response.init(a, status, headers, out.written());
    out.deinit();
    return result;
}

test "message json round trips source field and body representation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = "{\"version\":3,\"nonce\":7,\"origin\":9,\"sender\":\"0x" ++ "0102030405060708090a0b0c0d0e0f10" ++ "1112131415161718191a1b1c1d1e1f20\",\"destination\":10,\"recipient\":\"0x" ++ "201f1e1d1c1b1a191817161514131211" ++ "0f0e0d0c0b0a09080706050403020100\",\"body\":[0,15,255]}";
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    const message = try parseMessage(parsed.value, a);
    try std.testing.expectEqualSlices(u8, &.{ 0, 15, 255 }, message.body);
    var out = std.Io.Writer.Allocating.init(a);
    try writeMessage(&out.writer, message);
    const canonical = try finish(&out, a);
    try std.testing.expectEqualStrings(raw, canonical);
}

test "gas policy matching list and errors parse source shapes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = "{\"policy\":{\"Minimum\":{\"payment\":\"0x64\"}},\"matching_list\":[{\"origindomain\":100}]}";
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    const object = parsed.value.object;
    const policy = try parseGasPolicy(object.get("policy").?);
    try std.testing.expectEqual(@as(u256, 100), policy.minimum);
    const list = try parseMatching(a, object.get("matching_list").?);
    try std.testing.expectEqual(@as(usize, 1), list.len);
    try std.testing.expectEqual(@as(u32, 100), list[0].origin_domain.values[0]);
    try std.testing.expectError(error.InvalidGasPolicy, parseGasPolicy(.{ .string = "minimum" }));
}

test "matching rule debug format matches rust derive" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rule: settings.Rule = .{ .origin_domain = .{ .values = &.{100} } };
    var out = std.Io.Writer.Allocating.init(a);
    try writeMatchingRuleDebug(&out.writer, rule);
    const text = try finish(&out, a);
    try std.testing.expectEqualStrings("ListElement { message_id: *, origin_domain: Enumerated([100]), sender_address: *, destination_domain: *, recipient_address: *, body_regex: None }", text);
}
