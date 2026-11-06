//! Cosmos SDK / Hyperlane native protobuf schemas, sourced from the pinned Rust
//! generated types. Borrowed decoders retain their input bytes until consumed.
const std = @import("std");
const pb = @import("../altvm/protobuf.zig");
const tx = @import("../altvm/cosmos.zig");
const protocol = @import("../protocol/root.zig");
pub const paths = struct {
    pub const smart_query = "/cosmwasm.wasm.v1.Query/SmartContractState";
    pub const contract_info = "/cosmwasm.wasm.v1.Query/ContractInfo";
    pub const account = "/cosmos.auth.v1beta1.Query/Account";
    pub const balance = "/cosmos.bank.v1beta1.Query/Balance";
    pub const simulate = "/cosmos.tx.v1beta1.Service/Simulate";
    pub const latest_validators = "/cosmos.base.tendermint.v1beta1.Service/GetLatestValidatorSet";
    pub const mailbox = "/hyperlane.core.v1.Query/Mailbox";
    pub const delivered = "/hyperlane.core.v1.Query/Delivered";
    pub const recipient_ism = "/hyperlane.core.v1.Query/RecipientIsm";
    pub const tree = "/hyperlane.core.post_dispatch.v1.Query/MerkleTreeHook";
    pub const ism = "/hyperlane.core.interchain_security.v1.Query/Ism";
    pub const validator_locations = "/hyperlane.core.interchain_security.v1.Query/AnnouncedStorageLocations";
};

pub fn bytesField(message: []const u8, number: u29) !?[]const u8 {
    var decoder: pb.Decoder = .{ .input = message };
    var result: ?[]const u8 = null;
    while (try decoder.next()) |field| if (field.number == number) {
        if (field.value != .bytes) return error.WrongProtobufWireType;
        if (result != null) return error.DuplicateProtobufField;
        result = field.value.bytes;
    };
    return result;
}
pub fn uintField(message: []const u8, number: u29) !u64 {
    var decoder: pb.Decoder = .{ .input = message };
    var result: ?u64 = null;
    while (try decoder.next()) |field| if (field.number == number) {
        if (field.value != .uint) return error.WrongProtobufWireType;
        if (result != null) return error.DuplicateProtobufField;
        result = field.value.uint;
    };
    return result orelse 0; // defined proto3 scalar default
}
pub fn textField(message: []const u8, number: u29) ![]const u8 {
    const text = try bytesField(message, number) orelse "";
    if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidProtobufUtf8;
    return text;
}
pub fn uint32Field(message: []const u8, number: u29) !u32 {
    const value = try uintField(message, number);
    if (value > std.math.maxInt(u32)) return error.ProtobufOverflow;
    return @intCast(value);
}
pub fn boolField(message: []const u8, number: u29) !bool {
    const value = try uintField(message, number);
    if (value > 1) return error.InvalidProtobufBoolean;
    return value == 1;
}

pub fn queryString(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, try std.math.add(usize, value.len, 16));
    errdefer allocator.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(1, value);
    return allocator.realloc(out, enc.pos);
}
pub fn queryPair(allocator: std.mem.Allocator, first: []const u8, second: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, try std.math.add(usize, try std.math.add(usize, first.len, second.len), 32));
    errdefer allocator.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(1, first);
    try enc.bytes(2, second);
    return allocator.realloc(out, enc.pos);
}
pub fn smartQuery(allocator: std.mem.Allocator, address: []const u8, query: []const u8) ![]u8 {
    return queryPair(allocator, address, query);
}
pub fn simulateRequest(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, try std.math.add(usize, raw.len, 16));
    errdefer allocator.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(2, raw);
    return allocator.realloc(out, enc.pos);
}
pub fn simulationTx(allocator: std.mem.Allocator, body: []const u8, auth: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, try std.math.add(usize, try std.math.add(usize, body.len, auth.len), 48));
    errdefer allocator.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(1, body);
    try enc.bytes(2, auth);
    try enc.message(3, ""); // one empty signature, as the Rust estimation path
    return allocator.realloc(out, enc.pos);
}

pub const Any = struct {
    type_url: []const u8,
    value: []const u8,
    pub fn decode(bytes: []const u8) !Any {
        const type_url = try textField(bytes, 1);
        if (type_url.len == 0) return error.MissingProtobufTypeUrl;
        return .{ .type_url = type_url, .value = try bytesField(bytes, 2) orelse "" };
    }
};
pub const BaseAccount = struct {
    address: []const u8,
    account_number: u64,
    sequence: u64,
    pub fn decode(bytes: []const u8) !BaseAccount {
        return .{ .address = try textField(bytes, 1), .account_number = try uintField(bytes, 3), .sequence = try uintField(bytes, 4) };
    }
    pub fn queryResponse(bytes: []const u8) !BaseAccount {
        const any = try Any.decode(try bytesField(bytes, 1) orelse return error.MissingCosmosAccount);
        if (std.mem.eql(u8, any.type_url, "/cosmos.auth.v1beta1.BaseAccount")) return decode(any.value);
        if (std.mem.eql(u8, any.type_url, "/injective.types.v1beta1.EthAccount") or std.mem.eql(u8, any.type_url, "/ethermint.types.v1.EthAccount"))
            return decode(try bytesField(any.value, 1) orelse return error.MissingCosmosAccount);
        return error.UnsupportedCosmosAccountType;
    }
};

pub const NativeMailbox = struct {
    id: []const u8,
    owner: []const u8,
    message_sent: u32,
    message_received: u32,
    default_ism: []const u8,
    default_hook: []const u8,
    required_hook: []const u8,
    domain: u32,
    pub fn queryResponse(bytes: []const u8) !NativeMailbox {
        const mailbox = try bytesField(bytes, 1) orelse return error.MissingNativeMailbox;
        return .{ .id = try textField(mailbox, 1), .owner = try textField(mailbox, 2), .message_sent = try uint32Field(mailbox, 3), .message_received = try uint32Field(mailbox, 4), .default_ism = try textField(mailbox, 5), .default_hook = try textField(mailbox, 6), .required_hook = try textField(mailbox, 7), .domain = try uint32Field(mailbox, 8) };
    }
};

pub const NativeTree = struct {
    id: []const u8,
    mailbox_id: []const u8,
    tree: protocol.IncrementalMerkle,
    pub fn queryResponse(bytes: []const u8) !NativeTree {
        const wrapper = try bytesField(bytes, 1) orelse return error.MissingNativeTree;
        const encoded = try bytesField(wrapper, 4) orelse return error.MissingNativeTree;
        var tree = protocol.IncrementalMerkle.init();
        tree.count = try uint32Field(encoded, 2);
        var decoder: pb.Decoder = .{ .input = encoded };
        var count: usize = 0;
        while (try decoder.next()) |field| if (field.number == 1) {
            if (field.value != .bytes or field.value.bytes.len != 32 or count == 32) return error.InvalidNativeTreeBranch;
            tree.branch[count] = field.value.bytes[0..32].*;
            count += 1;
        };
        if (count != 32) return error.InvalidNativeTreeBranch;
        const expected_root = try bytesField(encoded, 3) orelse return error.MissingNativeTreeRoot;
        if (expected_root.len != 32 or !std.mem.eql(u8, expected_root, &tree.root())) return error.InvalidNativeTreeRoot;
        return .{ .id = try textField(wrapper, 1), .mailbox_id = try textField(wrapper, 3), .tree = tree };
    }
};

pub fn gasUsed(simulate_response: []const u8) !u64 {
    return uintField(try bytesField(simulate_response, 1) orelse return error.MissingCosmosGasInfo, 2);
}
pub fn latestValidatorHeight(bytes: []const u8) !u64 {
    const height = try uintField(bytes, 1);
    if (height > std.math.maxInt(i64)) return error.InvalidCosmosHeight;
    return height;
}

pub fn nativeProcess(allocator: std.mem.Allocator, mailbox_id: []const u8, relayer: []const u8, metadata: []const u8, message: []const u8) ![]u8 {
    var size = try std.math.add(usize, try std.math.add(usize, mailbox_id.len, relayer.len), 64);
    size = try std.math.add(usize, size, try std.math.add(usize, metadata.len, message.len));
    const out = try allocator.alloc(u8, size);
    errdefer allocator.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(1, mailbox_id);
    try enc.bytes(2, relayer);
    try enc.bytes(3, metadata);
    try enc.bytes(4, message);
    return allocator.realloc(out, enc.pos);
}

test "protobuf responses reject duplicate scalars invalid booleans and missing native state" {
    try std.testing.expectError(error.DuplicateProtobufField, uintField(&.{ 8, 1, 8, 2 }, 1));
    try std.testing.expectError(error.InvalidProtobufBoolean, boolField(&.{ 8, 2 }, 1));
    try std.testing.expectError(error.MissingNativeMailbox, NativeMailbox.queryResponse(""));
    try std.testing.expectError(error.MissingNativeTree, NativeTree.queryResponse(""));
    const encoded = try queryPair(std.testing.allocator, "a", "b");
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, &.{ 10, 1, 'a', 18, 1, 'b' }, encoded);
}
