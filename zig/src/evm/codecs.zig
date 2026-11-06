const std = @import("std");
pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const AbiError = error{ InvalidAbi, UnknownEvent, InvalidHex, InvalidQuantity, IntegerOverflow };

pub fn topic(signature: []const u8) Hash {
    @setEvalBranchQuota(100000);
    var result: Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(signature, &result, .{});
    return result;
}

pub const dispatch_topic = topic("Dispatch(address,uint32,bytes32,bytes)");
pub const dispatch_id_topic = topic("DispatchId(bytes32)");
pub const process_topic = topic("Process(uint32,bytes32,address)");
pub const process_id_topic = topic("ProcessId(bytes32)");
pub const gas_payment_topic = topic("GasPayment(bytes32,uint32,uint256,uint256)");
pub const insertion_topic = topic("InsertedIntoTree(bytes32,uint32)");

pub const Event = union(enum) {
    dispatch: struct { sender: Address, destination: u32, recipient: Hash, message: []const u8 },
    dispatch_id: Hash,
    process: struct { origin: u32, sender: Hash, recipient: Address },
    process_id: Hash,
    gas_payment: struct { message_id: Hash, destination: u32, gas_amount: u256, payment: u256 },
    insertion: struct { message_id: Hash, index: u32 },
};

pub fn uintWord(comptime T: type, word: []const u8) AbiError!T {
    if (word.len != 32) return error.InvalidAbi;
    const value = std.mem.readInt(u256, word[0..32], .big);
    if (value > std.math.maxInt(T)) return error.IntegerOverflow;
    return @intCast(value);
}

pub fn addressWord(word: []const u8) AbiError!Address {
    if (word.len != 32 or !std.mem.allEqual(u8, word[0..12], 0)) return error.InvalidAbi;
    return word[12..32].*;
}

/// Decodes the single ABI dynamic bytes value emitted by Dispatch. Borrows data.
pub fn dynamicBytes(data: []const u8) AbiError![]const u8 {
    if (data.len < 64 or data.len % 32 != 0) return error.InvalidAbi;
    if (try uintWord(usize, data[0..32]) != 32) return error.InvalidAbi;
    const len = try uintWord(usize, data[32..64]);
    if (len > data.len - 64) return error.InvalidAbi;
    const padding = (32 - len % 32) % 32;
    if (data.len - 64 - len != padding) return error.InvalidAbi;
    if (!std.mem.allEqual(u8, data[64 + len ..], 0)) return error.InvalidAbi;
    return data[64..][0..len];
}

/// Strict contract ABI decoding. The returned Dispatch message borrows data.
pub fn decodeEvent(topics: []const Hash, data: []const u8) AbiError!Event {
    if (topics.len == 0) return error.InvalidAbi;
    if (std.mem.eql(u8, &topics[0], &dispatch_topic)) {
        if (topics.len != 4) return error.InvalidAbi;
        const sender = try addressWord(&topics[1]);
        const destination = try uintWord(u32, &topics[2]);
        const message = try dynamicBytes(data);
        if (message.len < 77) return error.InvalidAbi;
        // Indexed fields must agree with the packed message, not merely its ABI.
        if (!std.mem.eql(u8, message[9..41], &topics[1]) or
            std.mem.readInt(u32, message[41..45], .big) != destination or
            !std.mem.eql(u8, message[45..77], &topics[3])) return error.InvalidAbi;
        return .{ .dispatch = .{ .sender = sender, .destination = destination, .recipient = topics[3], .message = message } };
    }
    if (std.mem.eql(u8, &topics[0], &process_topic)) {
        if (topics.len != 4 or data.len != 0) return error.InvalidAbi;
        return .{ .process = .{ .origin = try uintWord(u32, &topics[1]), .sender = topics[2], .recipient = try addressWord(&topics[3]) } };
    }
    if (std.mem.eql(u8, &topics[0], &process_id_topic)) {
        if (topics.len != 2 or data.len != 0) return error.InvalidAbi;
        return .{ .process_id = topics[1] };
    }
    if (std.mem.eql(u8, &topics[0], &dispatch_id_topic)) {
        if (topics.len != 2 or data.len != 0) return error.InvalidAbi;
        return .{ .dispatch_id = topics[1] };
    }
    if (std.mem.eql(u8, &topics[0], &gas_payment_topic)) {
        if (topics.len != 3 or data.len != 64) return error.InvalidAbi;
        return .{ .gas_payment = .{ .message_id = topics[1], .destination = try uintWord(u32, &topics[2]), .gas_amount = try uintWord(u256, data[0..32]), .payment = try uintWord(u256, data[32..64]) } };
    }
    if (std.mem.eql(u8, &topics[0], &insertion_topic)) {
        if (topics.len != 1 or data.len != 64) return error.InvalidAbi;
        return .{ .insertion = .{ .message_id = data[0..32].*, .index = try uintWord(u32, data[32..64]) } };
    }
    return error.UnknownEvent;
}

pub fn selector(signature: []const u8) [4]u8 {
    return topic(signature)[0..4].*;
}

fn putWord(dest: *[32]u8, value: usize) void {
    std.mem.writeInt(u256, dest, value, .big);
}

pub fn processCalldata(allocator: std.mem.Allocator, metadata: []const u8, message: []const u8) ![]u8 {
    const meta_padded = try std.math.add(usize, metadata.len, (32 - metadata.len % 32) % 32);
    const message_padded = try std.math.add(usize, message.len, (32 - message.len % 32) % 32);
    const message_offset = try std.math.add(usize, 96, meta_padded);
    const len = try std.math.add(usize, try std.math.add(usize, 4 + message_offset, 32), message_padded);
    const bytes = try allocator.alloc(u8, len);
    @memset(bytes, 0);
    bytes[0..4].* = selector("process(bytes,bytes)");
    putWord(bytes[4..36], 64);
    putWord(bytes[36..68], message_offset);
    putWord(bytes[68..100], metadata.len);
    @memcpy(bytes[100..][0..metadata.len], metadata);
    putWord(bytes[4 + message_offset ..][0..32], message.len);
    @memcpy(bytes[4 + message_offset + 32 ..][0..message.len], message);
    return bytes;
}

pub fn hashCall(signature: []const u8, hash: Hash) [36]u8 {
    var out: [36]u8 = undefined;
    out[0..4].* = selector(signature);
    out[4..36].* = hash;
    return out;
}

pub fn recipientIsmCall(recipient: Address) [36]u8 {
    var out: [36]u8 = .{0} ** 36;
    out[0..4].* = selector("recipientIsm(address)");
    out[16..36].* = recipient;
    return out;
}

pub fn decodeBool(data: []const u8) AbiError!bool {
    const value = try uintWord(u8, data);
    if (value > 1) return error.InvalidAbi;
    return value == 1;
}

pub const Checkpoint = struct { root: Hash, index: u32 };
pub fn decodeCheckpoint(data: []const u8) AbiError!Checkpoint {
    if (data.len != 64) return error.InvalidAbi;
    return .{ .root = data[0..32].*, .index = try uintWord(u32, data[32..64]) };
}

pub fn hexAlloc(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const len = try std.math.add(usize, 2, try std.math.mul(usize, bytes.len, 2));
    const out = try allocator.alloc(u8, len);
    out[0..2].* = "0x".*;
    const digits = "0123456789abcdef";
    for (bytes, 0..) |byte, i| {
        out[2 + i * 2] = digits[byte >> 4];
        out[3 + i * 2] = digits[byte & 15];
    }
    return out;
}

pub fn decodeHex(out: []u8, input: []const u8) AbiError![]u8 {
    if (!std.mem.startsWith(u8, input, "0x") or input.len % 2 != 0) return error.InvalidHex;
    if ((input.len - 2) / 2 > out.len) return error.InvalidHex;
    return std.fmt.hexToBytes(out, input[2..]) catch return error.InvalidHex;
}

pub fn fixedHex(comptime N: usize, input: []const u8) AbiError![N]u8 {
    if (input.len != 2 + N * 2) return error.InvalidHex;
    var out: [N]u8 = undefined;
    _ = try decodeHex(&out, input);
    return out;
}

pub fn quantity(input: []const u8) AbiError!u64 {
    return quantityAs(u64, input);
}

pub fn quantityAs(comptime T: type, input: []const u8) AbiError!T {
    if (T != u64 and T != u256) @compileError("RPC quantity must be u64 or u256");
    if (input.len < 3 or input.len > 2 + @bitSizeOf(T) / 4 or !std.mem.startsWith(u8, input, "0x")) return error.InvalidQuantity;
    if (input.len > 3 and input[2] == '0') return error.InvalidQuantity;
    for (input[2..]) |byte| if (!std.ascii.isHex(byte)) return error.InvalidQuantity;
    return std.fmt.parseInt(T, input[2..], 16) catch return error.InvalidQuantity;
}

pub fn quantityAlloc(allocator: std.mem.Allocator, value: u64) ![]u8 {
    return std.fmt.allocPrint(allocator, "0x{x}", .{value});
}

pub fn quantityAlloc256(allocator: std.mem.Allocator, value: u256) ![]u8 {
    return std.fmt.allocPrint(allocator, "0x{x}", .{value});
}

test "strict quantities and hex data" {
    try std.testing.expectEqual(@as(u64, 0), try quantity("0x0"));
    try std.testing.expectEqual(std.math.maxInt(u64), try quantity("0xffffffffffffffff"));
    for ([_][]const u8{ "0x", "0x00", "0x01", "1", "0x10000000000000000", "0xg", "0x+1", "0x-1" }) |bad|
        try std.testing.expectError(error.InvalidQuantity, quantity(bad));
    try std.testing.expectEqual([2]u8{ 0xab, 0xcd }, try fixedHex(2, "0xAbCd"));
    try std.testing.expectError(error.InvalidHex, fixedHex(2, "0xabc"));
    try std.testing.expectError(error.InvalidHex, fixedHex(2, "abcd"));
    const full = try quantityAlloc256(std.testing.allocator, std.math.maxInt(u256));
    defer std.testing.allocator.free(full);
    try std.testing.expectEqual(std.math.maxInt(u256), try quantityAs(u256, full));
    try std.testing.expectError(error.InvalidQuantity, quantity(full));
    try std.testing.expectError(error.InvalidQuantity, quantityAs(u256, "0x01"));
}

test "process calldata canonical offsets and zero padding" {
    const bytes = try processCalldata(std.testing.allocator, "abc", "hello");
    defer std.testing.allocator.free(bytes);
    try std.testing.expectEqual(@as(usize, 196), bytes.len);
    try std.testing.expectEqual(@as(usize, 64), try uintWord(usize, bytes[4..36]));
    try std.testing.expectEqual(@as(usize, 128), try uintWord(usize, bytes[36..68]));
    try std.testing.expectEqual(@as(usize, 3), try uintWord(usize, bytes[68..100]));
    try std.testing.expectEqualStrings("abc", bytes[100..103]);
    try std.testing.expect(std.mem.allEqual(u8, bytes[103..132], 0));
    try std.testing.expectEqual(@as(usize, 5), try uintWord(usize, bytes[132..164]));
    try std.testing.expectEqualStrings("hello", bytes[164..169]);
}

test "dispatch validates ABI bounds padding and indexed message fields" {
    var data: [160]u8 = .{0} ** 160;
    putWord(data[0..32], 32);
    putWord(data[32..64], 77);
    data[64] = 3;
    var topics = [_]Hash{ dispatch_topic, .{0} ** 32, .{0} ** 32, .{0} ** 32 };
    const event = try decodeEvent(&topics, &data);
    try std.testing.expectEqual(@as(usize, 77), event.dispatch.message.len);
    topics[2][31] = 1;
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&topics, &data));
    topics[2][31] = 0;
    data[159] = 1;
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&topics, &data));
    data[159] = 0;
    data[31] = 64;
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&topics, &data));
    data[31] = 32;
    @memset(data[32..64], 255);
    try std.testing.expectError(error.IntegerOverflow, decodeEvent(&topics, &data));
}

test "process insertion and gas events reject type overflow and malformed topics" {
    var data: [64]u8 = .{0} ** 64;
    data[31] = 3;
    data[63] = 7;
    const insertion = try decodeEvent(&.{insertion_topic}, &data);
    try std.testing.expectEqual(@as(u32, 7), insertion.insertion.index);
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&.{insertion_topic}, data[0..63]));
    data[32] = 1;
    try std.testing.expectError(error.IntegerOverflow, decodeEvent(&.{insertion_topic}, &data));
    const gas = try decodeEvent(&.{ gas_payment_topic, .{9} ** 32, .{0} ** 32 }, &data);
    try std.testing.expectEqual(@as(u256, 3), gas.gas_payment.gas_amount);
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&.{process_topic}, &.{}));
    try std.testing.expectError(error.UnknownEvent, decodeEvent(&.{.{0} ** 32}, &.{}));
    try std.testing.expectError(error.InvalidAbi, decodeEvent(&.{}, &.{}));
    var boolean: [32]u8 = .{0} ** 32;
    boolean[31] = 2;
    try std.testing.expectError(error.InvalidAbi, decodeBool(&boolean));
}

test "event signatures and calldata selector match Foundry cast fixtures" {
    // Generated independently with `cast sig` / `cast keccak` from the Solidity ABI.
    try std.testing.expectEqual([4]u8{ 0x7c, 0x39, 0xd1, 0x30 }, selector("process(bytes,bytes)"));
    try std.testing.expectEqual(try fixedHex(32, "0x769f711d20c679153d382254f5989261" ++ "3b58a97cc876b249134ac25c80f9c814"), dispatch_topic);
    try std.testing.expectEqual(try fixedHex(32, "0x253a3a04cab70d47c1504809242d9350" ++ "cd81627b4f1d50753e159cf8cd76ed33"), insertion_topic);
    var max_word: [32]u8 = .{255} ** 32;
    try std.testing.expectEqual(std.math.maxInt(u256), try uintWord(u256, &max_word));
    try std.testing.expectError(error.IntegerOverflow, uintWord(u32, &max_word));
    try std.testing.expectError(error.InvalidAbi, addressWord(&max_word));
}
