//! Hyperlane's actual Aleo plaintext layouts (fixed little-endian body words).
const std = @import("std");
const p = @import("plaintext.zig");
const protocol = @import("../protocol/root.zig");
pub const Message = protocol.Message;
pub const Hash = [32]u8;
pub fn decodeMessage(a: std.mem.Allocator, value: p.Value) !Message {
    const sender = try (try value.member("sender")).bytes(a, 32);
    defer a.free(sender);
    const recipient = try (try value.member("recipient")).bytes(a, 32);
    defer a.free(recipient);
    const words = try (try value.member("body")).items(16);
    const body = try a.alloc(u8, 256);
    errdefer a.free(body);
    for (words, 0..) |word, i| std.mem.writeInt(u128, body[i * 16 ..][0..16], try word.number(u128), .little);
    return .{ .version = try (try value.member("version")).number(u8), .nonce = try (try value.member("nonce")).number(u32), .origin = try (try value.member("origin_domain")).number(u32), .destination = try (try value.member("destination_domain")).number(u32), .sender = sender[0..32].*, .recipient = recipient[0..32].*, .body = body };
}
pub fn messageValue(a: std.mem.Allocator, message: Message) !p.Value {
    if (message.body.len > 256) return error.AleoMessageBodyTooLarge;
    var body: [256]u8 = .{0} ** 256;
    @memcpy(body[0..message.body.len], message.body);
    const words = try a.alloc(p.Value, 16);
    for (words, 0..) |*word, i| word.* = p.number(std.mem.readInt(u128, body[i * 16 ..][0..16], .little));
    const fields = try a.alloc(p.Member, 7);
    fields[0..7].* = .{ .{ .name = "version", .value = p.number(message.version) }, .{ .name = "nonce", .value = p.number(message.nonce) }, .{ .name = "origin_domain", .value = p.number(message.origin) }, .{ .name = "sender", .value = try p.byteArray(a, &message.sender) }, .{ .name = "destination_domain", .value = p.number(message.destination) }, .{ .name = "recipient", .value = try p.byteArray(a, &message.recipient) }, .{ .name = "body", .value = .{ .array = words } } };
    // Exactly seven source struct fields; no variable body length is persisted.
    return .{ .object = fields[0..7] };
}
pub const GasPayment = struct { id: Hash, destination: u32, gas_amount: u128, payment: u64, index: u32 };
pub fn gasPayment(value: p.Value) !GasPayment {
    return .{ .id = try (try value.member("id")).hash(), .destination = try (try value.member("destination_domain")).number(u32), .gas_amount = try (try value.member("gas_amount")).number(u128), .payment = try (try value.member("payment")).number(u64), .index = try (try value.member("index")).number(u32) };
}
pub const Insertion = struct { id: Hash, index: u32 };
pub fn insertion(value: p.Value) !Insertion {
    return .{ .id = try (try value.member("id")).hash(), .index = try (try value.member("index")).number(u32) };
}
pub const Tree = struct { branch: [32]Hash, count: u32, root: Hash };
pub fn tree(value: p.Value) !Tree {
    const actual = try value.member("tree");
    const branch = try (try actual.member("branch")).items(32);
    var result: Tree = .{ .branch = undefined, .count = try (try actual.member("count")).number(u32), .root = try (try value.member("root")).hash() };
    for (branch, &result.branch) |word, *hash| hash.* = try word.hash();
    return result;
}
pub const Members = struct { validators: [6][20]u8, count: u8, threshold: u8 };
pub fn members(value: p.Value) !Members {
    const count = try (try value.member("validator_count")).number(u8);
    const threshold = try (try value.member("threshold")).number(u8);
    if (count > 6 or threshold == 0 or threshold > count) return error.InvalidAleoThreshold;
    const validators = try (try value.member("validators")).items(6);
    var result: Members = .{ .validators = undefined, .count = 0, .threshold = threshold };
    for (validators[0..count]) |validator| {
        const bytes = try (try validator.member("bytes")).items(20);
        var address: [20]u8 = undefined;
        for (bytes, &address) |byte, *out| out.* = try byte.number(u8);
        if (std.mem.allEqual(u8, &address, 0)) continue;
        for (result.validators[0..result.count]) |previous| if (std.mem.eql(u8, &previous, &address)) return error.DuplicateAleoValidator;
        result.validators[result.count] = address;
        result.count += 1;
    }
    if (result.count < threshold) return error.InvalidAleoThreshold;
    return result;
}
pub fn cString(a: std.mem.Allocator, value: p.Value, size: usize) ![]u8 {
    const bytes = try value.bytes(a, size);
    defer a.free(bytes);
    const end = std.mem.indexOfScalar(u8, bytes, 0) orelse return error.MissingAleoStringTerminator;
    if (!std.unicode.utf8ValidateSlice(bytes[0..end])) return error.InvalidAleoUtf8;
    return a.dupe(u8, bytes[0..end]);
}

test "Aleo fixed body and little endian hashes preserve public source layouts" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const allocator = arena.allocator();
    const input: Message = .{ .version = 3, .nonce = 7, .origin = 100, .destination = 200, .sender = .{1} ** 32, .recipient = .{2} ** 32, .body = &.{ 0, 1, 0, 255 } };
    const value = try messageValue(allocator, input);
    const encoded = try value.render(allocator);
    var parsed = try p.Document.parse(a, encoded, .{});
    defer parsed.deinit();
    const decoded = try decodeMessage(allocator, parsed.value);
    try std.testing.expectEqual(@as(usize, 256), decoded.body.len);
    try std.testing.expectEqualSlices(u8, input.body, decoded.body[0..4]);
    try std.testing.expect(std.mem.allEqual(u8, decoded.body[4..], 0));
    var oversized = input;
    oversized.body = &(.{0} ** 257);
    try std.testing.expectError(error.AleoMessageBodyTooLarge, messageValue(allocator, oversized));
    var malformed = try p.Document.parse(a, "{id:[1u128,2u128],index:42u32}", .{});
    defer malformed.deinit();
    const event = try insertion(malformed.value);
    try std.testing.expectEqual(@as(u32, 42), event.index);
    try std.testing.expectEqual(@as(u8, 2), event.id[16]);
}
