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
    cancel: ?*const std.atomic.Value(bool) = null,
    context: *anyopaque,
    sign: *const fn (*anyopaque, Checkpoint) anyerror!objects.SignedCheckpoint,
    sign_digest: ?*const fn (*anyopaque, Hash) anyerror![65]u8 = null,
    pub fn digest(self: Signer, hash: Hash) ![65]u8 {
        const f = self.sign_digest orelse return error.MissingDigestSigner;
        return f(self.context, hash);
    }
};
pub const Publisher = struct {
    parallel_safe: bool = false,
    context: *anyopaque,
    read_snapshot: ?*const fn (*anyopaque) anyerror!?objects.Snapshot = null,
    fetch_checkpoint: *const fn (*anyopaque, u32) anyerror!?objects.SignedCheckpoint,
    is_reorged: *const fn (*anyopaque) anyerror!bool,
    write_announcement: ?*const fn (*anyopaque, objects.SignedAnnouncement) anyerror!void = null,
    write_checkpoint: *const fn (*anyopaque, objects.SignedCheckpoint, u64) anyerror!void,
    write_latest: *const fn (*anyopaque, u32) anyerror!void,
    write_snapshot: *const fn (*anyopaque, *const objects.Snapshot) anyerror!void,
    persist_reorg: *const fn (*anyopaque, objects.ReorgEvent) anyerror!void,
};
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
    publication_pool: ?*std.Thread.Pool = null,
    publication_threads: usize = 0,
    publication_running: bool = false,
    pending_reorg: ?objects.ReorgEvent = null,
    guard_local_pending: bool = false,
    guard_backend_pending: bool = false,
    pub fn deinit(self: *Service) void {
        if (self.publication_pool) |pool| {
            pool.deinit();
            self.allocator.destroy(pool);
        }
        self.publication_pool = null;
        self.publication_threads = 0;
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
            try self.verifySigned(signed);
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
    fn verifySigned(self: *Service, signed: objects.SignedCheckpoint) !void {
        if (!same(signed.value, try self.checkpoint(signed.value.index))) return error.SignedCheckpointChanged;
        if (!std.mem.eql(u8, &try signed.recover(), &self.options.signer_address)) return error.WrongSigner;
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
    pub fn authorize(self: *Service, votes: []const ?Checkpoint, unix_timestamp: u64) !?Checkpoint {
        self.mutex.lock();
        defer self.mutex.unlock();
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
        return self.reserveNextUnlocked();
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
            const signed = try self.signedCheckpoint(candidate.index) orelse blk: {
                var existing = try publisher.fetch_checkpoint(publisher.context, candidate.index);
                if (existing) |stored| {
                    const recovered = try stored.recover();
                    const same_context = stored.value.mailbox_domain == candidate.mailbox_domain and std.mem.eql(u8, &stored.value.merkle_tree_hook_address, &candidate.merkle_tree_hook_address);
                    if (std.mem.eql(u8, &recovered, &self.options.signer_address) and same_context) {
                        if (!same(stored.value, candidate)) {
                            try self.halt(candidate.index, candidate.root, stored.value.root, unix_timestamp);
                            try self.publishReorgUnlocked(publisher);
                            return error.FinalizedHistoryConflict;
                        }
                    } else existing = null;
                }
                if (existing == null and (self.fresh_verified_through == null or candidate.index > self.fresh_verified_through.?)) {
                    if (count > 0) break :publication;
                    return error.FreshAuthorizationRequired;
                }
                const value = existing orelse try self.signSerial(signer, candidate);
                try self.verifySigned(value);
                if (!same(value.value, candidate)) return error.SignerChangedCheckpoint;
                const json = try value.toJson(self.allocator);
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
    const PublicationJob = struct {
        service: *Service,
        signer: Signer,
        publisher: Publisher,
        checkpoint: Checkpoint,
        highest: u32,
        timestamp: u64,
        result: ?anyerror = null,
        published: bool = false,
        fn run(self: *PublicationJob) void {
            self.service.publishReserved(self) catch |err| {
                self.result = err;
                return;
            };
            self.published = true;
        }
    };
    fn ensurePublicationPool(self: *Service, threads: usize) !*std.Thread.Pool {
        if (self.publication_pool) |pool| {
            if (self.publication_threads >= threads) return pool;
            pool.deinit();
            self.allocator.destroy(pool);
            self.publication_pool = null;
        }
        const pool = try self.allocator.create(std.Thread.Pool);
        errdefer self.allocator.destroy(pool);
        try pool.init(.{ .allocator = self.allocator, .n_jobs = threads, .stack_size = 256 * 1024 });
        self.publication_pool = pool;
        self.publication_threads = threads;
        return pool;
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
    pub fn publishConcurrent(self: *Service, signer: Signer, publisher: Publisher, timestamp: u64, limit: usize) !usize {
        if (limit == 0 or limit > 1000) return error.InvalidPublicationLimit;
        try self.beginPublication();
        defer self.endPublication();
        if (limit == 1 or !signer.parallel_safe or !publisher.parallel_safe) return self.publishSerial(signer, publisher, timestamp, limit);
        const candidates = try self.reservePublicationBatch(limit);
        defer self.allocator.free(candidates);
        if (candidates.len <= 1) return self.publishSerial(signer, publisher, timestamp, limit);
        const jobs = try self.allocator.alloc(PublicationJob, candidates.len);
        defer self.allocator.free(jobs);
        var highest: u32 = 0;
        for (candidates) |candidate| highest = @max(highest, candidate.index);
        for (jobs, candidates) |*job, candidate| job.* = .{ .service = self, .signer = signer, .publisher = publisher, .checkpoint = candidate, .highest = highest, .timestamp = timestamp };
        const pool = try self.ensurePublicationPool(candidates.len);
        var wait: std.Thread.WaitGroup = .{};
        for (jobs) |*job| pool.spawnWg(&wait, PublicationJob.run, .{job});
        wait.wait();
        var published: usize = 0;
        var failure: ?anyerror = null;
        for (jobs) |job| {
            if (job.published) published += 1;
            if (job.result) |err| if (failure == null) {
                failure = err;
            };
        }
        self.mutex.lock();
        const halted = self.halted;
        self.mutex.unlock();
        if (halted) {
            try self.publishReorg(publisher);
            return error.ValidatorHalted;
        }
        // All worker callbacks have actually returned before snapshot creation
        // or any error escapes. A deadline never grants early context reuse.
        if (failure) |err| return err;
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.snapshotIfCovered(publisher);
        return published;
    }
    fn reservePublicationBatch(self: *Service, limit: usize) ![]Checkpoint {
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
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        for (candidates.items) |candidate| try self.put(&batch, "reservations", &indexKey(candidate.index), &encodeCheckpoint(candidate));
        try batch.commitSync();
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
    fn signSerial(self: *Service, signer: Signer, checkpoint_: Checkpoint) !objects.SignedCheckpoint {
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
    fn signReserved(self: *Service, job: *PublicationJob) !objects.SignedCheckpoint {
        var failure: anyerror = error.SignatureUnavailable;
        // Source performs five direct attempts then its singleton fallback. Our
        // pinned signer is already the sole identity; the final attempt retains
        // that same authority rather than introducing another credential chain.
        for (0..6) |attempt| {
            if (attempt > 0) std.Thread.sleep(100 * std.time.ns_per_ms);
            if (job.signer.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            self.mutex.lock();
            self.publicationGate(job.checkpoint, true) catch |err| {
                self.mutex.unlock();
                return err;
            };
            self.mutex.unlock();
            const value = job.signer.sign(job.signer.context, job.checkpoint) catch |err| {
                failure = err;
                continue;
            };
            return value;
        }
        return failure;
    }
    fn publishReserved(self: *Service, job: *PublicationJob) !void {
        if (job.signer.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        var buffer: [80]u8 = undefined;
        const submission = try std.fmt.bufPrint(&buffer, "checkpoint_submission[{d}]", .{job.checkpoint.index});
        var operation: []const u8 = submission;
        errdefer if (self.options.readiness) |status| status.blocked(operation) catch |err| std.log.warn("validator readiness update failed: {s}", .{@errorName(err)});
        if (try job.publisher.is_reorged(job.publisher.context)) {
            self.mutex.lock();
            defer self.mutex.unlock();
            try self.haltFromBackend();
            return error.ValidatorHalted;
        }
        self.mutex.lock();
        var signed = self.signedCheckpoint(job.checkpoint.index) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.publicationGate(job.checkpoint, false) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.mutex.unlock();
        if (signed == null) {
            const existing = try job.publisher.fetch_checkpoint(job.publisher.context, job.checkpoint.index);
            if (existing) |stored| {
                const address = try stored.recover();
                const context = stored.value.mailbox_domain == job.checkpoint.mailbox_domain and std.mem.eql(u8, &stored.value.merkle_tree_hook_address, &job.checkpoint.merkle_tree_hook_address);
                if (std.mem.eql(u8, &address, &self.options.signer_address) and context) {
                    if (!same(stored.value, job.checkpoint)) {
                        self.mutex.lock();
                        const result = self.halt(job.checkpoint.index, job.checkpoint.root, stored.value.root, job.timestamp);
                        self.mutex.unlock();
                        try result;
                        try self.publishReorg(job.publisher);
                        return error.FinalizedHistoryConflict;
                    }
                    signed = stored;
                }
            }
            if (signed == null) {
                self.mutex.lock();
                self.publicationGate(job.checkpoint, true) catch |err| {
                    self.mutex.unlock();
                    return err;
                };
                self.mutex.unlock();
                signed = try self.signReserved(job);
            }
            self.mutex.lock();
            defer self.mutex.unlock();
            try self.publicationGate(job.checkpoint, false);
            try self.verifySigned(signed.?);
            if (!same(signed.?.value, job.checkpoint)) return error.SignerChangedCheckpoint;
            const wire = try signed.?.toJson(self.allocator);
            defer self.allocator.free(wire);
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try self.put(&batch, "signed", &indexKey(job.checkpoint.index), wire);
            const watermark = @max(self.signed_watermark orelse 0, job.checkpoint.index);
            try self.putNumber(&batch, "signed-watermark", watermark);
            try batch.commitSync();
            self.signed_watermark = watermark;
        }
        self.mutex.lock();
        self.publicationGate(job.checkpoint, false) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.verifySigned(signed.?) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.mutex.unlock();
        if (job.signer.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        try job.publisher.write_checkpoint(job.publisher.context, signed.?, job.timestamp);
        if (self.options.readiness) |status| status.ready(submission);
        const owns_latest = job.checkpoint.index == job.highest;
        if (owns_latest) {
            if (job.signer.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            self.mutex.lock();
            self.publicationGate(job.checkpoint, false) catch |err| {
                self.mutex.unlock();
                return err;
            };
            const availability = @max(self.latest_published orelse job.highest, job.highest);
            self.mutex.unlock();
            operation = "checkpoint_latest_index";
            try job.publisher.write_latest(job.publisher.context, availability);
            if (self.options.readiness) |status| status.ready(operation);
        }
        operation = "checkpoint_persistence";
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.publicationGate(job.checkpoint, false);
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.delete(&batch, "unpublished", &indexKey(job.checkpoint.index));
        try self.delete(&batch, "repair-unpublished", &indexKey(job.checkpoint.index));
        try self.delete(&batch, "reservations", &indexKey(job.checkpoint.index));
        if (try self.reservation()) |legacy| if (legacy.index == job.checkpoint.index) try self.delete(&batch, "reservation", "");
        const latest = if (owns_latest) @max(self.latest_published orelse 0, job.highest) else self.latest_published;
        if (latest) |value| try self.putNumber(&batch, "latest", value);
        try batch.commitSync();
        self.latest_published = latest;
        if (self.options.readiness) |status| status.ready("checkpoint_persistence");
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
pub const LocalSigner = struct {
    key: Hash,
    noise: ?Hash = null,
    pub fn interface(self: *LocalSigner) Signer {
        return .{ .parallel_safe = true, .context = self, .sign = sign, .sign_digest = digest };
    }
    fn digest(ctx: *anyopaque, hash: Hash) ![65]u8 {
        const self: *LocalSigner = @ptrCast(@alignCast(ctx));
        return protocol.signature.signDigest(self.key, hash, self.noise);
    }
    fn sign(ctx: *anyopaque, c: Checkpoint) !objects.SignedCheckpoint {
        const self: *LocalSigner = @ptrCast(@alignCast(ctx));
        return objects.SignedCheckpoint.sign(c, self.key, self.noise);
    }
};
pub const LocalPublisher = struct {
    store: *@import("../storage/local.zig").LocalStore,
    pub fn interface(self: *LocalPublisher) Publisher {
        return .{ .parallel_safe = true, .context = self, .write_announcement = announcement, .read_snapshot = readSnapshot, .fetch_checkpoint = fetch, .is_reorged = guard, .write_checkpoint = checkpoint, .write_latest = latest, .write_snapshot = snapshot, .persist_reorg = reorg };
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
    fn checkpoint(ctx: *anyopaque, s: objects.SignedCheckpoint, time: u64) !void {
        const self: *LocalPublisher = @ptrCast(@alignCast(ctx));
        _ = try self.store.writeCheckpoint(s, time);
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

/// Fault injection exists only in test binaries; production guard writes always
/// call the actual RocksDB WAL+fsync implementation without an override.
pub const TestGuardFault = if (@import("builtin").is_test) struct {
    pub var attempts: std.atomic.Value(usize) = .init(0);
    pub var before: std.atomic.Value(bool) = .init(false);
    pub var after: std.atomic.Value(bool) = .init(false);
} else void;
