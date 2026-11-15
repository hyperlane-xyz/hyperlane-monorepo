//! Durable checkpoint service. One service owns a domain's validator namespace.
//! Every signing/publication transition is WAL-synced; endpoint failures retain
//! their configured vote slots. No bounded in-memory history or signing bitmap.
const std = @import("std");
const rocks = @import("../db/rocks.zig");
const protocol = @import("../protocol/root.zig");
const objects = @import("../storage/objects.zig");
pub const Consensus = @import("../runtime/validator.zig").Consensus;
pub const Hash = [32]u8;
pub const Checkpoint = protocol.Checkpoint;
/// All-zero hash represents unavailable header provenance (scraper stream or
/// latest-only VM). It must never compare as a conflicting known header.
pub const Observation = struct { message_id: Hash, block_height: u64, block_hash: Hash };
fn hashesConflict(a: Hash, b: Hash) bool {
    return !std.mem.allEqual(u8, &a, 0) and !std.mem.allEqual(u8, &b, 0) and !std.mem.eql(u8, &a, &b);
}
pub const Options = struct { halt_signal: ?*std.atomic.Value(bool) = null, readiness: ?*@import("validator/readiness.zig").State = null, domain_name: []const u8, domain: u32, hook: Hash, signer_address: [20]u8, endpoint_count: usize, consensus: ?Consensus = .majority, reorg_period: objects.ReorgPeriod = .none };
pub const Signer = struct {
    parallel_safe: bool = false,
    /// Signs in-process (local key): no network wait worth overlapping.
    in_process: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    context: *anyopaque,
    /// Local keys sign via VerifiedCheckpoint.signWith (zero recoveries);
    /// remote/KMS signers return VerifiedCheckpoint.recoverFrom (one).
    sign: *const fn (*anyopaque, Checkpoint) anyerror!Verified,
    sign_digest: ?*const fn (*anyopaque, Hash) anyerror![65]u8 = null,
    pub fn digest(self: Signer, hash: Hash) ![65]u8 {
        const f = self.sign_digest orelse return error.MissingDigestSigner;
        return f(self.context, hash);
    }
};
pub const Publisher = struct {
    parallel_safe: bool = false,
    /// Local files: writes serialize on the store, so overlap buys nothing.
    in_process: bool = false,
    context: *anyopaque,
    read_snapshot: ?*const fn (*anyopaque) anyerror!?objects.Snapshot = null,
    fetch_checkpoint: *const fn (*anyopaque, u32) anyerror!?objects.SignedCheckpoint,
    is_reorged: *const fn (*anyopaque) anyerror!bool,
    write_announcement: ?*const fn (*anyopaque, objects.SignedAnnouncement) anyerror!void = null,
    write_checkpoint: *const fn (*anyopaque, Verified, u64) anyerror!void,
    /// Optional same-directory batch: per-object data fsync + rename, then
    /// one directory fsync before returning (all or error).
    write_checkpoints: ?*const fn (*anyopaque, []const Verified, u64) anyerror!void = null,
    write_latest: *const fn (*anyopaque, u32) anyerror!void,
    write_snapshot: *const fn (*anyopaque, *const objects.Snapshot) anyerror!void,
    persist_reorg: *const fn (*anyopaque, objects.ReorgEvent) anyerror!void,
};
pub const Verified = @import("../storage/local.zig").VerifiedCheckpoint;
const namespace = "zig_validator_v1/";
const Record = struct { observation: Observation, root: Hash };
pub const Service = struct {
    allocator: std.mem.Allocator,
    typed: rocks.Typed,
    options: Options,
    tree: protocol.IncrementalMerkle = protocol.IncrementalMerkle.init(),
    verified_through: ?u32 = null,
    fresh_verified_through: ?u32 = null,
    signed_watermark: ?u32 = null,
    latest_published: ?u32 = null,
    halted: bool = false,
    bootstrap_index: ?u32 = null,
    repair_complete: bool = true,
    repair_waiting_for_insertion: ?u32 = null,
    snapshot_through: ?u32 = null,
    mutex: std.Thread.Mutex = .{},
    publication_workers: ?*PublicationWorkers = null,
    publication_running: bool = false,
    pending_reorg: ?objects.ReorgEvent = null,
    guard_local_pending: bool = false,
    guard_backend_pending: bool = false,
    pub fn deinit(self: *Service) void {
        if (self.publication_workers) |workers| {
            workers.deinit();
            self.allocator.destroy(workers);
        }
        self.publication_workers = null;
    }
    pub fn persistedHalt(a: std.mem.Allocator, database: *rocks.Database, domain_name: []const u8) !bool {
        const typed: rocks.Typed = .{ .database = database, .domain_name = domain_name };
        const prefix = try table(a, "halted");
        defer a.free(prefix);
        const bytes = try typed.get(a, prefix, "") orelse return false;
        defer a.free(bytes);
        if (bytes.len != 4) return error.InvalidValidatorRecord;
        return true;
    }
    pub fn open(a: std.mem.Allocator, database: *rocks.Database, options: Options) !Service {
        if (options.endpoint_count == 0) return error.EmptyEndpointPool;
        if (options.consensus) |c| _ = try c.required(options.endpoint_count);
        var self: Service = .{ .allocator = a, .typed = .{ .database = database, .domain_name = options.domain_name }, .options = options };
        var context: [56]u8 = undefined;
        std.mem.writeInt(u32, context[0..4], options.domain, .big);
        context[4..36].* = options.hook;
        context[36..56].* = options.signer_address;
        if (try self.get("context", "")) |old| {
            defer a.free(old);
            if (!std.mem.eql(u8, old, &context)) return error.ValidatorContextChanged;
        } else {
            var batch = try self.typed.batch(a);
            defer batch.deinit();
            try self.put(&batch, "context", "", &context);
            try batch.commitSync();
        }
        self.halted = (try self.number("halted")) != null;
        if (self.halted) if (options.halt_signal) |signal| signal.store(true, .release);
        self.bootstrap_index = try self.number("bootstrap-index");
        self.repair_complete = self.bootstrap_index == null or (try self.number("repair-complete")) != null;
        self.snapshot_through = try self.number("snapshot-through");
        self.verified_through = try self.number("verified");
        self.signed_watermark = try self.number("signed-watermark");
        self.latest_published = try self.number("latest");
        if (try self.get("frontier", "")) |bytes| {
            defer a.free(bytes);
            if (bytes.len < 4) return error.InvalidValidatorFrontier;
            const index = std.mem.readInt(u32, bytes[0..4], .big);
            const saved_record = try self.record(index) orelse return error.MissingValidatorHistory;
            self.tree = try protocol.IncrementalMerkle.restore(bytes[4..], index, saved_record.root);
        }
        if (self.verified_through) |index| {
            if (index >= self.tree.count) return error.InvalidVerifiedWatermark;
        }
        if (self.signed_watermark) |index| {
            const signed = try self.signedCheckpoint(index) orelse return error.MissingSignedHistory;
            _ = try self.verifyStored(signed);
        }
        if (try self.reservation()) |reserved| {
            try self.validateReservation(reserved);
        }
        return self;
    }
    fn table(a: std.mem.Allocator, name: []const u8) ![]u8 {
        return std.mem.concat(a, u8, &.{ namespace, name, "/" });
    }
    fn get(self: *Service, name: []const u8, key: []const u8) !?[]u8 {
        const p = try table(self.allocator, name);
        defer self.allocator.free(p);
        return self.typed.get(self.allocator, p, key);
    }
    fn put(self: *Service, batch: *rocks.TypedBatch, name: []const u8, key: []const u8, value: []const u8) !void {
        const p = try table(self.allocator, name);
        defer self.allocator.free(p);
        try batch.put(p, key, value);
    }
    fn delete(self: *Service, batch: *rocks.TypedBatch, name: []const u8, key: []const u8) !void {
        const p = try table(self.allocator, name);
        defer self.allocator.free(p);
        try batch.delete(p, key);
    }
    fn number(self: *Service, name: []const u8) !?u32 {
        const bytes = try self.get(name, "") orelse return null;
        defer self.allocator.free(bytes);
        if (bytes.len != 4) return error.InvalidValidatorRecord;
        return std.mem.readInt(u32, bytes[0..4], .big);
    }
    fn putNumber(self: *Service, batch: *rocks.TypedBatch, name: []const u8, n: u32) !void {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, n, .big);
        try self.put(batch, name, "", &bytes);
    }
    fn indexKey(index: u32) [4]u8 {
        var key: [4]u8 = undefined;
        std.mem.writeInt(u32, &key, index, .big);
        return key;
    }
    fn record(self: *Service, index: u32) !?Record {
        const bytes = try self.get("history", &indexKey(index)) orelse return null;
        defer self.allocator.free(bytes);
        if (bytes.len != 104) return error.InvalidValidatorRecord;
        return .{ .observation = .{ .message_id = bytes[0..32].*, .block_height = std.mem.readInt(u64, bytes[32..40], .big), .block_hash = bytes[40..72].* }, .root = bytes[72..104].* };
    }
    pub fn checkpoint(self: *Service, index: u32) !Checkpoint {
        const r = try self.record(index) orelse return error.UnknownCheckpoint;
        return .{ .mailbox_domain = self.options.domain, .merkle_tree_hook_address = self.options.hook, .root = r.root, .index = index, .message_id = r.observation.message_id };
    }
    fn encodeCheckpoint(c: Checkpoint) [104]u8 {
        var out: [104]u8 = undefined;
        std.mem.writeInt(u32, out[0..4], c.mailbox_domain, .big);
        out[4..36].* = c.merkle_tree_hook_address;
        out[36..68].* = c.root;
        std.mem.writeInt(u32, out[68..72], c.index, .big);
        out[72..104].* = c.message_id;
        return out;
    }
    fn decodeCheckpoint(bytes: []const u8) !Checkpoint {
        if (bytes.len != 104) return error.InvalidValidatorRecord;
        return .{ .mailbox_domain = std.mem.readInt(u32, bytes[0..4], .big), .merkle_tree_hook_address = bytes[4..36].*, .root = bytes[36..68].*, .index = std.mem.readInt(u32, bytes[68..72], .big), .message_id = bytes[72..104].* };
    }
    fn same(a: Checkpoint, b: Checkpoint) bool {
        return std.meta.eql(a, b);
    }
    fn validateReservation(self: *Service, c: Checkpoint) !void {
        const verified = self.verified_through orelse return error.UnverifiedReservation;
        if (c.index > verified or !same(c, try self.checkpoint(c.index))) return error.ReservationChanged;
    }
    pub fn reservation(self: *Service) !?Checkpoint {
        const bytes = try self.get("reservation", "") orelse return null;
        defer self.allocator.free(bytes);
        return try decodeCheckpoint(bytes);
    }
    pub fn signedCheckpoint(self: *Service, index: u32) !?objects.SignedCheckpoint {
        const bytes = try self.get("signed", &indexKey(index)) orelse return null;
        defer self.allocator.free(bytes);
        return try objects.SignedCheckpoint.parse(self.allocator, bytes);
    }
    /// Raw signed bytes (validator DB or publisher reads): one recovery.
    fn verifyStored(self: *Service, signed: objects.SignedCheckpoint) !Verified {
        if (!same(signed.value, try self.checkpoint(signed.value.index))) return error.SignedCheckpointChanged;
        return Verified.recoverFrom(signed, self.options.signer_address);
    }
    /// Already verified (signing path or one recovery): no recovery. The
    /// established signer must still be this validator's configured address.
    fn verifySigned(self: *Service, verified: Verified) !void {
        if (!same(verified.signed.value, try self.checkpoint(verified.signed.value.index))) return error.SignedCheckpointChanged;
        try verified.require(self.options.signer_address);
    }
    /// Reads a publisher's existing object for this index: one recovery.
    /// Another signer's object is not ours (null); an invalid one is an error.
    fn existingOwn(self: *Service, stored: objects.SignedCheckpoint) !?Verified {
        return Verified.recoverFrom(stored, self.options.signer_address) catch |err| if (err == error.WrongSigner) null else err;
    }
    pub fn observe(self: *Service, index: u32, observation: Observation, finalized_height: u64) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (observation.block_height > finalized_height) return error.UnfinalizedObservation;
        if (index < self.tree.count) {
            const old = try self.record(index) orelse return error.MissingValidatorHistory;
            const provenance_known = self.bootstrap_index == null or index > self.bootstrap_index.?;
            if (!std.mem.eql(u8, &old.observation.message_id, &observation.message_id) or (provenance_known and (old.observation.block_height != observation.block_height or hashesConflict(old.observation.block_hash, observation.block_hash)))) {
                if (self.verified_through == null or index > self.verified_through.?) return error.UnverifiedSuffixChanged;
                try self.halt(index, old.root, try self.replacementRoot(index, observation.message_id), 0);
                return error.FinalizedHistoryConflict;
            }
            return;
        }
        if (index != self.tree.count) return error.MissingInsertion;
        if (index > 0) {
            const old = try self.record(index - 1) orelse return error.MissingValidatorHistory;
            if (observation.block_height < old.observation.block_height) return error.NonmonotonicHistory;
            if (observation.block_height == old.observation.block_height and hashesConflict(observation.block_hash, old.observation.block_hash)) {
                if (self.verified_through == null or index - 1 > self.verified_through.?) return error.UnverifiedSuffixChanged;
                try self.halt(index - 1, old.root, old.root, 0);
                return error.FinalizedHistoryConflict;
            }
        }
        var next = self.tree;
        try next.ingest(observation.message_id);
        var bytes: [104]u8 = undefined;
        bytes[0..32].* = observation.message_id;
        std.mem.writeInt(u64, bytes[32..40], observation.block_height, .big);
        bytes[40..72].* = observation.block_hash;
        bytes[72..104].* = next.root();
        var frontier: [4 + protocol.IncrementalMerkle.snapshot_len]u8 = undefined;
        frontier[0..4].* = indexKey(index);
        frontier[4..].* = next.snapshot();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, "history", &indexKey(index), &bytes);
        try self.put(&batch, "snapshot", &indexKey(index), &next.snapshot());
        try self.put(&batch, "unpublished", &indexKey(index), "");
        try self.put(&batch, "frontier", "", &frontier);
        try batch.commitSync();
        self.tree = next;
    }
    /// Appends new leaves tree.count.. with observe()'s checks in ONE durable
    /// commit (one WAL fsync per driver tick instead of one per leaf). The
    /// accepted prefix is committed before an invalid leaf's error is
    /// returned, exactly as consecutive observe() calls would leave it.
    pub fn observeNew(self: *Service, first: u32, observations: []const Observation, finalized_height: u64) !usize {
        if (observations.len == 0) return 0;
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (first != self.tree.count) return error.MissingInsertion;
        var previous: ?Record = if (first > 0) try self.record(first - 1) orelse return error.MissingValidatorHistory else null;
        var next = self.tree;
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        var accepted: usize = 0;
        var failure: ?anyerror = null;
        var halt_previous = false;
        for (observations, 0..) |observation, offset| {
            const index = first + @as(u32, @intCast(offset));
            if (observation.block_height > finalized_height) {
                failure = error.UnfinalizedObservation;
                break;
            }
            if (previous) |old| {
                if (observation.block_height < old.observation.block_height) {
                    failure = error.NonmonotonicHistory;
                    break;
                }
                if (observation.block_height == old.observation.block_height and hashesConflict(observation.block_hash, old.observation.block_hash)) {
                    if (self.verified_through == null or index - 1 > self.verified_through.?) {
                        failure = error.UnverifiedSuffixChanged;
                    } else halt_previous = true;
                    break;
                }
            }
            try next.ingest(observation.message_id);
            var bytes: [104]u8 = undefined;
            bytes[0..32].* = observation.message_id;
            std.mem.writeInt(u64, bytes[32..40], observation.block_height, .big);
            bytes[40..72].* = observation.block_hash;
            bytes[72..104].* = next.root();
            try self.put(&batch, "history", &indexKey(index), &bytes);
            try self.put(&batch, "snapshot", &indexKey(index), &next.snapshot());
            try self.put(&batch, "unpublished", &indexKey(index), "");
            previous = .{ .observation = observation, .root = next.root() };
            accepted += 1;
        }
        if (accepted > 0) {
            var frontier: [4 + protocol.IncrementalMerkle.snapshot_len]u8 = undefined;
            frontier[0..4].* = indexKey(first + @as(u32, @intCast(accepted)) - 1);
            frontier[4..].* = next.snapshot();
            try self.put(&batch, "frontier", "", &frontier);
            try batch.commitSync();
            self.tree = next;
        }
        if (halt_previous) {
            // Only the first leaf can conflict with a verified committed leaf.
            const old = previous.?;
            try self.halt(first - 1, old.root, old.root, 0);
            return error.FinalizedHistoryConflict;
        }
        if (failure) |err| return err;
        return accepted;
    }
    /// Discard only observations beyond the last RPC-authenticated committed
    /// prefix. Signed objects/reservations/publication state can never be removed.
    pub fn resetUnverifiedSuffix(self: *Service) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        self.fresh_verified_through = null;
        const first: u32 = if (self.verified_through) |n| n + 1 else 0;
        if (self.tree.count <= first) return false;
        if (self.signed_watermark) |n| {
            if (n >= first) return error.CannotResetSignedPrefix;
        }
        var tree = protocol.IncrementalMerkle.init();
        var frontier: [4 + protocol.IncrementalMerkle.snapshot_len]u8 = undefined;
        if (self.verified_through) |index| {
            const bytes = try self.get("snapshot", &indexKey(index)) orelse return error.MissingValidatorSnapshot;
            defer self.allocator.free(bytes);
            const checkpoint_ = try self.checkpoint(index);
            tree = try protocol.IncrementalMerkle.restore(bytes, index, checkpoint_.root);
            frontier[0..4].* = indexKey(index);
            frontier[4..].* = tree.snapshot();
        }
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        for ([_][]const u8{ "history", "snapshot", "unpublished" }) |name| {
            const prefix = try table(self.allocator, name);
            defer self.allocator.free(prefix);
            try batch.deleteAtOrAfter(prefix, &indexKey(first));
        }
        if (self.verified_through != null) try self.put(&batch, "frontier", "", &frontier) else try self.delete(&batch, "frontier", "");
        try batch.commitSync();
        self.tree = tree;
        return true;
    }
    fn replacementRoot(self: *Service, index: u32, message_id: Hash) !Hash {
        var tree = protocol.IncrementalMerkle.init();
        if (index > 0) {
            const previous = try self.checkpoint(index - 1);
            const bytes = try self.get("snapshot", &indexKey(index - 1)) orelse return error.MissingValidatorSnapshot;
            defer self.allocator.free(bytes);
            tree = try protocol.IncrementalMerkle.restore(bytes, index - 1, previous.root);
        }
        try tree.ingest(message_id);
        return tree.root();
    }
    fn halt(self: *Service, index: u32, local: Hash, canonical: Hash, unix_timestamp: u64) !void {
        self.halted = true;
        if (self.options.halt_signal) |signal| signal.store(true, .release);
        self.guard_backend_pending = true;
        // Keep the complete guard before allocation or I/O can fail. Ordinary
        // operation remains halted while the retained owner retries persistence.
        if (self.pending_reorg == null) self.pending_reorg = .{ .local_merkle_root = local, .canonical_merkle_root = canonical, .checkpoint_index = index, .unix_timestamp = unix_timestamp, .reorg_period = self.options.reorg_period };
        self.guard_local_pending = true;
        try self.persistGuardUnlocked();
    }
    fn persistGuardUnlocked(self: *Service) !void {
        if (!self.guard_local_pending) return;
        self.persistGuardAttempt() catch |err| {
            std.log.warn("validator reorg guard persistence pending: {s}", .{@errorName(err)});
            return error.ReorgGuardPersistencePending;
        };
        self.guard_local_pending = false;
    }
    fn persistGuardAttempt(self: *Service) !void {
        if (@import("builtin").is_test) _ = TestGuardFault.attempts.fetchAdd(1, .acq_rel);
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        const index = if (self.pending_reorg) |event| event.checkpoint_index else self.signed_watermark orelse self.verified_through orelse 0;
        try self.putNumber(&batch, "halted", index);
        const json = if (self.pending_reorg) |event| try event.toJson(self.allocator) else null;
        defer if (json) |bytes| self.allocator.free(bytes);
        if (json) |bytes| try self.put(&batch, "reorg", "", bytes);
        if (@import("builtin").is_test) if (TestGuardFault.before.swap(false, .acq_rel)) return error.InjectedGuardCommitFailure;
        try batch.commitSync();
        if (@import("builtin").is_test) if (TestGuardFault.after.swap(false, .acq_rel)) return error.InjectedGuardCommitOutcomeUnknown;
        // A successful retry performs another fsync even if an uncertain prior
        // write is visible: read visibility alone does not establish durability.
        if (try self.number("halted") != index) return error.GuardReadbackMismatch;
        if (json) |expected| {
            const actual = try self.get("reorg", "") orelse return error.GuardReadbackMismatch;
            defer self.allocator.free(actual);
            if (!std.mem.eql(u8, actual, expected)) return error.GuardReadbackMismatch;
        }
    }
    pub fn retryLocalGuard(self: *Service) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.persistGuardUnlocked();
    }
    pub fn hasUnpersistedGuard(self: *Service) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.guard_local_pending or self.guard_backend_pending or self.pending_reorg != null;
    }
    /// A trusted canonical-history check below any signed index is fail-closed.
    pub fn verifyCommitted(self: *Service, index: u32, canonical: Hash, unix_timestamp: u64) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        const committed = self.verified_through orelse self.signed_watermark orelse return;
        if (index > committed) return;
        const local = try self.checkpoint(index);
        if (!std.mem.eql(u8, &local.root, &canonical)) {
            try self.halt(index, local.root, canonical, unix_timestamp);
            return error.FinalizedHistoryConflict;
        }
    }
    fn matches(self: *Service, c: Checkpoint) !bool {
        if (c.mailbox_domain != self.options.domain or !std.mem.eql(u8, &c.merkle_tree_hook_address, &self.options.hook)) return false;
        const local = self.checkpoint(c.index) catch |err| {
            if (err == error.UnknownCheckpoint) return false;
            return err;
        };
        return std.mem.eql(u8, &local.root, &c.root);
    }
    pub fn invalidateAuthorization(self: *Service) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.fresh_verified_through = null;
    }
    /// Quorum authorization plus the serial path's single reservation.
    pub fn authorize(self: *Service, votes: []const ?Checkpoint, unix_timestamp: u64) !?Checkpoint {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.authorizeUnlocked(votes, unix_timestamp);
        return self.reserveNextUnlocked();
    }
    /// Quorum authorization only: batch publication durably reserves its own
    /// indices, so the driver skips the legacy single-reservation WAL commit.
    pub fn authorizeQuorum(self: *Service, votes: []const ?Checkpoint, unix_timestamp: u64) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.authorizeUnlocked(votes, unix_timestamp);
    }
    fn authorizeUnlocked(self: *Service, votes: []const ?Checkpoint, unix_timestamp: u64) !void {
        if (self.halted) return error.ValidatorHalted;
        self.fresh_verified_through = null;
        if (votes.len != self.options.endpoint_count) return error.EndpointPoolChanged;
        const required = if (self.options.consensus) |c| try c.required(votes.len) else 1;
        var matching: std.array_list.Managed(u32) = .init(self.allocator);
        defer matching.deinit();
        for (votes) |vote| {
            const c = vote orelse continue;
            if (c.mailbox_domain != self.options.domain or !std.mem.eql(u8, &c.merkle_tree_hook_address, &self.options.hook)) continue;
            if (try self.matches(c)) {
                try matching.append(c.index);
                continue;
            }
            if (self.verified_through orelse self.signed_watermark) |watermark| {
                if (c.index <= watermark) {
                    var conflicts: usize = 0;
                    for (votes) |other| {
                        if (other) |o| {
                            if (o.index == c.index and o.mailbox_domain == c.mailbox_domain and std.mem.eql(u8, &o.merkle_tree_hook_address, &c.merkle_tree_hook_address) and std.mem.eql(u8, &o.root, &c.root)) conflicts += 1;
                        }
                    }
                    if (conflicts >= required) {
                        const local = try self.checkpoint(c.index);
                        try self.halt(c.index, local.root, c.root, unix_timestamp);
                        return error.FinalizedHistoryConflict;
                    }
                }
            }
        }
        if (matching.items.len >= required) {
            std.mem.sort(u32, matching.items, {}, std.sort.desc(u32));
            const target = matching.items[required - 1];
            self.fresh_verified_through = target;
            if (self.verified_through == null or target > self.verified_through.?) {
                var batch = try self.typed.batch(self.allocator);
                defer batch.deinit();
                try self.putNumber(&batch, "verified", target);
                try batch.commitSync();
                self.verified_through = target;
            }
        }
    }
    fn reserveNextUnlocked(self: *Service) !?Checkpoint {
        if (try self.reservation()) |r| {
            try self.validateReservation(r);
            return r;
        }
        const target = self.verified_through orelse return null;
        const candidate = try self.pendingAtOrBelow("unpublished", target);
        const repaired = if (self.repair_complete) try self.pendingAtOrBelow("repair-unpublished", target) else null;
        const index = if (candidate) |c| if (repaired) |r| @max(c, r) else c else repaired orelse return null;
        const c = try self.checkpoint(index);
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, "reservation", "", &encodeCheckpoint(c));
        try batch.commitSync();
        return c;
    }
    pub fn publishReorg(self: *Service, publisher: Publisher) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.publishReorgUnlocked(publisher);
    }
    fn publishReorgUnlocked(self: *Service, publisher: Publisher) !void {
        try self.persistGuardUnlocked();
        const bytes = try self.get("reorg", "") orelse return;
        defer self.allocator.free(bytes);
        var event = try objects.ReorgEvent.parse(self.allocator, bytes);
        defer event.deinit();
        publisher.persist_reorg(publisher.context, event.value) catch |err| {
            // Retain the structured event across transient object fsync/network
            // errors; an existing local WAL guard also survives process restart.
            self.guard_backend_pending = true;
            std.log.warn("validator backend reorg guard persistence pending: {s}", .{@errorName(err)});
            return error.ReorgGuardPersistencePending;
        };
        self.pending_reorg = null;
        self.guard_backend_pending = false;
    }
    /// Each call publishes at most limit indices (source configuration cap1000). Signatures and
    /// reservations survive a crash; all external writes must be idempotent.
    pub fn publishNext(self: *Service, signer: Signer, publisher: Publisher, unix_timestamp: u64, limit: usize) !usize {
        try self.beginPublication();
        defer self.endPublication();
        return self.publishSerial(signer, publisher, unix_timestamp, limit);
    }
    fn publishSerial(self: *Service, signer: Signer, publisher: Publisher, unix_timestamp: u64, limit: usize) !usize {
        var submission_buffer: [80]u8 = undefined;
        var operation: ?[]const u8 = "checkpoint_backend_guard";
        errdefer if (self.options.readiness) |status| if (operation) |name| status.blocked(name) catch |err| std.log.warn("validator readiness update failed: {s}", .{@errorName(err)});
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) {
            try self.publishReorgUnlocked(publisher);
            return error.ValidatorHalted;
        }
        if (try publisher.is_reorged(publisher.context)) {
            const index = self.signed_watermark orelse self.verified_through orelse 0;
            const local = if (self.tree.count > index) (try self.checkpoint(index)).root else self.tree.root();
            try self.halt(index, local, local, unix_timestamp);
            return error.ValidatorHalted;
        }
        if (self.options.readiness) |status| status.ready("checkpoint_backend_guard");
        operation = null;
        if (limit == 0 or limit > 1000) return error.InvalidPublicationLimit;
        var count: usize = 0;
        publication: while (count < limit) {
            const candidate = try self.reserveNextUnlocked() orelse break;
            operation = try std.fmt.bufPrint(&submission_buffer, "checkpoint_submission[{d}]", .{candidate.index});
            try self.validateReservation(candidate);
            if (try self.get("reservations", &indexKey(candidate.index))) |reserved| {
                defer self.allocator.free(reserved);
                if (!same(try decodeCheckpoint(reserved), candidate)) return error.ReservationChanged;
            }
            const signed: Verified = if (try self.signedCheckpoint(candidate.index)) |stored| try self.verifyStored(stored) else blk: {
                var existing: ?Verified = null;
                if (try publisher.fetch_checkpoint(publisher.context, candidate.index)) |stored| {
                    const own = try self.existingOwn(stored);
                    const same_context = stored.value.mailbox_domain == candidate.mailbox_domain and std.mem.eql(u8, &stored.value.merkle_tree_hook_address, &candidate.merkle_tree_hook_address);
                    if (own != null and same_context) {
                        if (!same(stored.value, candidate)) {
                            try self.halt(candidate.index, candidate.root, stored.value.root, unix_timestamp);
                            try self.publishReorgUnlocked(publisher);
                            return error.FinalizedHistoryConflict;
                        }
                        existing = own;
                    }
                }
                if (existing == null and (self.fresh_verified_through == null or candidate.index > self.fresh_verified_through.?)) {
                    if (count > 0) break :publication;
                    return error.FreshAuthorizationRequired;
                }
                const value = existing orelse try self.signSerial(signer, candidate);
                try self.verifySigned(value);
                if (!same(value.signed.value, candidate)) return error.SignerChangedCheckpoint;
                const json = try value.signed.toJson(self.allocator);
                defer self.allocator.free(json);
                var batch = try self.typed.batch(self.allocator);
                defer batch.deinit();
                try self.put(&batch, "signed", &indexKey(candidate.index), json);
                const watermark = if (self.signed_watermark) |w| @max(w, candidate.index) else candidate.index;
                try self.putNumber(&batch, "signed-watermark", watermark);
                try batch.commitSync();
                self.signed_watermark = watermark;
                break :blk value;
            };
            try self.verifySigned(signed);
            try publisher.write_checkpoint(publisher.context, signed, unix_timestamp);
            if (self.options.readiness) |status| status.ready(operation.?);
            operation = "checkpoint_latest_index";
            const latest = if (self.latest_published) |old| @max(old, candidate.index) else candidate.index;
            try publisher.write_latest(publisher.context, latest);
            if (self.options.readiness) |status| status.ready("checkpoint_latest_index");
            operation = "checkpoint_snapshot";
            const covered = try self.coveredAfter(candidate.index, latest);
            if (covered) try self.writeSnapshot(publisher, latest);
            if (self.options.readiness) |status| status.ready("checkpoint_snapshot");
            operation = "checkpoint_persistence";
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try self.delete(&batch, "unpublished", &indexKey(candidate.index));
            try self.delete(&batch, "repair-unpublished", &indexKey(candidate.index));
            if (covered) try self.putNumber(&batch, "snapshot-through", latest);
            try self.delete(&batch, "reservation", "");
            try self.delete(&batch, "reservations", &indexKey(candidate.index));
            try self.putNumber(&batch, "latest", latest);
            try batch.commitSync();
            self.latest_published = latest;
            if (covered) self.snapshot_through = latest;
            if (self.options.readiness) |status| status.ready("checkpoint_persistence");
            operation = null;
            count += 1;
        }
        try self.snapshotIfCovered(publisher);
        return count;
    }
    fn snapshotIfCovered(self: *Service, publisher: Publisher) !void {
        var operation: []const u8 = "checkpoint_latest_index";
        errdefer if (self.options.readiness) |status| status.blocked(operation) catch {};
        if (self.latest_published) |latest| {
            if (self.snapshot_through == null or self.snapshot_through.? < latest) {
                if (try self.coveredAfter(null, latest)) {
                    try publisher.write_latest(publisher.context, latest);
                    if (self.options.readiness) |status| status.ready("checkpoint_latest_index");
                    operation = "checkpoint_snapshot";
                    try self.writeSnapshot(publisher, latest);
                    var batch = try self.typed.batch(self.allocator);
                    defer batch.deinit();
                    try self.putNumber(&batch, "snapshot-through", latest);
                    try batch.commitSync();
                    self.snapshot_through = latest;
                    if (self.options.readiness) |status| status.ready("checkpoint_snapshot");
                }
            }
        }
    }
    /// Persistent helpers for adapters whose calls wait on network I/O (KMS
    /// signing, cloud objects). Threads are spawned lazily, never beyond the
    /// configured limit, and reused for every later batch. The coordinator
    /// drains jobs itself: at most `limit` runners (it plus helpers) at once.
    /// Only as many helpers as there are spare jobs are signalled; there is
    /// no broadcast and no per-job wake.
    pub const PublicationWorkers = struct {
        allocator: std.mem.Allocator,
        mutex: std.Thread.Mutex = .{},
        wake: std.Thread.Condition = .{},
        idle: std.Thread.Condition = .{},
        threads: std.ArrayList(std.Thread) = .empty,
        task: ?Task = null,
        next: std.atomic.Value(usize) = .init(0),
        /// Helper slots still claimable for the current task.
        tickets: usize = 0,
        /// Helpers currently draining the current task.
        helping: usize = 0,
        stopping: bool = false,
        const Task = struct { context: *anyopaque, count: usize, run: *const fn (*anyopaque, usize) void };
        fn run(self: *PublicationWorkers, task: Task, limit: usize) void {
            if (task.count == 0) return;
            const helpers = @min(task.count, limit) - 1;
            self.threads.ensureTotalCapacity(self.allocator, helpers) catch {};
            while (self.threads.items.len < @min(helpers, self.threads.capacity)) {
                const thread = std.Thread.spawn(.{ .stack_size = 256 * 1024, .allocator = self.allocator }, worker, .{self}) catch break;
                self.threads.appendAssumeCapacity(thread);
            }
            const available = @min(helpers, self.threads.items.len);
            self.next.store(0, .monotonic);
            if (available > 0) {
                self.mutex.lock();
                self.task = task;
                self.tickets = available;
                for (0..available) |_| self.wake.signal();
                self.mutex.unlock();
            }
            drain(&self.next, task);
            if (available > 0) {
                self.mutex.lock();
                defer self.mutex.unlock();
                // Unclaimed slots are revoked; every claimed one has finished
                // before the jobs slice can be released by the caller.
                self.tickets = 0;
                while (self.helping > 0) self.idle.wait(&self.mutex);
                self.task = null;
            }
        }
        fn drain(next: *std.atomic.Value(usize), task: Task) void {
            while (true) {
                const index = next.fetchAdd(1, .monotonic);
                if (index >= task.count) return;
                task.run(task.context, index);
            }
        }
        fn worker(self: *PublicationWorkers) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            while (true) {
                while (!self.stopping and self.tickets == 0) self.wake.wait(&self.mutex);
                if (self.stopping) return;
                self.tickets -= 1;
                self.helping += 1;
                const task = self.task.?;
                self.mutex.unlock();
                drain(&self.next, task);
                self.mutex.lock();
                self.helping -= 1;
                if (self.helping == 0 and self.tickets == 0) self.idle.signal();
            }
        }
        pub fn threadCount(self: *const PublicationWorkers) usize {
            return self.threads.items.len;
        }
        fn deinit(self: *PublicationWorkers) void {
            self.mutex.lock();
            self.stopping = true;
            self.wake.broadcast();
            self.mutex.unlock();
            for (self.threads.items) |thread| thread.join();
            self.threads.deinit(self.allocator);
        }
    };
    const Step = enum { submission, latest, persistence };
    const PublicationJob = struct {
        checkpoint: Checkpoint,
        signed: ?Verified = null,
        /// Obtained this batch (signer or own backend object): WAL-record it.
        record: bool = false,
        may_sign: bool = false,
        conflict_root: ?Hash = null,
        latest_written: bool = false,
        written: bool = false,
        /// False while an in-process signer's reservation is still pending
        /// in the batch's signature commit.
        reserved: bool = true,
        result: ?anyerror = null,
    };
    /// One publication batch. Service-state transitions run on the caller
    /// under one mutex hold per phase with one WAL commit each; only the
    /// adapter calls (fetch/sign, then write) fan out, and only to helpers
    /// when the adapters wait on network I/O.
    const PublicationBatch = struct {
        service: *Service,
        signer: Signer,
        publisher: Publisher,
        timestamp: u64,
        highest: u32,
        jobs: []PublicationJob,
        snapshot_failure: ?anyerror = null,
        fn fail(self: *PublicationBatch, job: *PublicationJob, err: anyerror, step: Step) void {
            job.result = err;
            const status = self.service.options.readiness orelse return;
            var buffer: [80]u8 = undefined;
            const operation = switch (step) {
                .submission => std.fmt.bufPrint(&buffer, "checkpoint_submission[{d}]", .{job.checkpoint.index}) catch unreachable,
                .latest => "checkpoint_latest_index",
                .persistence => "checkpoint_persistence",
            };
            status.blocked(operation) catch |e| std.log.warn("validator readiness update failed: {s}", .{@errorName(e)});
        }
        /// Jobs whose signature or reservation rode in a failed commit.
        fn failRecorded(self: *PublicationBatch, err: anyerror) void {
            for (self.jobs) |*job| if (job.result == null and (job.record or !job.reserved)) self.fail(job, err, .submission);
        }
        fn retires(self: *const PublicationBatch, index: u32) bool {
            for (self.jobs) |job| if (job.result == null and job.written and job.checkpoint.index == index) return true;
            return false;
        }
        fn failLive(self: *PublicationBatch, err: anyerror, step: Step) void {
            for (self.jobs) |*job| if (job.result == null) self.fail(job, err, step);
        }
        fn cancelled(self: *const PublicationBatch) bool {
            const cancel = self.signer.cancel orelse return false;
            return cancel.load(.acquire);
        }
        fn resolveAt(context: *anyopaque, index: usize) void {
            const self: *PublicationBatch = @ptrCast(@alignCast(context));
            const job = &self.jobs[index];
            if (job.result != null or job.signed != null) return;
            self.resolve(job) catch |err| self.fail(job, err, .submission);
        }
        /// Adopt this signer's existing backend object or sign; no service
        /// mutex unless a signing attempt must be retried.
        fn resolve(self: *PublicationBatch, job: *PublicationJob) !void {
            if (self.cancelled()) return error.RequestCancelled;
            if (try self.publisher.fetch_checkpoint(self.publisher.context, job.checkpoint.index)) |stored| {
                const own = try self.service.existingOwn(stored);
                const context = stored.value.mailbox_domain == job.checkpoint.mailbox_domain and std.mem.eql(u8, &stored.value.merkle_tree_hook_address, &job.checkpoint.merkle_tree_hook_address);
                if (own != null and context) {
                    if (!same(stored.value, job.checkpoint)) {
                        job.conflict_root = stored.value.root;
                        return error.FinalizedHistoryConflict;
                    }
                    job.signed = own;
                    job.record = true;
                    return;
                }
            }
            if (!job.may_sign) return error.FreshAuthorizationRequired;
            job.signed = try self.sign(job);
            job.record = true;
        }
        fn sign(self: *PublicationBatch, job: *PublicationJob) !Verified {
            var failure: anyerror = error.SignatureUnavailable;
            // Source performs five direct attempts then its singleton fallback. Our
            // pinned signer is already the sole identity; the final attempt retains
            // that same authority rather than introducing another credential chain.
            // The first attempt is gated by the caller's phase check.
            for (0..6) |attempt| {
                if (attempt > 0) {
                    std.Thread.sleep(100 * std.time.ns_per_ms);
                    if (self.cancelled()) return error.RequestCancelled;
                    self.service.mutex.lock();
                    defer self.service.mutex.unlock();
                    try self.service.jobGate(job, true);
                }
                return self.signer.sign(self.signer.context, job.checkpoint) catch |err| {
                    failure = err;
                    continue;
                };
            }
            return failure;
        }
        fn writeAt(context: *anyopaque, index: usize) void {
            const self: *PublicationBatch = @ptrCast(@alignCast(context));
            const job = &self.jobs[index];
            if (job.result != null) return;
            self.write(job) catch |err| self.fail(job, err, if (job.written) .latest else .submission);
        }
        /// Checkpoint object first; the batch's highest index then publishes
        /// the latest pointer before lower indices complete (latest-first).
        fn write(self: *PublicationBatch, job: *PublicationJob) !void {
            if (self.cancelled()) return error.RequestCancelled;
            try self.publisher.write_checkpoint(self.publisher.context, job.signed.?, self.timestamp);
            job.written = true;
            if (self.service.options.readiness) |status| {
                var buffer: [80]u8 = undefined;
                status.ready(std.fmt.bufPrint(&buffer, "checkpoint_submission[{d}]", .{job.checkpoint.index}) catch unreachable);
            }
            if (job.checkpoint.index != self.highest) return;
            if (self.cancelled()) return error.RequestCancelled;
            const availability = blk: {
                self.service.mutex.lock();
                defer self.service.mutex.unlock();
                try self.service.jobGate(job, false);
                break :blk @max(self.service.latest_published orelse self.highest, self.highest);
            };
            try self.publisher.write_latest(self.publisher.context, availability);
            job.latest_written = true;
            if (self.service.options.readiness) |status| status.ready("checkpoint_latest_index");
        }
        fn forEach(self: *PublicationBatch, workers: ?*PublicationWorkers, limit: usize, run: *const fn (*anyopaque, usize) void) void {
            if (workers) |pool| return pool.run(.{ .context = self, .count = self.jobs.len, .run = run }, limit);
            for (0..self.jobs.len) |index| run(self, index);
        }
    };
    fn ensurePublicationWorkers(self: *Service) !*PublicationWorkers {
        if (self.publication_workers) |workers| return workers;
        const workers = try self.allocator.create(PublicationWorkers);
        workers.* = .{ .allocator = self.allocator };
        self.publication_workers = workers;
        return workers;
    }
    /// Owned immutable/native adapters may overlap signing and publication.
    /// Coordinator state and every signature are WAL-synced under the service
    /// mutex. The caller must join this method before refreshing leases or
    /// releasing adapters, transports, cancellation tokens or the database.
    fn beginPublication(self: *Service) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.publication_running) return error.PublicationAlreadyRunning;
        self.publication_running = true;
    }
    fn endPublication(self: *Service) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.publication_running = false;
    }
    /// Publishes up to `limit` reserved indices as one batch: reservations,
    /// fresh signatures and completions are each one WAL commit. In-process
    /// adapters (local key, local files) run on the caller: their calls are
    /// CPU or serialize on the store, so helper threads would only add
    /// handoffs. Network-bound parallel-safe adapters overlap up to `limit`.
    pub fn publishConcurrent(self: *Service, signer: Signer, publisher: Publisher, timestamp: u64, limit: usize) !usize {
        if (limit == 0 or limit > 1000) return error.InvalidPublicationLimit;
        try self.beginPublication();
        defer self.endPublication();
        // An in-process signature cannot leave the process before the batch's
        // signature commit, so its reservations ride in that same commit. A
        // remote signer's reservations are durable before any signing request.
        const candidates = try self.reservePublicationBatch(limit, !signer.in_process);
        defer self.allocator.free(candidates);
        if (candidates.len == 0) return self.publishSerial(signer, publisher, timestamp, limit);
        // At most `limit` (max_sign_concurrency) jobs per batch: a pooled
        // batch's sign-then-write barrier waits on at most that many signatures.
        const pooled = candidates.len > 1 and limit > 1 and signer.parallel_safe and publisher.parallel_safe and !(signer.in_process and publisher.in_process);
        return self.publishBatch(signer, publisher, timestamp, limit, candidates, if (pooled) try self.ensurePublicationWorkers() else null);
    }
    fn publishBatch(self: *Service, signer: Signer, publisher: Publisher, timestamp: u64, limit: usize, candidates: []const Checkpoint, workers: ?*PublicationWorkers) !usize {
        const jobs = try self.allocator.alloc(PublicationJob, candidates.len);
        defer self.allocator.free(jobs);
        var highest: u32 = 0;
        for (jobs, candidates) |*job, candidate| {
            job.* = .{ .checkpoint = candidate, .reserved = !signer.in_process };
            highest = @max(highest, candidate.index);
        }
        var batch: PublicationBatch = .{ .service = self, .signer = signer, .publisher = publisher, .timestamp = timestamp, .highest = highest, .jobs = jobs };
        if (batch.cancelled()) return error.RequestCancelled;
        const reorged = publisher.is_reorged(publisher.context) catch |err| {
            if (self.options.readiness) |status| status.blocked("checkpoint_backend_guard") catch |e| std.log.warn("validator readiness update failed: {s}", .{@errorName(e)});
            return err;
        };
        if (reorged) {
            self.mutex.lock();
            defer self.mutex.unlock();
            try self.haltFromBackend();
            return error.ValidatorHalted;
        }
        if (self.options.readiness) |status| status.ready("checkpoint_backend_guard");
        {
            // Durable signatures are reused; signing is allowed only within
            // the fresh quorum authorization.
            self.mutex.lock();
            defer self.mutex.unlock();
            for (jobs) |*job| {
                self.prepareJob(job) catch |err| batch.fail(job, err, .submission);
            }
        }
        batch.forEach(workers, limit, PublicationBatch.resolveAt);
        self.recordSignatures(&batch);
        if (publisher.in_process) {
            if (publisher.write_checkpoints) |many| self.writeInProcess(&batch, many) else batch.forEach(null, limit, PublicationBatch.writeAt);
        } else batch.forEach(workers, limit, PublicationBatch.writeAt);
        const published = self.completePublications(&batch);
        self.mutex.lock();
        const halted = self.halted;
        self.mutex.unlock();
        if (halted) {
            try self.publishReorg(publisher);
            return error.ValidatorHalted;
        }
        // All adapter callbacks have actually returned before snapshot creation
        // or any error escapes. A deadline never grants early context reuse.
        for (jobs) |job| if (job.result) |err| return err;
        if (batch.snapshot_failure) |err| return err;
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.snapshotIfCovered(publisher);
        return published;
    }
    /// Highest index first (object, then latest pointer), then every lower
    /// object in one store batch that ends with a single directory fsync.
    /// Nothing below depends on a lower object until that call returns.
    fn writeInProcess(self: *Service, batch: *PublicationBatch, many: *const fn (*anyopaque, []const Verified, u64) anyerror!void) void {
        for (batch.jobs, 0..) |job, index| if (job.checkpoint.index == batch.highest) PublicationBatch.writeAt(batch, index);
        const lower = self.allocator.alloc(Verified, batch.jobs.len) catch |err| {
            for (batch.jobs) |*job| if (job.result == null and !job.written) batch.fail(job, err, .submission);
            return;
        };
        defer self.allocator.free(lower);
        var count: usize = 0;
        for (batch.jobs) |job| if (job.result == null and !job.written) {
            lower[count] = job.signed.?;
            count += 1;
        };
        if (count == 0) return;
        const written = if (batch.cancelled()) error.RequestCancelled else many(batch.publisher.context, lower[0..count], batch.timestamp);
        for (batch.jobs) |*job| if (job.result == null and !job.written) {
            if (written) |_| {
                job.written = true;
                if (self.options.readiness) |status| {
                    var buffer: [80]u8 = undefined;
                    status.ready(std.fmt.bufPrint(&buffer, "checkpoint_submission[{d}]", .{job.checkpoint.index}) catch unreachable);
                }
            } else |err| batch.fail(job, err, .submission);
        };
    }
    /// publicationGate, except that a reservation still pending in this
    /// batch's signature commit is checked in memory (reservePublicationBatch
    /// validated any older durable one against the same checkpoint).
    fn jobGate(self: *Service, job: *const PublicationJob, require_fresh: bool) !void {
        if (job.reserved) return self.publicationGate(job.checkpoint, require_fresh);
        if (self.halted) return error.ValidatorHalted;
        try self.validateReservation(job.checkpoint);
        if (require_fresh) {
            const fresh = self.fresh_verified_through orelse return error.FreshAuthorizationRequired;
            if (job.checkpoint.index > fresh) return error.FreshAuthorizationRequired;
        }
    }
    fn prepareJob(self: *Service, job: *PublicationJob) !void {
        if (try self.signedCheckpoint(job.checkpoint.index)) |stored| job.signed = try self.verifyStored(stored);
        try self.jobGate(job, false);
        if (self.fresh_verified_through) |fresh| job.may_sign = job.checkpoint.index <= fresh;
    }
    /// Every signature obtained this batch is durable (one WAL commit) before
    /// any of them is published. A conflicting own object halts instead.
    fn recordSignatures(self: *Service, batch: *PublicationBatch) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (batch.jobs) |*job| if (job.conflict_root) |root| {
            self.halt(job.checkpoint.index, job.checkpoint.root, root, batch.timestamp) catch |err| {
                job.result = err;
            };
            break;
        };
        var wal = self.typed.batch(self.allocator) catch |err| {
            batch.failLive(err, .submission);
            return;
        };
        defer wal.deinit();
        var watermark = self.signed_watermark;
        var pending: usize = 0;
        for (batch.jobs) |*job| {
            if (job.result != null) continue;
            self.recordSignature(&wal, job, &watermark) catch |err| {
                batch.fail(job, err, .submission);
                continue;
            };
            if (job.record or !job.reserved) pending += 1;
        }
        if (pending == 0) return;
        if (@import("builtin").is_test) if (TestPublicationFault.before_signatures.swap(false, .acq_rel)) return batch.failRecorded(error.InjectedSignatureCommitFailure);
        self.commitSignatures(&wal, watermark) catch |err| return batch.failRecorded(err);
        self.signed_watermark = watermark;
        for (batch.jobs) |*job| if (job.result == null) {
            job.reserved = true;
        };
    }
    fn commitSignatures(self: *Service, wal: *rocks.TypedBatch, watermark: ?u32) !void {
        if (watermark) |value| try self.putNumber(wal, "signed-watermark", value);
        try wal.commitSync();
    }
    fn recordSignature(self: *Service, wal: *rocks.TypedBatch, job: *PublicationJob, watermark: *?u32) !void {
        try self.jobGate(job, false);
        const signed = job.signed.?;
        try self.verifySigned(signed);
        if (!same(signed.signed.value, job.checkpoint)) return error.SignerChangedCheckpoint;
        if (!job.reserved) try self.put(wal, "reservations", &indexKey(job.checkpoint.index), &encodeCheckpoint(job.checkpoint));
        if (!job.record) return;
        const wire = try signed.signed.toJson(self.allocator);
        defer self.allocator.free(wire);
        try self.put(wal, "signed", &indexKey(job.checkpoint.index), wire);
        watermark.* = @max(watermark.* orelse 0, job.checkpoint.index);
    }
    /// One WAL commit retires every written index (and advances latest when
    /// the highest index's pointer was published).
    fn completePublications(self: *Service, batch: *PublicationBatch) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (@import("builtin").is_test) if (TestPublicationFault.before_completion.swap(false, .acq_rel)) {
            batch.failLive(error.InjectedCompletionFailure, .persistence);
            return 0;
        };
        var wal = self.typed.batch(self.allocator) catch |err| {
            batch.failLive(err, .persistence);
            return 0;
        };
        defer wal.deinit();
        const legacy = self.reservation() catch |err| {
            batch.failLive(err, .persistence);
            return 0;
        };
        var latest = self.latest_published;
        var pointer_written = false;
        var completed: usize = 0;
        for (batch.jobs) |*job| {
            if (job.result != null) continue;
            self.retire(&wal, job, legacy) catch |err| {
                batch.fail(job, err, .persistence);
                continue;
            };
            if (job.latest_written) {
                latest = @max(latest orelse 0, batch.highest);
                pointer_written = true;
            }
            completed += 1;
        }
        if (completed == 0) return 0;
        const snapshot = if (pointer_written) self.snapshotInBatch(batch, latest) else null;
        self.commitCompletions(&wal, latest, snapshot) catch |err| {
            batch.failLive(err, .persistence);
            return 0;
        };
        self.latest_published = latest;
        if (self.options.readiness) |status| status.ready("checkpoint_persistence");
        if (snapshot) |index| {
            self.snapshot_through = index;
            if (self.options.readiness) |status| status.ready("checkpoint_snapshot");
        }
        return completed;
    }
    /// The batch just published the latest pointer. When every index at or
    /// below it is either already complete or retired by this batch (all of
    /// whose objects are durable), the snapshot is written now and its
    /// snapshot-through rides in the completion commit.
    fn snapshotInBatch(self: *Service, batch: *PublicationBatch, latest: ?u32) ?u32 {
        const target = latest orelse return null;
        if (self.snapshot_through) |through| if (through >= target) return null;
        const covered = self.coveredByBatch(batch, target) catch |err| {
            batch.snapshot_failure = err;
            return null;
        };
        if (!covered) return null;
        self.writeSnapshot(batch.publisher, target) catch |err| {
            batch.snapshot_failure = err;
            if (self.options.readiness) |status| status.blocked("checkpoint_snapshot") catch |e| std.log.warn("validator readiness update failed: {s}", .{@errorName(e)});
            return null;
        };
        return target;
    }
    fn coveredByBatch(self: *Service, batch: *const PublicationBatch, target: u32) !bool {
        if (!self.repair_complete) return false;
        for ([_][]const u8{ "unpublished", "repair-unpublished" }) |name| {
            var upper = target;
            while (try self.pendingAtOrBelow(name, upper)) |pending| {
                if (!batch.retires(pending)) return false;
                if (pending == 0) break;
                upper = pending - 1;
            }
        }
        return true;
    }
    fn commitCompletions(self: *Service, wal: *rocks.TypedBatch, latest: ?u32, snapshot: ?u32) !void {
        if (latest) |value| try self.putNumber(wal, "latest", value);
        if (snapshot) |value| try self.putNumber(wal, "snapshot-through", value);
        try wal.commitSync();
    }
    fn retire(self: *Service, wal: *rocks.TypedBatch, job: *PublicationJob, legacy: ?Checkpoint) !void {
        try self.jobGate(job, false);
        const key = indexKey(job.checkpoint.index);
        try self.delete(wal, "unpublished", &key);
        try self.delete(wal, "repair-unpublished", &key);
        try self.delete(wal, "reservations", &key);
        if (legacy) |reserved| if (reserved.index == job.checkpoint.index) try self.delete(wal, "reservation", "");
    }
    /// `durable`: commit the reservations now. Otherwise the caller carries
    /// them in its signature commit (in-process signers only).
    fn reservePublicationBatch(self: *Service, limit: usize, durable: bool) ![]Checkpoint {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        const target = self.verified_through orelse return self.allocator.alloc(Checkpoint, 0);
        if (try self.reservation()) |legacy| try self.validateReservation(legacy);
        var candidates: std.ArrayList(Checkpoint) = .empty;
        errdefer candidates.deinit(self.allocator);
        var upper = target;
        while (candidates.items.len < limit) {
            const regular = try self.pendingAtOrBelow("unpublished", upper);
            const repair = if (self.repair_complete) try self.pendingAtOrBelow("repair-unpublished", upper) else null;
            const index = if (regular) |r| if (repair) |v| @max(r, v) else r else repair orelse break;
            const candidate = try self.checkpoint(index);
            try self.validateReservation(candidate);
            if (try self.get("reservations", &indexKey(index))) |old| {
                defer self.allocator.free(old);
                if (!same(try decodeCheckpoint(old), candidate)) return error.ReservationChanged;
            }
            try candidates.append(self.allocator, candidate);
            if (index == 0) break;
            upper = index - 1;
        }
        if (durable and candidates.items.len > 0) {
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            for (candidates.items) |candidate| try self.put(&batch, "reservations", &indexKey(candidate.index), &encodeCheckpoint(candidate));
            try batch.commitSync();
        }
        return candidates.toOwnedSlice(self.allocator);
    }
    fn publicationGate(self: *Service, candidate: Checkpoint, require_fresh: bool) !void {
        if (self.halted) return error.ValidatorHalted;
        try self.validateReservation(candidate);
        const reservation_bytes = try self.get("reservations", &indexKey(candidate.index)) orelse return error.MissingSigningReservation;
        defer self.allocator.free(reservation_bytes);
        if (!same(try decodeCheckpoint(reservation_bytes), candidate)) return error.ReservationChanged;
        if (require_fresh and (self.fresh_verified_through == null or candidate.index > self.fresh_verified_through.?)) return error.FreshAuthorizationRequired;
    }
    fn signSerial(self: *Service, signer: Signer, checkpoint_: Checkpoint) !Verified {
        var failure: anyerror = error.SignatureUnavailable;
        for (0..6) |attempt| {
            if (attempt > 0) std.Thread.sleep(100 * std.time.ns_per_ms);
            if (signer.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            if (self.halted) return error.ValidatorHalted;
            try self.validateReservation(checkpoint_);
            if (self.fresh_verified_through == null or checkpoint_.index > self.fresh_verified_through.?) return error.FreshAuthorizationRequired;
            const value = signer.sign(signer.context, checkpoint_) catch |err| {
                failure = err;
                continue;
            };
            return value;
        }
        return failure;
    }
    /// The accumulated tree can extend beyond the quorum-committed prefix.
    /// Source wake/cadence decisions inspect the next committed leaf, not just
    /// the end of an unverified replay accumulated from a faster minority.
    pub fn nextVerificationIndex(self: *const Service) u32 {
        return if (self.verified_through) |index| @min(index + 1, self.tree.count) else 0;
    }
    /// Source idle loops skip signature revalidation only after every covered
    /// publication and snapshot is durable. Failed latest/snapshot writes and
    /// missing bootstrap history must continue retrying without a new WS event.
    pub fn hasPendingPublication(self: *Service) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.repair_complete) return true;
        if (self.verified_through) |target| {
            if (try self.pendingAtOrBelow("unpublished", target) != null or try self.pendingAtOrBelow("repair-unpublished", target) != null) return true;
        }
        if (self.latest_published) |latest| if (self.snapshot_through == null or self.snapshot_through.? < latest) return true;
        return false;
    }
    fn pendingAtOrBelow(self: *Service, name: []const u8, target: u32) !?u32 {
        const prefix = try table(self.allocator, name);
        defer self.allocator.free(prefix);
        var entry = try self.typed.atOrBefore(self.allocator, prefix, &indexKey(target)) orelse return null;
        defer entry.deinit();
        if (entry.key.len != 4) return error.InvalidValidatorRecord;
        return std.mem.readInt(u32, entry.key[0..4], .big);
    }
    fn coveredAfter(self: *Service, current: ?u32, target: u32) !bool {
        if (!self.repair_complete) return false;
        for ([_][]const u8{ "unpublished", "repair-unpublished" }) |name| {
            var upper = target;
            while (try self.pendingAtOrBelow(name, upper)) |pending| {
                if (current == null or pending != current.?) return false;
                if (pending == 0) break;
                upper = pending - 1;
            }
        }
        return true;
    }
    fn writeSnapshot(self: *Service, publisher: Publisher, index: u32) !void {
        const bytes = try self.get("snapshot", &indexKey(index)) orelse return error.MissingValidatorSnapshot;
        defer self.allocator.free(bytes);
        const local = try self.checkpoint(index);
        const tree = try protocol.IncrementalMerkle.restore(bytes, index, local.root);
        const snapshot = try objects.Snapshot.capture(&tree);
        try publisher.write_snapshot(publisher.context, &snapshot);
    }
    pub fn checkBackendGuard(self: *Service, publisher: Publisher) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (try publisher.is_reorged(publisher.context)) {
            try self.haltFromBackend();
            return error.ValidatorHalted;
        }
    }
    fn haltFromBackend(self: *Service) !void {
        self.halted = true;
        if (self.options.halt_signal) |signal| signal.store(true, .release);
        self.guard_local_pending = true;
        try self.persistGuardUnlocked();
    }
    fn validateExternal(self: *Service, signed: objects.SignedCheckpoint, index: u32) !void {
        if (signed.value.index != index or signed.value.mailbox_domain != self.options.domain or !std.mem.eql(u8, &signed.value.merkle_tree_hook_address, &self.options.hook)) return error.SnapshotCheckpointMismatch;
        if (!std.mem.eql(u8, &try signed.recover(), &self.options.signer_address)) return error.SnapshotSignerMismatch;
    }
    fn putRecord(self: *Service, batch: *rocks.TypedBatch, index: u32, observation: Observation, root: Hash) !void {
        var bytes: [104]u8 = undefined;
        bytes[0..32].* = observation.message_id;
        std.mem.writeInt(u64, bytes[32..40], observation.block_height, .big);
        bytes[40..72].* = observation.block_hash;
        bytes[72..104].* = root;
        try self.put(batch, "history", &indexKey(index), &bytes);
    }
    /// A validated remote frontier starts live processing immediately. Coverage
    /// is deliberately UNKNOWN: bounded history repair scans every older index.
    pub fn bootstrap(self: *Service, publisher: Publisher) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (self.tree.count != 0) return false;
        const reader = publisher.read_snapshot orelse return false;
        if (try publisher.is_reorged(publisher.context)) {
            try self.haltFromBackend();
            return error.ValidatorHalted;
        }
        const snapshot = try reader(publisher.context) orelse return false;
        const signed = try publisher.fetch_checkpoint(publisher.context, snapshot.index) orelse return error.SnapshotCheckpointMissing;
        try self.validateExternal(signed, snapshot.index);
        const tree = try snapshot.authenticatedRestore(signed, self.options.signer_address, self.options.domain, self.options.hook);
        const json = try signed.toJson(self.allocator);
        defer self.allocator.free(json);
        var frontier: [4 + protocol.IncrementalMerkle.snapshot_len]u8 = undefined;
        frontier[0..4].* = indexKey(snapshot.index);
        frontier[4..].* = snapshot.tree;
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.putRecord(&batch, snapshot.index, .{ .message_id = signed.value.message_id, .block_height = 0, .block_hash = @splat(0) }, snapshot.root);
        try self.put(&batch, "signed", &indexKey(snapshot.index), json);
        try self.put(&batch, "snapshot", &indexKey(snapshot.index), &snapshot.tree);
        try self.put(&batch, "frontier", "", &frontier);
        try self.putNumber(&batch, "bootstrap-index", snapshot.index);
        try self.putNumber(&batch, "repair-cursor", 0);
        try self.putNumber(&batch, "signed-watermark", snapshot.index);
        try self.putNumber(&batch, "verified", snapshot.index);
        try self.putNumber(&batch, "latest", snapshot.index);
        try batch.commitSync();
        self.tree = tree;
        self.bootstrap_index = snapshot.index;
        self.repair_complete = false;
        self.signed_watermark = snapshot.index;
        self.verified_through = snapshot.index;
        self.latest_published = snapshot.index;
        return true;
    }
    /// Authenticate an older root needed by a stale RPC slot without trusting
    /// raw local cache data or shrinking the configured endpoint denominator.
    pub fn authenticateStoredHistory(self: *Service, index: u32, publisher: Publisher) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (try self.record(index) != null) return true;
        const anchor = self.bootstrap_index orelse return false;
        if (index > anchor) return false;
        const signed = try publisher.fetch_checkpoint(publisher.context, index) orelse return false;
        try self.validateExternal(signed, index);
        const json = try signed.toJson(self.allocator);
        defer self.allocator.free(json);
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.putRecord(&batch, index, .{ .message_id = signed.value.message_id, .block_height = 0, .block_hash = @splat(0) }, signed.value.root);
        try self.put(&batch, "signed", &indexKey(index), json);
        try batch.commitSync();
        return true;
    }
    /// Reconstruct a snapshot's entire prefix before signing any missing old
    /// checkpoint. Existing same-key objects supply leaves; holes use finalized
    /// indexed observations. All holes stay staged until the anchor root matches.
    pub fn repairHistory(self: *Service, publisher: Publisher, source_context: *anyopaque, insertion: *const fn (*anyopaque, u32, u64) anyerror!?Observation, finalized_height: ?u64, limit: usize, timestamp: u64) !usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.halted) return error.ValidatorHalted;
        if (limit == 0 or limit > 64) return error.InvalidTickLimit;
        self.repair_waiting_for_insertion = null;
        if (self.repair_complete) return 0;
        const anchor = self.bootstrap_index orelse return error.InvalidRepairState;
        const anchor_checkpoint = try self.checkpoint(anchor);
        var cursor = try self.number("repair-cursor") orelse return error.InvalidRepairState;
        var tree = protocol.IncrementalMerkle.init();
        if (cursor > 0) {
            const bytes = try self.get("repair-frontier", "") orelse return error.InvalidRepairState;
            defer self.allocator.free(bytes);
            const previous = try self.checkpoint(cursor - 1);
            tree = try protocol.IncrementalMerkle.restore(bytes, cursor - 1, previous.root);
        }
        var processed: usize = 0;
        while (cursor <= anchor and processed < limit) {
            var existing = try publisher.fetch_checkpoint(publisher.context, cursor);
            var remote_present = false;
            if (existing) |signed| {
                const signer = try signed.recover();
                if (signed.value.index == cursor and signed.value.mailbox_domain == self.options.domain and std.mem.eql(u8, &signed.value.merkle_tree_hook_address, &self.options.hook) and std.mem.eql(u8, &signer, &self.options.signer_address)) remote_present = true else existing = null;
            }
            if (existing == null) existing = try self.signedCheckpoint(cursor);
            if (existing) |signed| try self.validateExternal(signed, cursor);
            var observation: Observation = undefined;
            if (existing) |signed| observation = .{ .message_id = signed.value.message_id, .block_height = 0, .block_hash = @splat(0) } else {
                const height = finalized_height orelse break;
                observation = try insertion(source_context, cursor, height) orelse {
                    self.repair_waiting_for_insertion = cursor;
                    break;
                };
                if (observation.block_height > height) return error.UnfinalizedObservation;
            }
            var next = tree;
            try next.ingest(observation.message_id);
            const root = next.root();
            if (existing) |signed| {
                if (!std.mem.eql(u8, &signed.value.root, &root)) {
                    try self.halt(cursor, signed.value.root, root, timestamp);
                    return error.FinalizedHistoryConflict;
                }
            }
            if (cursor == anchor and !std.mem.eql(u8, &anchor_checkpoint.root, &root)) {
                try self.halt(anchor, anchor_checkpoint.root, root, timestamp);
                return error.FinalizedHistoryConflict;
            }
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try self.putRecord(&batch, cursor, observation, root);
            try self.put(&batch, "snapshot", &indexKey(cursor), &next.snapshot());
            if (existing) |signed| {
                const json = try signed.toJson(self.allocator);
                defer self.allocator.free(json);
                try self.put(&batch, "signed", &indexKey(cursor), json);
            }
            if (!remote_present) try self.put(&batch, "repair-unpublished", &indexKey(cursor), "");
            try self.put(&batch, "repair-frontier", "", &next.snapshot());
            try self.putNumber(&batch, "repair-cursor", cursor + 1);
            if (cursor == anchor) try self.putNumber(&batch, "repair-complete", anchor);
            try batch.commitSync();
            tree = next;
            cursor += 1;
            processed += 1;
            if (cursor > anchor) self.repair_complete = true;
        }
        return processed;
    }
};
/// Q is derived once; every signature is verified against it before release.
pub const LocalSigner = struct {
    key: protocol.signature.SigningKey,
    noise: ?Hash = null,
    pub fn init(secret_key: Hash, noise: ?Hash) !LocalSigner {
        return .{ .key = try protocol.signature.SigningKey.init(secret_key), .noise = noise };
    }
    pub fn deinit(self: *LocalSigner) void {
        self.key.deinit();
    }
    pub fn interface(self: *LocalSigner) Signer {
        return .{ .parallel_safe = true, .in_process = true, .context = self, .sign = sign, .sign_digest = digest };
    }
    fn digest(ctx: *anyopaque, hash: Hash) ![65]u8 {
        const self: *LocalSigner = @ptrCast(@alignCast(ctx));
        return self.key.sign(hash, self.noise);
    }
    fn sign(ctx: *anyopaque, c: Checkpoint) !Verified {
        const self: *LocalSigner = @ptrCast(@alignCast(ctx));
        return Verified.signWith(&self.key, c, self.noise);
    }
};
pub const LocalPublisher = struct {
    store: *@import("../storage/local.zig").LocalStore,
    pub fn interface(self: *LocalPublisher) Publisher {
        return .{ .parallel_safe = true, .in_process = true, .context = self, .write_announcement = announcement, .read_snapshot = readSnapshot, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = checkpoint, .write_checkpoints = checkpoints, .write_latest = latest, .write_snapshot = snapshot, .persist_reorg = reorg };
    }
    fn announcement(ctx: *anyopaque, value: objects.SignedAnnouncement) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        try self.store.writeAnnouncement(value);
    }
    fn readSnapshot(ctx: *anyopaque) !?objects.Snapshot {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        return self.store.readSnapshot();
    }
    fn fetch(ctx: *anyopaque, index: u32) !?objects.SignedCheckpoint {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        return self.store.fetchCheckpoint(index);
    }
    fn guard(ctx: *anyopaque) !bool {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        var status = try self.store.reorgStatus();
        defer status.deinit();
        return status.exists;
    }
    fn checkpoint(ctx: *anyopaque, s: Verified, time: u64) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        _ = try self.store.writeVerifiedCheckpoint(s, time);
    }
    fn checkpoints(ctx: *anyopaque, batch: []const Verified, time: u64) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        try self.store.writeVerifiedCheckpoints(batch, time);
    }
    fn latest(ctx: *anyopaque, index: u32) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        try self.store.writeLatestIndex(index);
    }
    fn snapshot(ctx: *anyopaque, s: *const objects.Snapshot) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        try self.store.writeSnapshot(s);
    }
    fn reorg(ctx: *anyopaque, e: objects.ReorgEvent) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        try self.store.persistReorg(e);
    }
};

/// Test-only crash boundaries: before the batch's signature (+ in-process
/// reservation) commit, and after every object write before the completion
/// WAL commit.
pub const TestPublicationFault = if (@import("builtin").is_test) struct {
    pub var before_signatures: std.atomic.Value(bool) = .init(false);
    pub var before_completion: std.atomic.Value(bool) = .init(false);
} else void;

/// Fault injection exists only in test binaries; production guard writes always
/// call the actual RocksDB WAL+fsync implementation without an override.
pub const TestGuardFault = if (@import("builtin").is_test) struct {
    pub var attempts: std.atomic.Value(usize) = .init(0);
    pub var before: std.atomic.Value(bool) = .init(false);
    pub var after: std.atomic.Value(bool) = .init(false);
} else void;
