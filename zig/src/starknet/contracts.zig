const std = @import("std");
const codec = @import("codec.zig");
const provider = @import("provider.zig");
const tx = @import("transaction.zig");
const protocol = @import("../protocol/root.zig");
const metadata = @import("../relayer/metadata.zig");
const storage = @import("../storage/root.zig");
pub const Felt = codec.Felt;
pub const Checkpoint = struct { merkle_tree_hook_address: [32]u8, mailbox_domain: u32, root: [32]u8, index: u32, block_height: u64 };
pub const OwnedCall = struct {
    allocator: std.mem.Allocator,
    call: tx.Call,
    pub fn deinit(self: *OwnedCall) void {
        self.allocator.free(self.call.calldata);
        self.* = undefined;
    }
};
pub const Contracts = struct {
    provider: *provider.Provider,
    mailbox: Felt,
    hook: Felt,
    domain: u32,
    block: provider.BlockId = .latest,
    fn query(self: Contracts, address: Felt, name: []const u8, calldata: []const Felt) ![]Felt {
        return self.provider.call(address, codec.selector(name), calldata, self.block);
    }
    fn scalar(self: Contracts, address: Felt, name: []const u8, calldata: []const Felt) !Felt {
        const result = try self.query(address, name, calldata);
        defer self.provider.allocator.free(result);
        if (result.len != 1) return error.InvalidCairoScalar;
        return result[0];
    }
    pub fn count(self: Contracts) !u32 {
        return (try self.scalar(self.hook, "count", &.{})).integer(u32);
    }
    pub fn mailboxCount(self: Contracts) !u32 {
        return (try self.scalar(self.mailbox, "nonce", &.{})).integer(u32);
    }
    pub fn countAndTip(self: Contracts, hook: bool, reorg: provider.ReorgPeriod) !struct { count: u32, tip: u64 } {
        const height = try self.provider.height(reorg);
        var pinned = self;
        pinned.block = .{ .number = height };
        return .{ .count = if (hook) try pinned.count() else try pinned.mailboxCount(), .tip = height };
    }
    pub fn delivered(self: Contracts, id: [32]u8) !bool {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.hash(id);
        const result = try self.query(self.mailbox, "delivered", encoder.items.items);
        defer self.provider.allocator.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const value = try decoder.boolean();
        try decoder.finish();
        return value;
    }
    pub fn deliveredCall(self: Contracts, id: [32]u8) !OwnedCall {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.hash(id);
        return .{ .allocator = self.provider.allocator, .call = .{ .to = self.mailbox, .selector = codec.selector("delivered"), .calldata = try encoder.finish() } };
    }
    pub fn defaultIsm(self: Contracts) !Felt {
        return self.scalar(self.mailbox, "get_default_ism", &.{});
    }
    pub fn recipientIsm(self: Contracts, recipient: [32]u8) !Felt {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.hash(recipient);
        return self.scalar(self.mailbox, "recipient_ism", encoder.items.items);
    }
    pub fn checkpointAt(self: Contracts, height: u64) !Checkpoint {
        var pinned = self;
        pinned.block = .{ .number = height };
        const result = try pinned.query(self.hook, "latest_checkpoint", &.{});
        defer self.provider.allocator.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const root = try decoder.hash();
        const index = try decoder.integer(u32);
        try decoder.finish();
        return .{ .merkle_tree_hook_address = self.hook.toBytes(), .mailbox_domain = self.domain, .root = root, .index = index, .block_height = height };
    }
    pub fn latestCheckpoint(self: Contracts, reorg: provider.ReorgPeriod) !Checkpoint {
        return self.checkpointAt(try self.provider.height(reorg));
    }
    pub fn treeAt(self: Contracts, height: u64) !protocol.IncrementalMerkle {
        var pinned = self;
        pinned.block = .{ .number = height };
        const result = try pinned.query(self.hook, "tree", &.{});
        defer self.provider.allocator.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const branch_count = try decoder.integer(usize);
        if (branch_count > 32) return error.InvalidStarknetMerkleTree;
        var tree: protocol.IncrementalMerkle = .{ .branch = .{.{0} ** 32} ** 32 };
        for (tree.branch[0..branch_count]) |*branch| {
            branch.* = try decoder.hash();
            if (try decoder.integer(u32) > 32) return error.InvalidStarknetMerkleTree;
        }
        const leaves = try decoder.uint256();
        tree.count = std.math.cast(u32, leaves) orelse return error.InvalidStarknetMerkleTree;
        try decoder.finish();
        return tree;
    }
    pub fn process(self: Contracts, message: protocol.Message, bytes: []const u8) !OwnedCall {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.bytes(bytes);
        try encoder.message(message);
        return .{ .allocator = self.provider.allocator, .call = .{ .to = self.mailbox, .selector = codec.selector("process"), .calldata = try encoder.finish() } };
    }
    pub fn moduleType(self: Contracts, address: Felt) !metadata.ModuleType {
        const result = try self.query(address, "module_type", &.{});
        defer self.provider.allocator.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const value = try decoder.integer(u8);
        if (value > 7) return error.UnsupportedStarknetModuleType;
        if (value != 6) _ = try decoder.felt(); // Cairo enum's ContractAddress payload.
        try decoder.finish();
        return @enumFromInt(value);
    }
    pub fn verify(self: Contracts, address: Felt, message: protocol.Message, bytes: []const u8) !bool {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.bytes(bytes);
        try encoder.message(message);
        const result = try self.query(address, "verify", encoder.items.items);
        defer self.provider.allocator.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const valid = try decoder.boolean();
        try decoder.finish();
        return valid;
    }
    pub fn route(self: Contracts, address: Felt, message: protocol.Message) !Felt {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.message(message);
        return self.scalar(address, "route", encoder.items.items);
    }
    pub fn members(self: Contracts, address: Felt, message: protocol.Message, comptime validators: bool) !(if (validators) metadata.Members else metadata.ModuleMembers(Felt)) {
        const a = self.provider.allocator;
        var encoder: codec.Encoder = .{ .allocator = a };
        defer encoder.deinit();
        try encoder.message(message);
        const result = try self.query(address, if (validators) "validators_and_threshold" else "modules_and_threshold", encoder.items.items);
        defer a.free(result);
        var decoder: codec.Decoder = .{ .input = result };
        const member_count = try decoder.integer(usize);
        if (member_count > 256 or member_count > result.len - decoder.pos) return error.InvalidStarknetMembers;
        const Address = if (validators) [20]u8 else Felt;
        const addresses = try a.alloc(Address, member_count);
        errdefer a.free(addresses);
        for (addresses) |*out| {
            const value = try decoder.felt();
            if (validators) {
                _ = try value.integer(u160);
                out.* = value.toBytes()[12..32].*;
            } else out.* = value;
        }
        const threshold = try decoder.integer(u32);
        try decoder.finish();
        if (threshold == 0 or threshold > member_count or (validators and threshold > 255)) return error.InvalidStarknetMembers;
        return .{ .addresses = addresses, .threshold = threshold };
    }
    pub fn announcement(self: Contracts, contract: Felt, validator: [20]u8, location: []const u8, signature: [65]u8) !OwnedCall {
        var encoder: codec.Encoder = .{ .allocator = self.provider.allocator };
        defer encoder.deinit();
        try encoder.integer(std.mem.readInt(u160, &validator, .big));
        try encoder.longString(location);
        try encoder.bytes(&signature);
        return .{ .allocator = self.provider.allocator, .call = .{ .to = contract, .selector = codec.selector("announce"), .calldata = try encoder.finish() } };
    }
    pub fn announcedLocations(self: Contracts, contract: Felt, validators: []const [20]u8) !Locations {
        const a = self.provider.allocator;
        if (validators.len > 256) return error.TooManyStarknetValidators;
        var encoder: codec.Encoder = .{ .allocator = a };
        defer encoder.deinit();
        try encoder.integer(validators.len);
        for (validators) |validator| try encoder.integer(std.mem.readInt(u160, &validator, .big));
        const result = try self.query(contract, "get_announced_storage_locations", encoder.items.items);
        defer a.free(result);
        return decodeLocations(a, result, validators.len);
    }
};

pub fn Source(comptime Origin: type) type {
    return struct {
        pub const ModuleAddress = Felt;
        chain: Contracts,
        origin: *Origin,
        const Self = @This();
        pub fn moduleType(self: *Self, address: Felt) !metadata.ModuleType {
            return self.chain.moduleType(address);
        }
        pub fn route(self: *Self, address: Felt, message: protocol.Message) !Felt {
            return self.chain.route(address, message);
        }
        pub fn members(self: *Self, address: Felt, message: protocol.Message, comptime validators: bool) !(if (validators) metadata.Members else metadata.ModuleMembers(Felt)) {
            return self.chain.members(address, message, validators);
        }
        pub fn verifyCandidate(self: *Self, address: Felt, message: protocol.Message, bytes: []const u8) !metadata.Verification {
            // Cairo verify is a real view entrypoint. A call has no measured
            // gas price; preserve module order instead of inventing a quote.
            return .{ .valid = try self.chain.verify(address, message, bytes) };
        }
        pub fn leafIndex(self: *Self, id: [32]u8) !?u32 {
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, validator: [20]u8, index: u32) !?storage.SignedCheckpoint {
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: [20]u8) !?u32 {
            return self.origin.latestIndex(validator);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.origin.proof(index, checkpoint);
        }
    };
}
pub const Locations = struct {
    arena: std.heap.ArenaAllocator,
    values: [][][]const u8,
    pub fn deinit(self: *Locations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub fn decodeLocations(a: std.mem.Allocator, input: []const Felt, expected: usize) !Locations {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    var decoder: codec.Decoder = .{ .input = input };
    const count = try decoder.integer(usize);
    if (count != expected or count > 256) return error.InvalidStarknetLocations;
    const values = try alloc.alloc([][]const u8, count);
    for (values) |*locations| {
        const length = try decoder.integer(usize);
        if (length > 256 or length > input.len - decoder.pos) return error.InvalidStarknetLocations;
        locations.* = try alloc.alloc([]const u8, length);
        for (locations.*) |*location| {
            const chunks = try decoder.integer(usize);
            if (chunks > 1024 or chunks > input.len - decoder.pos) return error.InvalidStarknetLocations;
            var bytes: std.ArrayList(u8) = .empty;
            for (0..chunks) |_| {
                const raw = (try decoder.felt()).toBytes();
                if (raw[0] != 0) return error.InvalidStarknetShortString;
                const text = std.mem.trimStart(u8, raw[1..], &.{0});
                for (text) |c| if (c == 0 or !std.ascii.isAscii(c)) return error.InvalidStarknetShortString;
                try bytes.appendSlice(alloc, text);
            }
            location.* = try bytes.toOwnedSlice(alloc);
        }
    }
    try decoder.finish();
    return .{ .arena = arena, .values = values };
}
