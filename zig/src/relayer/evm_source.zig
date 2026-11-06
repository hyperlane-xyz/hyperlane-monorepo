//! EVM metadata queries pinned to one block, with an injected origin/history
//! source. No signing or transaction broadcast occurs in this module.
const std = @import("std");
const evm = @import("../evm/root.zig");
const protocol = @import("../protocol/root.zig");
const storage = @import("../storage/root.zig");
const merkle = @import("../protocol/merkle.zig");
const metadata = @import("metadata.zig");
const ccip = @import("ccip.zig");
const read_replay = @import("../net/read_replay.zig");
const Address = [20]u8;

pub fn Source(comptime Origin: type) type {
    return struct {
        allocator: std.mem.Allocator,
        client: *evm.RpcClient,
        block_number: u64,
        origin: *Origin,
        mailbox: ?Address = null,
        observation: ?metadata.Observation = null,
        observation_clock: ?@import("../agents/operation.zig").ObservationClock = null,
        ccip_handler: ?ccip.Handler = null,
        cancel: ?*const std.atomic.Value(bool) = null,
        replay: ?read_replay.Replay = null,
        origin_session: ?(if (@hasDecl(Origin, "MetadataSession")) Origin.MetadataSession else void) = null,
        const Self = @This();
        pub const parallel_quorum = @hasDecl(Origin, "fetchQuorum");
        pub const parallel_latest = @hasDecl(Origin, "fetchLatestIndices");

        pub fn fork(self: *const Self, allocator: std.mem.Allocator, cancel: *const std.atomic.Value(bool)) !*Self {
            const forked = try allocator.create(Self);
            errdefer allocator.destroy(forked);
            const client = try allocator.create(evm.RpcClient);
            errdefer allocator.destroy(client);
            var options = self.client.options;
            options.cancel = cancel;
            client.* = try evm.RpcClient.init(allocator, self.client.url, options);
            errdefer client.deinit();
            forked.* = .{
                .allocator = allocator,
                .client = client,
                .block_number = self.block_number,
                .origin = self.origin,
                .mailbox = self.mailbox,
                .observation = self.observation,
                .observation_clock = self.observation_clock,
                .cancel = cancel,
            };
            if (options.async_pool) |pool| {
                // This retained child has its own logical replay owner, not
                // the direct caller's transient scope deadline.
                forked.client.options.owner_deadline_ns = null;
                const owned_fallback = pool.config.strategy == .fallback and pool.config.strategy.fallback.attempt_timeout_ms != null;
                forked.replay = try read_replay.Replay.init(allocator, pool, .{ .shared_budget = options.read_budget, .use_owner_timeout = owned_fallback });
                forked.client.options.exchange = forked.replay.?.interface();
            }
            errdefer if (forked.replay) |*replay| replay.deinit();
            if (@hasDecl(Origin, "forkMetadata")) {
                forked.origin_session = try self.origin.forkMetadata(allocator, cancel);
                if (forked.origin_session) |*session| {
                    session.shared_budget = options.read_budget;
                }
            }
            errdefer if (@hasDecl(Origin, "forkMetadata")) if (forked.origin_session) |*session| session.deinit();
            if (self.ccip_handler) |handler| forked.ccip_handler = try handler.fork(allocator, client, self.block_number, cancel);
            return forked;
        }

        pub fn deinitFork(self: *Self) void {
            const allocator = self.allocator;
            if (self.ccip_handler) |*handler| handler.deinit();
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| session.deinit();
            if (self.replay) |*replay| replay.deinit();
            self.client.deinit();
            allocator.destroy(self.client);
            allocator.destroy(self);
        }

        pub fn beginPass(self: *Self, cancel: *const std.atomic.Value(bool)) !void {
            if (self.replay) |*replay| try replay.beginPass(cancel);
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| session.beginPass(cancel) catch |err| {
                if (self.replay) |*replay| replay.endPass(err);
                return err;
            };
        }

        pub fn endPass(self: *Self, failure: ?anyerror) void {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| session.endPass(failure);
            if (self.replay) |*replay| replay.endPass(failure);
        }

        /// The clock value is copied into every owned Source fork. Its context
        /// belongs to the role, never to a metadata-builder stack frame.
        pub fn defaultIsmNow(self: *Self) !u64 {
            const clock = self.observation_clock orelse return error.DefaultIsmClockUnavailable;
            return (try clock.now()).monotonic_ms;
        }

        pub fn fetchQuorum(self: *Self, allocator: std.mem.Allocator, validators: []const Address, threshold: usize, index: u32, storage_errors: *usize) !?@import("quorum.zig").Quorum {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.fetchQuorum(allocator, validators, threshold, index, storage_errors);
            return self.origin.fetchQuorum(allocator, validators, threshold, index, storage_errors, self.cancel);
        }

        pub fn fetchLatestIndices(self: *Self, validators: []const Address, output: []?u32, storage_errors: *usize) !void {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.fetchLatestIndices(validators, output, storage_errors);
            if (@hasDecl(Origin, "fetchLatestIndices")) return self.origin.fetchLatestIndices(validators, output, storage_errors, self.cancel);
            if (validators.len != output.len) return error.InvalidLatestIndicesLength;
            for (validators, output) |validator, *latest| latest.* = self.origin.latestIndex(validator) catch |err| {
                if (metadata.hardFailure(err)) return err;
                storage_errors.* += 1;
                latest.* = null;
                continue;
            };
        }

        pub fn ccipMetadata(self: *Self, address: Address, message: protocol.Message) ![]u8 {
            return (self.ccip_handler orelse return error.CcipReadNotConfigured).fetch(address, message);
        }

        pub fn defaultIsm(self: *Self) !Address {
            const mailbox = self.mailbox orelse return error.DefaultIsmNotConfigured;
            const bytes = try self.client.ethCall(mailbox, &evm.codecs.selector("defaultIsm()"), .{ .number = self.block_number });
            defer self.allocator.free(bytes);
            return evm.codecs.addressWord(bytes);
        }

        pub fn moduleType(self: *Self, address: Address) !metadata.ModuleType {
            const bytes = try self.client.ethCall(address, &evm.codecs.selector("moduleType()"), .{ .number = self.block_number });
            defer self.allocator.free(bytes);
            const value = try evm.codecs.uintWord(u8, bytes);
            return std.meta.intToEnum(metadata.ModuleType, value) catch error.UnsupportedIsmType;
        }

        /// The Hyperlane CCIP contract deliberately reverts. Keep structured
        /// revert bytes instead of regex-extracting hexadecimal from a message.
        pub fn offchainLookup(self: *Self, address: Address, message: protocol.Message) !ccip.Lookup {
            const calldata = try callWithMessage(self.allocator, "getOffchainVerifyInfo(bytes)", message);
            defer self.allocator.free(calldata);
            const to = try evm.codecs.hexAlloc(self.allocator, &address);
            defer self.allocator.free(to);
            const data = try evm.codecs.hexAlloc(self.allocator, calldata);
            defer self.allocator.free(data);
            const block = try evm.codecs.quantityAlloc(self.allocator, self.block_number);
            defer self.allocator.free(block);
            var response = try self.client.callEnvelope("eth_call", .{ .{ .to = to, .data = data }, block });
            defer response.deinit();
            if (!response.isError()) return error.OffchainExpectedRevert;
            const raw = response.errorData() orelse return error.OffchainMissingRevertData;
            // Both direct geth data and the common nested `data` shape retain
            // type validation. No arbitrary error-string scans are used.
            const revert = if (raw == .object) raw.object.get("data") orelse return error.OffchainMissingRevertData else raw;
            if (revert != .string or revert.string.len < 2 or revert.string.len % 2 != 0 or revert.string.len > ccip.max_response_bytes * 2 + 2) return error.InvalidOffchainLookup;
            const bytes = try self.allocator.alloc(u8, (revert.string.len - 2) / 2);
            defer self.allocator.free(bytes);
            _ = try evm.codecs.decodeHex(bytes, revert.string);
            var lookup = try ccip.decode(self.allocator, bytes);
            errdefer lookup.deinit();
            if (!std.mem.eql(u8, &lookup.sender, &address)) return error.OffchainSenderMismatch;
            return lookup;
        }

        pub fn route(self: *Self, address: Address, message: protocol.Message) !Address {
            const calldata = try callWithMessage(self.allocator, "route(bytes)", message);
            defer self.allocator.free(calldata);
            const bytes = try self.client.ethCall(address, calldata, .{ .number = self.block_number });
            defer self.allocator.free(bytes);
            return evm.codecs.addressWord(bytes);
        }

        pub fn members(self: *Self, address: Address, message: protocol.Message, validators: bool) !metadata.Members {
            const calldata = try callWithMessage(self.allocator, if (validators) "validatorsAndThreshold(bytes)" else "modulesAndThreshold(bytes)", message);
            defer self.allocator.free(calldata);
            const bytes = try self.client.ethCall(address, calldata, .{ .number = self.block_number });
            defer self.allocator.free(bytes);
            return decodeMembers(self.allocator, bytes);
        }

        pub fn verify(self: *Self, address: Address, message: protocol.Message, bytes: []const u8) !u256 {
            const encoded = try message.encodeAlloc(self.allocator);
            defer self.allocator.free(encoded);
            const calldata = try evm.codecs.processCalldata(self.allocator, bytes, encoded);
            defer self.allocator.free(calldata);
            calldata[0..4].* = evm.codecs.selector("verify(bytes,bytes)");
            const result = try self.client.ethCall(address, calldata, .{ .number = self.block_number });
            defer self.allocator.free(result);
            if (!try evm.codecs.decodeBool(result)) return error.VerifyRejected;
            const to = try evm.codecs.hexAlloc(self.allocator, &address);
            defer self.allocator.free(to);
            const data = try evm.codecs.hexAlloc(self.allocator, calldata);
            defer self.allocator.free(data);
            const block = try evm.codecs.quantityAlloc(self.allocator, self.block_number);
            defer self.allocator.free(block);
            var response = try self.client.call("eth_estimateGas", .{ .{ .to = to, .data = data }, block });
            defer response.deinit();
            if (response.value() != .string) return error.InvalidGasEstimate;
            return try evm.codecs.quantity(response.value().string);
        }

        pub fn leafIndex(self: *Self, id: [32]u8) !?u32 {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.leafIndex(id);
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.highestKnownLeafIndex();
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, validator: Address, index: u32) !?storage.SignedCheckpoint {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.fetchCheckpoint(validator, index);
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: Address) !?u32 {
            if (@hasDecl(Origin, "forkMetadata")) if (self.origin_session) |*session| return session.latestIndex(validator);
            return self.origin.latestIndex(validator);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            const result = if (@hasDecl(Origin, "forkMetadata") and self.origin_session != null)
                self.origin_session.?.proof(index, checkpoint)
            else
                self.origin.proof(index, checkpoint);
            return result catch |err| {
                if (err == error.MerkleRootMismatch) if (self.observation) |observation| {
                    if (observation.merkle_mismatch_fn) |notify| notify(observation.context, checkpoint.mailbox_domain) catch {};
                };
                return err;
            };
        }
    };
}

fn callWithMessage(allocator: std.mem.Allocator, signature: []const u8, message: protocol.Message) ![]u8 {
    const encoded = try message.encodeAlloc(allocator);
    defer allocator.free(encoded);
    const padding = (32 - encoded.len % 32) % 32;
    const bytes = try allocator.alloc(u8, try std.math.add(usize, 68 + padding, encoded.len));
    @memset(bytes, 0);
    bytes[0..4].* = evm.codecs.selector(signature);
    std.mem.writeInt(u256, bytes[4..36], 32, .big);
    std.mem.writeInt(u256, bytes[36..68], encoded.len, .big);
    @memcpy(bytes[68..][0..encoded.len], encoded);
    return bytes;
}

pub fn decodeMembers(allocator: std.mem.Allocator, bytes: []const u8) !metadata.Members {
    if (bytes.len < 96 or bytes.len % 32 != 0) return error.InvalidMemberAbi;
    if (try evm.codecs.uintWord(usize, bytes[0..32]) != 64) return error.InvalidMemberAbi;
    const threshold = try evm.codecs.uintWord(u8, bytes[32..64]);
    const length = try evm.codecs.uintWord(usize, bytes[64..96]);
    if (length > 256 or length != (bytes.len - 96) / 32 or threshold == 0 or threshold > length) return error.InvalidMemberAbi;
    const addresses = try allocator.alloc(Address, length);
    errdefer allocator.free(addresses);
    for (addresses, 0..) |*address, i| address.* = try evm.codecs.addressWord(bytes[96 + i * 32 ..][0..32]);
    return .{ .addresses = addresses, .threshold = threshold };
}

pub const CheckpointStore = struct { validator: Address, store: *storage.LocalStore };

/// Local replay source. Leaves are the complete origin tree prefix starting at
/// index zero, not dispatch nonces. Database-backed sources implement the same
/// methods without retaining this complete leaf slice in memory.
pub const LocalOrigin = struct {
    allocator: std.mem.Allocator,
    leaves: []const [32]u8,
    stores: []const CheckpointStore,

    pub fn leafIndex(self: *LocalOrigin, id: [32]u8) !?u32 {
        for (self.leaves, 0..) |leaf, index| {
            if (std.mem.eql(u8, &leaf, &id)) return std.math.cast(u32, index) orelse error.TreeTooLarge;
        }
        return null;
    }
    pub fn highestKnownLeafIndex(self: *LocalOrigin) !?u32 {
        if (self.leaves.len == 0) return null;
        return std.math.cast(u32, self.leaves.len - 1) orelse error.TreeTooLarge;
    }
    pub fn fetchCheckpoint(self: *LocalOrigin, validator: Address, index: u32) !?storage.SignedCheckpoint {
        for (self.stores) |entry| {
            if (!std.mem.eql(u8, &entry.validator, &validator)) continue;
            var status = try entry.store.reorgStatus();
            defer status.deinit();
            if (status.exists) return error.ValidatorReorg;
            return entry.store.fetchCheckpoint(index);
        }
        return null;
    }
    pub fn latestIndex(self: *LocalOrigin, validator: Address) !?u32 {
        for (self.stores) |entry| {
            if (std.mem.eql(u8, &entry.validator, &validator)) return entry.store.latestIndex();
        }
        return null;
    }

    pub fn proof(self: *LocalOrigin, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
        if (index > checkpoint.index or checkpoint.index >= self.leaves.len) return error.UnknownMerkleLeaf;
        if (!std.mem.eql(u8, &self.leaves[checkpoint.index], &checkpoint.message_id)) return error.WrongCheckpointMessageId;
        const nodes = try self.allocator.dupe([32]u8, self.leaves[0 .. @as(usize, checkpoint.index) + 1]);
        defer self.allocator.free(nodes);
        var result: protocol.Proof = .{ .leaf = nodes[index], .index = index, .path = undefined };
        var width = nodes.len;
        var position: usize = index;
        for (0..32) |level| {
            const sibling = position ^ 1;
            result.path[level] = if (sibling < width) nodes[sibling] else protocol.zero_hashes[level];
            var parent: usize = 0;
            while (parent < (width + 1) / 2) : (parent += 1) {
                const left = nodes[parent * 2];
                const right = if (parent * 2 + 1 < width) nodes[parent * 2 + 1] else protocol.zero_hashes[level];
                nodes[parent] = merkle.hashConcat(left, right);
            }
            width = (width + 1) / 2;
            position >>= 1;
        }
        if (!result.verify(checkpoint.root)) return error.MerkleRootMismatch;
        return result;
    }
};

test "full-prefix proof authenticates every leaf and rejects a changed checkpoint" {
    const leaves = [_][32]u8{ @splat(1), @splat(2), @splat(3), @splat(4), @splat(5) };
    var origin: LocalOrigin = .{ .allocator = std.testing.allocator, .leaves = &leaves, .stores = &.{} };
    var tree = protocol.IncrementalMerkle.init();
    for (leaves, 0..) |leaf, index| {
        try tree.ingest(leaf);
        const checkpoint: protocol.Checkpoint = .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(1), .root = tree.root(), .index = @intCast(index), .message_id = leaf };
        for (0..index + 1) |message_index| {
            const path = try origin.proof(@intCast(message_index), checkpoint);
            try std.testing.expect(path.verify(checkpoint.root));
        }
        var changed = checkpoint;
        changed.root[0] ^= 1;
        try std.testing.expectError(error.MerkleRootMismatch, origin.proof(0, changed));
    }
}

test "member ABI bounds address width and threshold are strict" {
    var bytes: [160]u8 = @splat(0);
    std.mem.writeInt(u256, bytes[0..32], 64, .big);
    std.mem.writeInt(u256, bytes[32..64], 1, .big);
    std.mem.writeInt(u256, bytes[64..96], 2, .big);
    bytes[127] = 1;
    bytes[159] = 2;
    const members = try decodeMembers(std.testing.allocator, &bytes);
    defer std.testing.allocator.free(members.addresses);
    try std.testing.expectEqual(@as(usize, 2), members.addresses.len);
    try std.testing.expectEqual(@as(u8, 1), members.addresses[0][19]);
    bytes[96] = 1;
    try std.testing.expectError(error.InvalidAbi, decodeMembers(std.testing.allocator, &bytes));
    bytes[96] = 0;
    bytes[63] = 3;
    try std.testing.expectError(error.InvalidMemberAbi, decodeMembers(std.testing.allocator, &bytes));
}
