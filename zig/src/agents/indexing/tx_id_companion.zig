//! Owner-thread transaction receipt companion. The queue is shared with canonical
//! dispatch producers; this controller performs no network work under its mutex.
//! A restart replays unprocessed canonical dispatch identities from the existing
//! DB, so cursor skip markers never discard an unfinished receipt notification.
const std = @import("std");
const src = @import("../scraper/source.zig");
const native = @import("../store.zig");
const codec = @import("../../db/codec.zig");
const queue = @import("tx_id_queue.zig");
const observation = @import("../../runtime/indexing_observer.zig");
const clock = @import("../validator/tick_clock.zig");
pub const Report = struct { work: usize = 0, next_delay_ms: u64 = 100, pending_read: bool = false, needs_source: bool = false, failure: ?anyerror = null };
pub const Companion = struct {
    const Work = struct { lease: queue.Lease, batch: ?src.Batch = null, validated: bool = false, persisted: usize = 0 };
    allocator: std.mem.Allocator,
    store: *native.Store,
    queue: *queue.Queue,
    contracts: src.Contracts,
    domain: u32,
    source: ?src.Source = null,
    observer: ?observation.Observer = null,
    current: ?Work = null,
    scan_started: bool = false,
    scan_nonce: ?u32 = null,
    pub fn deinit(self: *Companion) void {
        self.abort(0);
    }
    pub fn abort(self: *Companion, now_ms: u64) void {
        if (self.current) |*work| {
            if (work.batch) |*batch| batch.deinit();
            self.queue.retry(work.lease, now_ms, 0) catch {};
        }
        self.current = null;
    }
    pub fn setMask(self: *Companion, mask: queue.Mask, now_ms: u64) bool {
        if (std.meta.eql(self.queue.mask, mask)) return false;
        self.abort(now_ms);
        _ = self.queue.setMask(mask);
        self.scan_started = false;
        self.scan_nonce = null;
        return true;
    }
    fn scan(self: *Companion, now_ms: u64, cancel: *const std.atomic.Value(bool)) !void {
        if (!self.queue.mask.any()) return;
        if (self.scan_started and self.scan_nonce == null) {
            if (!self.queue.beginReplay(now_ms)) return;
            self.scan_started = false;
        }
        if (!self.scan_started) {
            self.scan_nonce = try self.store.highestSeenNonce();
            self.scan_started = true;
        }
        for (0..64) |_| {
            const nonce = self.scan_nonce orelse return;
            if (cancel.load(.acquire)) return error.RequestCancelled;
            if (try self.store.messageByNonce(nonce)) |owned| {
                var message = owned;
                defer message.deinit();
                if (!try self.store.processed(nonce)) if (try self.store.dispatchedTransaction(message.value.id())) |transaction| {
                    const height = (try self.store.messageBlock(nonce)) orelse return error.MissingStoredDispatchBlock;
                    self.queue.admit(.{ .transaction = transaction, .block_number = height }) catch |err| switch (err) {
                        error.TxIdQueueFull => return, // exact row remains for the next bounded scan
                        else => return err,
                    };
                };
            }
            self.scan_nonce = std.math.sub(u32, nonce, 1) catch null;
        }
    }
    fn validate(self: *Companion, work: *Work) !void {
        const batch = &work.batch.?;
        if (batch.through != work.lease.notice.block_number) return error.TransactionReceiptDispatchBlockMismatch;
        const authority = try self.source.?.transactionAuthority(self.contracts);
        const Position = struct { index: u64, emitter: src.Hash, stream: u8 };
        var positions = std.AutoHashMap(Position, src.Hash).init(self.allocator);
        defer positions.deinit();
        for (batch.events) |event| {
            const tx = event.tx_hash orelse return error.MissingTransactionReceiptIdentity;
            if (!std.mem.eql(u8, &tx, &work.lease.notice.transaction) or event.block_number != batch.through) return error.TransactionReceiptIdentityMismatch;
            if (std.mem.allEqual(u8, &event.block_hash, 0)) return error.MissingTransactionReceiptBlockHash;
            const expected = switch (event.data) {
                .dispatch, .delivery => authority.emitters.mailbox,
                .insertion => authority.emitters.hook,
                .gas => authority.emitters.paymaster,
            };
            if (!std.mem.eql(u8, &event.address, &expected)) return error.TransactionReceiptEmitterMismatch;
            if (event.data == .dispatch and event.data.dispatch.origin != self.domain) return error.WrongMessageOrigin;
            const namespaced = authority.positions == .per_emitter_stream;
            const entry = try positions.getOrPut(.{ .index = event.log_index, .emitter = if (namespaced) event.address else @splat(0), .stream = if (namespaced) @intCast(@intFromEnum(std.meta.activeTag(event.data))) else 0 });
            const fingerprint = @import("../scraper/generic.zig").fingerprint(event);
            if (entry.found_existing and !std.mem.eql(u8, entry.value_ptr, &fingerprint)) return error.ConflictingTransactionReceiptLog;
            entry.value_ptr.* = fingerprint;
        }
        work.validated = true;
    }
    pub fn tick(self: *Companion, now_ms: u64, cancel: *const std.atomic.Value(bool)) !Report {
        if (cancel.load(.acquire)) {
            self.abort(now_ms);
            return error.RequestCancelled;
        }
        self.queue.advance(now_ms);
        try self.scan(now_ms, cancel);
        if (self.current == null) {
            const lease = self.queue.take(now_ms) orelse return .{ .next_delay_ms = if (self.scan_nonce != null) 0 else self.queue.nextDelay(now_ms) };
            self.current = .{ .lease = lease };
        }
        const source = self.source orelse return .{ .needs_source = true, .next_delay_ms = 0 };
        if (source.transaction_fn == null) return error.UnsupportedTransactionEventSource;
        source.bindCancellation(cancel);
        defer source.bindCancellation(null);
        const work = &self.current.?;
        if (work.batch == null) {
            var elapsed: clock.Clock = .{};
            try elapsed.begin(now_ms);
            defer elapsed.end();
            work.batch = source.transactionEvents(self.allocator, work.lease.notice.transaction) catch |err| {
                if (err == error.PendingReadIo) return .{ .pending_read = true, .failure = err, .next_delay_ms = 10 };
                if (control(err)) {
                    self.abort(now_ms);
                    return err;
                }
                const completed = elapsed.now(now_ms);
                try self.queue.deferReplay(work.lease, completed, 2000);
                self.current = null;
                std.log.warn("origin transaction receipt fetch failed; retained for retry: {s}", .{@errorName(err)});
                return .{ .failure = err, .next_delay_ms = 0 };
            };
        }
        if (!work.validated) self.validate(work) catch |err| {
            if (control(err)) {
                self.abort(now_ms);
                return err;
            }
            const lease = work.lease;
            work.batch.?.deinit();
            self.current = null;
            try self.queue.deferReplay(lease, now_ms, 2000);
            std.log.warn("origin transaction receipt rejected; retained for retry: {s}", .{@errorName(err)});
            return .{ .failure = err, .next_delay_ms = 0 };
        };
        // All receipt metadata has been checked before the first native write.
        // Bounded persistence keeps ordinary streams progressing on large txs.
        var stored: usize = 0;
        const end = @min(work.batch.?.events.len, work.persisted +| 64);
        while (work.persisted < end) : (work.persisted += 1) {
            if (cancel.load(.acquire)) {
                self.abort(now_ms);
                return error.RequestCancelled;
            }
            const event = work.batch.?.events[work.persisted];
            const inserted = switch (event.data) {
                .insertion => |value| if (work.lease.mask.tree) try self.store.storeInsertion(.{ .leaf_index = value.index, .message_id = value.message_id }, event.block_number) else false,
                .gas => |value| if (work.lease.mask.gas) result: {
                    const payment: codec.GasPayment = .{ .message_id = value.message_id, .destination = value.destination, .payment = value.payment, .gas_amount = value.gas };
                    const meta: codec.GasPaymentMeta = .{ .transaction_id = event.tx_hash.?, .log_index = event.log_index };
                    break :result if (event.sequence) |index| try self.store.storeIndexedPayment(payment, meta, index, event.block_number) else try self.store.storePayment(payment, meta);
                } else false,
                .dispatch, .delivery => false,
            };
            if (inserted) {
                stored += 1;
                if (self.observer) |sink| sink.notify(.{ .stored = .{ .stream = if (event.data == .gas) .gas else .insertion } });
            }
        }
        if (work.persisted != work.batch.?.events.len) return .{ .work = stored, .next_delay_ms = 0 };
        try self.queue.complete(work.lease);
        work.batch.?.deinit();
        self.current = null;
        return .{ .work = stored + 1, .next_delay_ms = 0 };
    }
};
fn control(err: anyerror) bool {
    return switch (err) {
        error.RequestCancelled, error.OutOfMemory, error.PendingIo, error.RequestDeadlineExceeded, error.ReadReplayDeadline, error.ReadReplayByteBudgetExceeded, error.ReadReplayGlobalByteBudgetExceeded, error.ReadReplayRequestLimit, error.RpcPoolSessionsFull, error.RpcPoolStopped, error.RpcQueueFull => true,
        else => false,
    };
}
