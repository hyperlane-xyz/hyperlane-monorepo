//! Gateway programmatic-SBOR event semantics. Emitter identity, field kinds and
//! optional schema names are validated before canonical Hyperlane messages pass.
const std = @import("std");
const json = @import("../cosmos/types.zig");
const protocol = @import("../protocol/root.zig");
const address = @import("address.zig");
pub const Hash = [32]u8;
pub const Event = union(enum) { dispatch: protocol.Message, delivery: struct { id: Hash, sequence: u32 }, insertion: struct { id: Hash, index: u32 }, gas_payment: struct { id: Hash, destination: u32, gas_amount: u256, payment: u256, resource: []const u8, sequence: u32 } };
pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    event: Event,
    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
fn optionalName(value: std.json.Value, key: []const u8, expected: []const u8) !void {
    if (value != .object) return error.InvalidRadixEvent;
    if (value.object.get(key)) |actual| {
        if (actual == .null) return;
        if (!std.mem.eql(u8, try json.string(actual), expected)) return error.WrongRadixEventSchema;
    }
}
fn eventField(fields: []const std.json.Value, index: usize, kind: []const u8, name: []const u8) !std.json.Value {
    if (index >= fields.len) return error.InvalidRadixEvent;
    const field = fields[index];
    if (!std.mem.eql(u8, try json.string(try json.field(field, "kind")), kind)) return error.WrongRadixEventFieldKind;
    try optionalName(field, "field_name", name);
    return field;
}
fn u32Field(fields: []const std.json.Value, index: usize, name: []const u8) !u32 {
    const value = try json.uint(try json.field(try eventField(fields, index, "U32", name), "value"));
    if (value > std.math.maxInt(u32)) return error.RadixEventOverflow;
    return @intCast(value);
}
fn bytesField(allocator: std.mem.Allocator, fields: []const std.json.Value, index: usize, name: []const u8) ![]u8 {
    const text = try json.string(try json.field(try eventField(fields, index, "Bytes", name), "hex"));
    if (text.len % 2 != 0) return error.InvalidRadixEventHex;
    const bytes = try allocator.alloc(u8, text.len / 2);
    _ = try std.fmt.hexToBytes(bytes, text);
    return bytes;
}
fn hashField(allocator: std.mem.Allocator, fields: []const std.json.Value, index: usize, name: []const u8) !Hash {
    const raw = try bytesField(allocator, fields, index, name);
    if (raw.len != 32) return error.InvalidRadixHash;
    return raw[0..32].*;
}
pub fn decimalAttos(text: []const u8) !i192 {
    if (text.len == 0) return error.InvalidRadixDecimal;
    const negative = text[0] == '-';
    const raw = if (negative) text[1..] else text;
    var parts = std.mem.splitScalar(u8, raw, '.');
    const whole = parts.next().?;
    const fraction = parts.next() orelse "";
    if (parts.next() != null or whole.len == 0 or fraction.len > 18) return error.InvalidRadixDecimal;
    for (whole) |char| if (!std.ascii.isDigit(char)) return error.InvalidRadixDecimal;
    for (fraction) |char| if (!std.ascii.isDigit(char)) return error.InvalidRadixDecimal;
    var result = try std.math.mul(u192, try std.fmt.parseInt(u192, whole, 10), 1000000000000000000);
    if (fraction.len > 0) {
        var part = try std.fmt.parseInt(u192, fraction, 10);
        for (fraction.len..18) |_| part = try std.math.mul(u192, part, 10);
        result = try std.math.add(u192, result, part);
    }
    const limit = @as(u192, std.math.maxInt(i192)) + @intFromBool(negative);
    if (result > limit) return error.RadixDecimalOverflow;
    if (negative) {
        if (result == limit) return std.math.minInt(i192);
        return -@as(i192, @intCast(result));
    }
    return @intCast(result);
}
pub fn parse(allocator: std.mem.Allocator, network: address.Network, contract: [30]u8, value: std.json.Value) !?Parsed {
    const name = try json.string(try json.field(value, "name"));
    const typ: u2 = if (std.mem.eql(u8, name, "DispatchEvent")) 0 else if (std.mem.eql(u8, name, "ProcessIdEvent")) 1 else if (std.mem.eql(u8, name, "InsertedIntoTreeEvent")) 2 else if (std.mem.eql(u8, name, "GasPayment")) 3 else return null;
    const emitter = try json.field(value, "emitter");
    if (!std.mem.eql(u8, try json.string(try json.field(emitter, "type")), "Method")) return null;
    const entity = try json.field(emitter, "entity");
    const encoded = try json.string(try json.field(entity, "entity_address"));
    var buffer: [30]u8 = undefined;
    const actual = try address.decode(network, "component", encoded, &buffer);
    if (!std.mem.eql(u8, actual, &contract)) return null;
    const data = try json.field(value, "data");
    if (!std.mem.eql(u8, try json.string(try json.field(data, "kind")), "Tuple")) return error.WrongRadixEventKind;
    try optionalName(data, "type_name", name);
    const array = try json.field(data, "fields");
    if (array != .array) return error.InvalidRadixEvent;
    const fields = array.array.items;
    if (fields.len != ([_]usize{ 4, 2, 2, 6 })[typ]) return error.InvalidRadixEvent;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const event: Event = switch (typ) {
        0 => blk: {
            const destination = try u32Field(fields, 0, "destination");
            const recipient = try hashField(alloc, fields, 1, "recipient");
            const message = try protocol.Message.decode(try bytesField(alloc, fields, 2, "message"));
            const sequence = try u32Field(fields, 3, "sequence");
            if (message.version != 3 or message.destination != destination or !std.mem.eql(u8, &message.recipient, &recipient) or message.nonce != sequence) return error.InconsistentRadixDispatch;
            break :blk .{ .dispatch = message };
        },
        1 => .{ .delivery = .{ .id = try hashField(alloc, fields, 0, "message_id"), .sequence = try u32Field(fields, 1, "sequence") } },
        2 => .{ .insertion = .{ .id = try hashField(alloc, fields, 0, "id"), .index = try u32Field(fields, 1, "index") } },
        3 => blk: {
            const gas = try decimalAttos(try json.string(try json.field(try eventField(fields, 2, "Decimal", "gas_amount"), "value")));
            const payment = try decimalAttos(try json.string(try json.field(try eventField(fields, 3, "Decimal", "payment"), "value")));
            break :blk .{ .gas_payment = .{ .id = try hashField(alloc, fields, 0, "message_id"), .destination = try u32Field(fields, 1, "destination_domain"), .gas_amount = if (gas < 0) 0 else @as(u192, @intCast(gas)) / 1000000000000000000, .payment = if (payment < 0) 0 else @intCast(payment), .resource = try alloc.dupe(u8, try json.string(try json.field(try eventField(fields, 4, "String", "resource_address"), "value"))), .sequence = try u32Field(fields, 5, "sequence") } };
        },
    };
    return .{ .arena = arena, .event = event };
}
test "Radix decimal fixed 18 digit arithmetic bounds and negative source semantics" {
    try std.testing.expectEqual(@as(i192, 1500000000000000000), try decimalAttos("1.5"));
    try std.testing.expectEqual(@as(i192, -1), try decimalAttos("-0.000000000000000001"));
    try std.testing.expectError(error.InvalidRadixDecimal, decimalAttos("0.0000000000000000001"));
}
