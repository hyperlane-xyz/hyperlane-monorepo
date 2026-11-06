//! Relayer origin history over the production DB contract and chunked prover.
//! Native Store remains the sole mutation owner for a domain. Network readers
//! use one process-wide checkpoint pool rather than a thread pool per chain.
const std = @import("std");
const native = @import("store.zig");
const protocol = @import("../protocol/root.zig");
const prover = @import("../relayer/prover.zig");
const checkpoints = @import("../relayer/checkpoint_pool.zig");
const remote = @import("../relayer/remote_checkpoints.zig");
const quorum = @import("../relayer/quorum.zig");
const objects = @import("../storage/objects.zig");
const metadata_session = @import("metadata_session.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
pub const Origin = struct {
    allocator: Allocator,
    store: *native.Store,
    domain: u32,
    hook: Hash,
    tree: prover.Prover,
    tree_generation: u64 = 0,
    checkpoint_pool: ?*remote.Engine,
    discovery: ?Discovery = null,
    observer: ?@import("../runtime/indexing_observer.zig").Observer = null,
    mutex: std.Thread.Mutex = .{},

    pub const Discovery = struct { context: *anyopaque, ensure: *const fn (*anyopaque, []const checkpoints.Address, ?*const std.atomic.Value(bool)) anyerror!void };

    pub fn init(allocator: Allocator, store: *native.Store, domain: u32, hook: Hash, checkpoint_pool: ?*remote.Engine) Origin {
        return .{ .allocator = allocator, .store = store, .domain = domain, .hook = hook, .tree = prover.Prover.init(allocator), .checkpoint_pool = checkpoint_pool };
    }
    pub fn deinit(self: *Origin) void {
        self.tree.deinit();
        self.* = undefined;
    }

    /// Caller holds both locks in origin→store order. Replaced canonical leaves
    /// invalidate every cached historical proof; bounded sync rebuilds them.
    fn invalidate(self: *Origin) void {
        if (self.tree_generation == self.store.tree_reset_generation) return;
        self.tree.deinit();
        self.tree = prover.Prover.init(self.allocator);
        self.tree_generation = self.store.tree_reset_generation;
    }

    pub fn sync(self: *Origin, limit: usize) !usize {
        if (limit == 0 or limit > 64) return error.InvalidProverSyncLimit;
        self.mutex.lock();
        defer self.mutex.unlock();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        self.invalidate();
        var added: usize = 0;
        while (added < limit and self.tree.count <= std.math.maxInt(u32)) {
            const index: u32 = @intCast(self.tree.count);
            const insertion = (try self.store.insertionByIndex(index)) orelse break;
            if (insertion.leaf_index != index) return error.StoredInsertionIndexMismatch;
            try self.tree.ingest(insertion.message_id);
            added += 1;
        }
        if (added > 0) if (self.observer) |sink| sink.notify(.{ .tree_ingested = @intCast(self.tree.count - 1) });
        return added;
    }

    pub fn leafIndex(self: *Origin, id: Hash) !?u32 {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        self.invalidate();
        const index = (try self.store.leafIndex(id)) orelse return null;
        if (index >= self.tree.count) return null;
        const path = try self.tree.proof(index, index);
        if (!std.mem.eql(u8, &path.leaf, &id)) return error.StoredReverseIndexMismatch;
        return index;
    }

    pub fn highestKnownLeafIndex(self: *Origin) !?u32 {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        self.invalidate();
        if (self.tree.count == 0) return null;
        return @intCast(self.tree.count - 1);
    }

    pub fn proof(self: *Origin, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        self.invalidate();
        if (checkpoint.mailbox_domain != self.domain or !std.mem.eql(u8, &checkpoint.merkle_tree_hook_address, &self.hook)) return error.WrongCheckpointContext;
        const signed_leaf = try self.tree.proof(checkpoint.index, checkpoint.index);
        if (!std.mem.eql(u8, &signed_leaf.leaf, &checkpoint.message_id)) return error.WrongCheckpointMessageId;
        const result = try self.tree.proof(index, checkpoint.index);
        if (!result.verify(checkpoint.root)) return error.MerkleRootMismatch;
        return result;
    }

    pub fn fetchQuorum(self: *Origin, allocator: Allocator, validators: []const checkpoints.Address, threshold: usize, index: u32, errors: *usize, cancel: ?*const std.atomic.Value(bool)) !?quorum.Quorum {
        if (self.discovery) |discover| try discover.ensure(discover.context, validators, cancel);
        const pool = self.checkpoint_pool orelse return null;
        return pool.fetchQuorum(self.domain, allocator, validators, threshold, index, errors, cancel);
    }
    pub fn fetchLatestIndices(self: *Origin, validators: []const checkpoints.Address, output: []?u32, errors: *usize, cancel: ?*const std.atomic.Value(bool)) !void {
        if (self.discovery) |discover| try discover.ensure(discover.context, validators, cancel);
        if (self.checkpoint_pool) |pool| return pool.latestIndices(self.domain, validators, output, errors, cancel);
        @memset(output, null);
    }
    pub fn fetchCheckpoint(self: *Origin, validator: checkpoints.Address, index: u32) !?objects.SignedCheckpoint {
        var errors: usize = 0;
        var selected = (try self.fetchQuorum(self.allocator, &.{validator}, 1, index, &errors, null)) orelse return null;
        defer selected.deinit();
        return .{ .value = selected.checkpoint, .signature = selected.signatures[0] };
    }
    pub fn latestIndex(self: *Origin, validator: checkpoints.Address) !?u32 {
        var output: [1]?u32 = undefined;
        var errors: usize = 0;
        try self.fetchLatestIndices(&.{validator}, &output, &errors, null);
        return output[0];
    }

    pub const MetadataSession = metadata_session.Session(Origin);
    pub fn forkMetadata(self: *Origin, allocator: Allocator, cancel: *const std.atomic.Value(bool)) !MetadataSession {
        return MetadataSession.init(allocator, self, cancel);
    }
};
