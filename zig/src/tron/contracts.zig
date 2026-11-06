//! ABI surface shared with Ethereum contracts; transport is latest walletsolidity
//! state, which cannot serve historical calls. No checkpoint is height-pinned.
const std = @import("std");
const p = @import("provider.zig");
const tx = @import("transaction.zig");
const abi = @import("../evm/codecs.zig");
const announce_abi = @import("../evm/announce.zig");
const protocol = @import("../protocol/root.zig");
const metadata = @import("../relayer/metadata.zig");
const evm_source = @import("../relayer/evm_source.zig");
const storage = @import("../storage/root.zig");
const A = std.mem.Allocator;
pub const Address = [20]u8;
pub const Hash = [32]u8;
/// On-chain checkpoint lacks a message ID; attach the indexed leaf before signing.
pub const Checkpoint = struct { merkle_tree_hook_address: Hash, mailbox_domain: u32, root: Hash, index: u32 };

pub const Contracts = struct {
    provider: *p.Provider,
    mailbox: Address,
    hook: Address,
    domain: u32,
    fn query(self: Contracts, address: Address, data: []const u8) ![]u8 {
        return self.provider.ethCall(address, data, .finalized);
    }
    fn integer(self: Contracts, comptime T: type, address: Address, data: []const u8) !T {
        const result = try self.query(address, data);
        defer self.provider.allocator.free(result);
        return abi.uintWord(T, result);
    }
    fn addressQuery(self: Contracts, address: Address, data: []const u8) !Address {
        const result = try self.query(address, data);
        defer self.provider.allocator.free(result);
        return abi.addressWord(result);
    }
    pub fn count(self: Contracts) !u32 {
        return self.integer(u32, self.hook, &abi.selector("count()"));
    }
    pub fn mailboxCount(self: Contracts) !u32 {
        return self.integer(u32, self.mailbox, &abi.selector("nonce()"));
    }
    pub fn countAndTip(self: Contracts, hook: bool) !struct { count: u32, tip: u32 } {
        // Latest solidified state has no historical parameter: count first,
        // tip second, preserving source's no-count-above-reported-tip guarantee.
        const count_value = if (hook) try self.count() else try self.mailboxCount();
        return .{ .count = count_value, .tip = try self.provider.finalizedBlockNumber() };
    }
    pub fn delivered(self: Contracts, id: Hash) !bool {
        const result = try self.query(self.mailbox, &abi.hashCall("delivered(bytes32)", id));
        defer self.provider.allocator.free(result);
        return abi.decodeBool(result);
    }
    pub fn defaultIsm(self: Contracts) !Address {
        return self.addressQuery(self.mailbox, &abi.selector("defaultIsm()"));
    }
    pub fn recipientIsm(self: Contracts, recipient: Address) !Address {
        return self.addressQuery(self.mailbox, &abi.recipientIsmCall(recipient));
    }
    pub fn latestCheckpoint(self: Contracts) !Checkpoint {
        const result = try self.query(self.hook, &abi.selector("latestCheckpoint()"));
        defer self.provider.allocator.free(result);
        const checkpoint = try abi.decodeCheckpoint(result);
        var hook: Hash = .{0} ** 32;
        hook[12..].* = self.hook;
        return .{ .merkle_tree_hook_address = hook, .mailbox_domain = self.domain, .root = checkpoint.root, .index = checkpoint.index };
    }
    pub fn tree(self: Contracts) !protocol.IncrementalMerkle {
        const result = try self.query(self.hook, &abi.selector("tree()"));
        defer self.provider.allocator.free(result);
        if (result.len != 33 * 32) return error.InvalidAbi;
        var tree_value: protocol.IncrementalMerkle = .{};
        for (&tree_value.branch, 0..) |*branch, i| branch.* = result[i * 32 ..][0..32].*;
        tree_value.count = try abi.uintWord(u32, result[32 * 32 ..]);
        return tree_value;
    }
    pub fn process(self: Contracts, message: []const u8, bytes: []const u8) !tx.Trigger {
        const data = try abi.processCalldata(self.provider.allocator, bytes, message);
        errdefer self.provider.allocator.free(data);
        return self.provider.trigger(null, self.mailbox, data, 0);
    }
    /// The returned process trigger owns its data. Other borrowed triggers may
    /// be constructed with Provider.trigger and must not use this helper.
    pub fn freeProcess(self: Contracts, trigger: tx.Trigger) void {
        self.provider.allocator.free(trigger.data);
    }
    pub fn moduleType(self: Contracts, address: Address) !metadata.ModuleType {
        const raw = try self.integer(u8, address, &abi.selector("moduleType()"));
        return std.meta.intToEnum(metadata.ModuleType, raw) catch .unused;
    }
    pub fn route(self: Contracts, address: Address, message: protocol.Message) !Address {
        const data = try messageCall(self.provider.allocator, "route(bytes)", message);
        defer self.provider.allocator.free(data);
        return self.addressQuery(address, data);
    }
    pub fn members(self: Contracts, address: Address, message: protocol.Message, validators: bool) !metadata.Members {
        const data = try messageCall(self.provider.allocator, if (validators) "validatorsAndThreshold(bytes)" else "modulesAndThreshold(bytes)", message);
        defer self.provider.allocator.free(data);
        const result = try self.query(address, data);
        defer self.provider.allocator.free(result);
        return evm_source.decodeMembers(self.provider.allocator, result);
    }
    pub fn offchainVerifyInfo(self: Contracts, address: Address, message: protocol.Message) ![]u8 {
        const data = try messageCall(self.provider.allocator, "getOffchainVerifyInfo(bytes)", message);
        defer self.provider.allocator.free(data);
        // Return actual non-empty OffchainLookup revert bytes for the metadata
        // builder, rather than laundering them through an error string regex.
        return self.query(address, data);
    }
    pub fn offchainLookup(self: Contracts, a: A, address: Address, message: protocol.Message) !@import("../relayer/ccip.zig").Lookup {
        const bytes = try self.offchainVerifyInfo(address, message);
        defer self.provider.allocator.free(bytes);
        if (bytes.len == 0) return error.OffchainExpectedRevert;
        var lookup = try @import("../relayer/ccip.zig").decode(a, bytes);
        errdefer lookup.deinit();
        if (!std.mem.eql(u8, &lookup.sender, &address)) return error.OffchainSenderMismatch;
        return lookup;
    }
    fn verifyDirect(self: Contracts, address: Address, message: protocol.Message, bytes: []const u8) !u256 {
        const encoded = try message.encodeAlloc(self.provider.allocator);
        defer self.provider.allocator.free(encoded);
        const data = try abi.processCalldata(self.provider.allocator, bytes, encoded);
        defer self.provider.allocator.free(data);
        data[0..4].* = abi.selector("verify(bytes,bytes)");
        const result = try self.query(address, data);
        defer self.provider.allocator.free(result);
        if (!try abi.decodeBool(result)) return error.VerifyRejected;
        return try self.provider.estimateEnergy(try self.provider.trigger(null, address, data, 0));
    }
    pub fn verify(self: Contracts, address: Address, message: protocol.Message, bytes: []const u8) !u256 {
        var budget: usize = 100;
        return try self.verifyNode(address, message, bytes, 10, &budget) orelse error.VerifyRejected;
    }
    fn verifyNode(self: Contracts, address: Address, message: protocol.Message, bytes: []const u8, depth: usize, budget: *usize) anyerror!?u256 {
        if (depth == 0) return null;
        var current = address;
        for (0..10) |_| {
            if (budget.* == 0) return null;
            budget.* -= 1;
            if (self.verifyDirect(current, message, bytes)) |energy| return energy else |err| if (control(err)) return err;
            switch (try self.moduleType(current)) {
                .null_ism => {
                    if (self.provider.signer_address) |signer| {
                        if (self.addressQuery(current, &abi.selector("trustedRelayer()"))) |trusted| {
                            if (std.mem.eql(u8, &trusted, &signer)) return 0;
                        } else |err| if (control(err)) return err;
                    }
                    if (self.addressQuery(current, &abi.selector("recipient()"))) |recipient| {
                        if (std.mem.eql(u8, &recipient, message.recipient[12..]) and message.body.len >= 64) {
                            const amount = std.mem.readInt(u256, message.body[32..64], .big);
                            const level = self.integer(u256, current, &abi.selector("calculateCurrentLevel()")) catch |err| {
                                if (control(err)) return err;
                                return null;
                            };
                            if (amount <= level) return 0;
                        }
                    } else |err| if (control(err)) return err;
                },
                .routing => {
                    current = self.route(current, message) catch |err| {
                        if (control(err)) return err;
                        return null;
                    };
                    continue;
                },
                .aggregation => {
                    const members_value = self.members(current, message, false) catch |err| {
                        if (control(err)) return err;
                        return null;
                    };
                    defer self.provider.allocator.free(members_value.addresses);
                    if (members_value.addresses.len > 100) return null;
                    var valid: usize = 0;
                    for (members_value.addresses, 0..) |child, i| {
                        const sub = subMetadata(bytes, i) orelse continue;
                        const result = self.verifyNode(child, message, sub, depth - 1, budget) catch |err| blk: {
                            if (control(err)) return err;
                            break :blk null;
                        };
                        if (result != null) valid += 1;
                    }
                    if (valid >= members_value.threshold) return 0;
                },
                else => {},
            }
            return null;
        }
        return null;
    }
    pub fn announcedLocations(self: Contracts, announce: Address, validators: []const Address) !announce_abi.Locations {
        const a = self.provider.allocator;
        const data = try announce_abi.locationsCalldata(a, validators);
        defer a.free(data);
        const result = try self.query(announce, data);
        defer a.free(result);
        return announce_abi.decodeLocations(a, result, validators.len, .{});
    }
    pub fn announcement(self: Contracts, announce: Address, validator: Address, location: []const u8, signature: [65]u8) !tx.Trigger {
        const a = self.provider.allocator;
        const data = try announce_abi.announceCalldata(a, validator, location, signature);
        errdefer a.free(data);
        return self.provider.trigger(null, announce, data, 0);
    }
};

pub fn Source(comptime Origin: type) type {
    return struct {
        chain: Contracts,
        origin: *Origin,
        const Self = @This();
        pub fn moduleType(self: *Self, address: Address) !metadata.ModuleType {
            return self.chain.moduleType(address);
        }
        pub fn route(self: *Self, address: Address, message: protocol.Message) !Address {
            return self.chain.route(address, message);
        }
        pub fn members(self: *Self, address: Address, message: protocol.Message, validators: bool) !metadata.Members {
            return self.chain.members(address, message, validators);
        }
        pub fn verify(self: *Self, address: Address, message: protocol.Message, bytes: []const u8) !u256 {
            return self.chain.verify(address, message, bytes);
        }
        pub fn leafIndex(self: *Self, id: Hash) !?u32 {
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, validator: Address, index: u32) !?storage.SignedCheckpoint {
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: Address) !?u32 {
            return self.origin.latestIndex(validator);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.origin.proof(index, checkpoint);
        }
    };
}

pub fn bytesCall(a: A, signature: []const u8, bytes: []const u8) ![]u8 {
    const len = try std.math.add(usize, 68 + (32 - bytes.len % 32) % 32, bytes.len);
    const out = try a.alloc(u8, len);
    @memset(out, 0);
    out[0..4].* = abi.selector(signature);
    std.mem.writeInt(u256, out[4..36], 32, .big);
    std.mem.writeInt(u256, out[36..68], bytes.len, .big);
    @memcpy(out[68..][0..bytes.len], bytes);
    return out;
}
fn messageCall(a: A, signature: []const u8, message: protocol.Message) ![]u8 {
    const bytes = try message.encodeAlloc(a);
    defer a.free(bytes);
    return bytesCall(a, signature, bytes);
}
pub fn subMetadata(bytes: []const u8, index: usize) ?[]const u8 {
    const start = std.math.mul(usize, index, 8) catch return null;
    if (start > bytes.len or bytes.len - start < 8) return null;
    const from = std.mem.readInt(u32, bytes[start..][0..4], .big);
    const to = std.mem.readInt(u32, bytes[start + 4 ..][0..4], .big);
    if (from == 0 or from > to or to > bytes.len) return null;
    return bytes[from..to];
}
test "Tron strict nested announcement locations ABI and aggregation metadata bounds" {
    var bytes: [224]u8 = .{0} ** 224;
    std.mem.writeInt(u256, bytes[0..32], 32, .big);
    std.mem.writeInt(u256, bytes[32..64], 1, .big);
    std.mem.writeInt(u256, bytes[64..96], 32, .big);
    std.mem.writeInt(u256, bytes[96..128], 1, .big);
    std.mem.writeInt(u256, bytes[128..160], 32, .big);
    std.mem.writeInt(u256, bytes[160..192], 3, .big);
    @memcpy(bytes[192..195], "s3:");
    var result = try announce_abi.decodeLocations(std.testing.allocator, &bytes, 1, .{});
    defer result.deinit();
    try std.testing.expectEqualStrings("s3:", result.values[0][0]);
    bytes[223] = 1;
    try std.testing.expectError(error.InvalidAbi, announce_abi.decodeLocations(std.testing.allocator, &bytes, 1, .{}));
    bytes[223] = 0;
    bytes[95] = 64;
    try std.testing.expectError(error.InvalidAbi, announce_abi.decodeLocations(std.testing.allocator, &bytes, 1, .{}));
    try std.testing.expect(subMetadata("tiny", 0) == null);
    try std.testing.expect(subMetadata("tiny", std.math.maxInt(usize)) == null);
}

fn control(err: anyerror) bool {
    return metadata.hardFailure(err) or @import("../net/json_rpc.zig").isControl(err);
}
const ControlFixture = struct {
    calls: usize = 0,
    failure: anyerror,
    fn send(ctx: *anyopaque, _: A, _: @import("../cloud/http.zig").Request) !@import("../cloud/http.zig").Response {
        const self: *ControlFixture = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        return self.failure;
    }
};
test "Tron contract verify fallback preserves cooperative control before any module queries" {
    const a = std.testing.allocator;
    for ([_]anyerror{ error.PendingReadIo, error.OutOfMemory, error.RequestCancelled, error.RequestDeadlineExceeded }) |failure| {
        var fixture: ControlFixture = .{ .failure = failure };
        var provider_ = try p.Provider.init(a, .{ .context = &fixture, .send_fn = ControlFixture.send }, .{ .rpc_urls = &.{.{ .url = "https://fixture/rpc" }}, .wallet_urls = &.{.{ .url = "https://fixture/wallet" }}, .wallet_solidity_urls = &.{.{ .url = "https://fixture/solid" }} });
        const contract: Contracts = .{ .provider = &provider_, .mailbox = .{1} ** 20, .hook = .{2} ** 20, .domain = 1 };
        try std.testing.expectError(failure, contract.verify(.{3} ** 20, .{ .origin = 1, .destination = 2, .nonce = 0, .sender = .{1} ** 32, .recipient = .{2} ** 32, .body = "" }, ""));
        try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    }
}

test "Tron CCIP lookup preserves actual constant-result revert binds sender and rejects empty or malformed bytes" {
    const a = std.testing.allocator;
    const mock = @import("../cloud/testing.zig");
    var fixture = try std.json.parseFromSlice(std.json.Value, a, @embedFile("../relayer/testing/ccip-lookup.json"), .{});
    defer fixture.deinit();
    var encoded: std.ArrayList(u8) = .empty;
    defer encoded.deinit(a);
    for (fixture.value.object.get("chunks").?.array.items) |chunk| try encoded.appendSlice(a, chunk.string);
    const response = try std.json.Stringify.valueAlloc(a, .{ .result = .{ .code = "CONTRACT_EXE_ERROR", .message = "public fixture revert" }, .constant_result = .{encoded.items[2..]} }, .{});
    defer a.free(response);
    var network: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = response },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = response },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = "{\"constant_result\":[\"\"]}" },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = "{\"constant_result\":[\"00\"]}" },
    } };
    const endpoints = [_]@import("rpc.zig").Endpoint{.{ .url = "https://fixture/walletsolidity" }};
    var provider = try p.Provider.init(a, network.transport(), .{ .rpc_urls = &endpoints, .wallet_urls = &endpoints, .wallet_solidity_urls = &endpoints });
    const chain: Contracts = .{ .provider = &provider, .mailbox = .{0} ** 20, .hook = .{0} ** 20, .domain = 1 };
    var lookup = try chain.offchainLookup(a, .{3} ** 20, .{ .origin = 1, .destination = 2, .body = "public" });
    defer lookup.deinit();
    try std.testing.expectEqual(@as(Address, .{3} ** 20), lookup.sender);
    try std.testing.expectEqualStrings("https://ccs.example/{sender}/{data}", lookup.urls[0]);
    try std.testing.expectError(error.OffchainSenderMismatch, chain.offchainLookup(a, .{4} ** 20, .{ .origin = 1, .destination = 2 }));
    try std.testing.expectError(error.OffchainExpectedRevert, chain.offchainLookup(a, .{3} ** 20, .{ .origin = 1, .destination = 2 }));
    try std.testing.expectError(error.InvalidOffchainLookup, chain.offchainLookup(a, .{3} ** 20, .{ .origin = 1, .destination = 2 }));
    try network.expectDone();
}
