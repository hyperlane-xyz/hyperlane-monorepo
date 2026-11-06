const std = @import("std");
const rocks = @import("../db/rocks.zig");
const types = @import("types.zig");
const storage = @import("store.zig");

pub const Manager = struct {
    store: storage.Store,
    signer: types.Address,
    boundary_lock: std.Thread.Mutex = .{},
    max_scan: u256 = 4096,
    scan_resume: ?struct { next: u256, upper: u256, generation: u64 } = null,

    pub fn init(store: storage.Store, signer: types.Address) Manager {
        return .{ .store = store, .signer = signer };
    }

    pub const Reservation = struct { nonce: u256, reused: bool };

    pub fn validateAndReserve(self: *Manager, allocator: std.mem.Allocator, uuid: types.Uuid, precursor_nonce: ?u256, status: types.Status) !Reservation {
        self.boundary_lock.lock();
        defer self.boundary_lock.unlock();
        const db_nonce = try self.store.transactionNonce(allocator, self.signer, uuid);
        if (db_nonce == null) {
            _ = precursor_nonce;
            return self.reserveLocked(allocator, uuid, null);
        }
        const nonce = db_nonce.?;
        if (status == .dropped) return self.reserveLocked(allocator, uuid, nonce);
        if (status != .finalized) {
            const finalized = try self.store.finalizedNonce(allocator, self.signer);
            if (finalized != null and nonce <= finalized.?) return self.reserveLocked(allocator, uuid, nonce);
        }
        return .{ .nonce = nonce, .reused = false };
    }

    /// Allocation and finalized-boundary updates use the same mutex and sync batches.
    /// Bounded scans resume at their saved position; no unscanned gap is skipped.
    pub fn reserve(self: *Manager, allocator: std.mem.Allocator, uuid: types.Uuid, old_nonce: ?u256) !Reservation {
        self.boundary_lock.lock();
        defer self.boundary_lock.unlock();
        return self.reserveLocked(allocator, uuid, old_nonce);
    }

    fn reserveLocked(self: *Manager, allocator: std.mem.Allocator, uuid: types.Uuid, old_nonce: ?u256) !Reservation {
        if (std.mem.eql(u8, &uuid, &types.nil_uuid)) return error.InvalidTransactionUuid;
        var batch = try self.store.typed.batch(allocator);
        defer batch.deinit();
        var cleared_old = false;
        if (old_nonce) |old| {
            const tracked = try self.store.trackedUuid(allocator, self.signer, old);
            if (std.mem.eql(u8, &tracked, &uuid)) {
                try storage.Store.clearTracked(&batch, self.signer, old, uuid);
                cleared_old = true;
            }
        }
        const finalized = try self.store.finalizedNonce(allocator, self.signer);
        const upper = try self.store.upperNonce(allocator, self.signer);
        const start = if (finalized) |value| value +| 1 else 0;
        const generation = try self.store.availabilityGeneration(allocator);
        var next = if (!cleared_old and self.scan_resume != null and self.scan_resume.?.upper == upper and self.scan_resume.?.generation == generation and self.scan_resume.?.next > start) self.scan_resume.?.next else start;
        var scanned: u256 = 0;
        var reused = false;
        while (next < upper and scanned < self.max_scan) : ({
            next +|= 1;
            scanned += 1;
        }) {
            if ((cleared_old and next == old_nonce.?) or try self.nonceAvailable(allocator, next)) {
                reused = true;
                break;
            }
        }
        if (!reused and next < upper) {
            self.scan_resume = .{ .next = next, .upper = upper, .generation = generation };
            return error.NonceScanBudgetExceeded;
        }
        self.scan_resume = null;
        if (!reused) next = upper;
        if (next == std.math.maxInt(u256)) return error.NonceExhausted;
        if (next == upper) try storage.Store.putUpper(&batch, self.signer, next +| 1);
        try storage.Store.putTracked(&batch, self.signer, next, uuid);
        try batch.commitSync();
        return .{ .nonce = next, .reused = reused };
    }

    /// Accepts eth_getTransactionCount at the authenticated finalized height.
    pub fn updateBoundaryFromAccountNonce(self: *Manager, allocator: std.mem.Allocator, next_account_nonce: u256) !void {
        return self.updateBoundary(allocator, if (next_account_nonce == 0) null else next_account_nonce - 1);
    }

    pub fn updateBoundary(self: *Manager, allocator: std.mem.Allocator, finalized_nonce: ?u256) !void {
        self.boundary_lock.lock();
        defer self.boundary_lock.unlock();
        const old_finalized = try self.store.finalizedNonce(allocator, self.signer);
        const existing_range = try self.store.reorgRange(allocator, self.signer);
        var pending_range = existing_range;
        if (old_finalized) |old| {
            if (finalized_nonce == null or finalized_nonce.? < old) {
                const observed: storage.ReorgRange = .{
                    .start = if (finalized_nonce) |new| new +| 1 else 0,
                    .end = old,
                };
                pending_range = if (existing_range) |existing| .{
                    .start = @min(existing.start, observed.start),
                    .end = @max(existing.end, observed.end),
                } else observed;
                var range_batch = try self.store.typed.batch(allocator);
                defer range_batch.deinit();
                try storage.Store.putReorgRange(&range_batch, self.signer, pending_range);
                try range_batch.commitSync();
            }
        }
        var upper = try self.store.upperNonce(allocator, self.signer);
        if (finalized_nonce) |finalized| {
            if (finalized >= upper) upper = finalized +| 1;
        }
        upper = try self.trimUpper(allocator, finalized_nonce, upper);
        var batch = try self.store.typed.batch(allocator);
        defer batch.deinit();
        try storage.Store.putFinalized(&batch, self.signer, finalized_nonce);
        try storage.Store.putUpper(&batch, self.signer, upper);
        try batch.commitSync();
    }

    fn trimUpper(self: *Manager, allocator: std.mem.Allocator, finalized_nonce: ?u256, initial: u256) !u256 {
        const floor = if (finalized_nonce) |value| value +| 1 else 0;
        var trimmed = initial;
        var scanned: u256 = 0;
        while (trimmed > floor and scanned < self.max_scan) : (scanned += 1) {
            const candidate = trimmed - 1;
            if (!try self.nonceAvailable(allocator, candidate)) break;
            trimmed = candidate;
        }
        return trimmed;
    }

    pub fn nonceAvailable(self: *Manager, allocator: std.mem.Allocator, nonce: u256) !bool {
        const uuid = try self.store.trackedUuid(allocator, self.signer, nonce);
        if (std.mem.eql(u8, &uuid, &types.nil_uuid)) return true;
        var owned = (try self.store.transactionStatus(allocator, uuid)) orelse return true;
        defer owned.deinit(allocator);
        return owned.value == .dropped;
    }

    pub fn overwriteUpper(self: *Manager, allocator: std.mem.Allocator, desired: ?u256) !void {
        self.boundary_lock.lock();
        defer self.boundary_lock.unlock();
        const finalized = try self.store.finalizedNonce(allocator, self.signer);
        const upper = try self.store.upperNonce(allocator, self.signer);
        const target = desired orelse if (finalized) |value| value +| 1 else 0;
        if (target >= upper) return error.InvalidUpperNonce;
        if (finalized != null and target <= finalized.?) return error.InvalidUpperNonce;
        if (upper - target > self.max_scan) return error.NonceResetRangeTooLarge;
        var batch = try self.store.typed.batch(allocator);
        defer batch.deinit();
        try storage.Store.putUpper(&batch, self.signer, target);
        var nonce = target;
        while (nonce < upper) : (nonce += 1) {
            const uuid = try self.store.trackedUuid(allocator, self.signer, nonce);
            if (!std.mem.eql(u8, &uuid, &types.nil_uuid)) try storage.Store.clearTracked(&batch, self.signer, nonce, uuid);
        }
        try batch.commitSync();
    }
};
