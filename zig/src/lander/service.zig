const std = @import("std");
const settings = @import("../settings/types.zig");
const evm_transaction = @import("../evm/transaction.zig");
const abi = @import("../evm/codecs.zig");
const rfc3339 = @import("../agents/scraper/time.zig").rfc3339;
const types = @import("types.zig");
const storage = @import("store.zig");
const nonce = @import("nonce.zig");
const chain = @import("chain.zig");
const gas = @import("gas.zig");
const records = @import("records.zig");
const multicall = @import("multicall.zig");
const mev = @import("mev.zig");
const observer = @import("observer.zig");
const backoff = @import("backoff.zig");
pub const idle_boundary_refresh_ms: u64 = 300_000;

pub const Signer = struct {
    context: *anyopaque,
    address: types.Address,
    sign_fn: *const fn (*anyopaque, types.Hash) anyerror!types.Signature,

    pub fn sign(self: Signer, digest: types.Hash) !types.Signature {
        return self.sign_fn(self.context, digest);
    }
};

pub const NativeTests = if (@import("builtin").is_test) struct {
    /// Runs on `record` as decoded from the store; the record keeps every
    /// change, as a retained row would.
    pub fn simulateBatch(running: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator, submission: chain.Chain) !void {
        const uuid = try records.transactionUuid(record.value());
        var row: Service.Row = .{ .uuid = uuid, .record = record.*, .status = std.meta.activeTag(try records.status(record.value())), .index = try running.store.transactionIndex(allocator, uuid), .base_capacity = 0 };
        defer record.* = row.record;
        _ = try running.simulateBatch(&row, allocator, submission);
    }
} else struct {};

pub const MevSubmission = struct {
    policy: mev.Config,
    protected_chain: chain.Chain,
    timeout_ms: u32 = 5_000,
};

pub const Config = struct {
    domain_name: []const u8,
    chain_id: u256,
    signer: Signer,
    overrides: settings.TransactionOverrides = std.mem.zeroes(settings.TransactionOverrides),
    max_batch_size: u32 = 1,
    batch_contract_address: ?types.Address = null,
    bypass_batch_simulation: bool = false,
    max_submit_queue_length: ?u32 = null,
    mev_submission: ?MevSubmission = null,
    arbitrum_nitro: bool = false,
    zksync_stack: bool = false,
    observer: ?observer.Observer = null,
    estimated_block_time_ms: u64 = 12_000,
};

pub const EnqueueInput = struct {
    payload: records.PayloadInput,
    delivery: storage.Delivery = .none,
    /// `.deferred`: the caller commits a synced write on this database before
    /// any effect (db.rocks.Durability); signing and sending are gated anyway.
    durability: @import("../db/rocks.zig").Durability = .sync,
};

pub const EnqueueResult = struct { uuid: types.Uuid, index: u32, created: bool };

pub const TickLimits = struct {
    max_transactions: usize = 16,
    max_receipts: usize = 32,
    max_build: usize = 4,
    max_payload_scan: usize = 64,
    max_reorg: usize = 64,
};

pub const Report = struct {
    transactions_scanned: usize = 0,
    receipts_read: usize = 0,
    built: usize = 0,
    broadcasts: usize = 0,
    finalized: usize = 0,
    reverted_payloads: usize = 0,
    stale_dropped: usize = 0,
    reprocessed: usize = 0,
    deferred: usize = 0,
    rejected: usize = 0,
    recovery_complete: bool = false,
};

const ReceiptItem = struct {
    read: bool = false,
    status: ?types.Status = null,
    block: ?u64 = null,
    block_hash: ?types.Hash = null,
    hash: ?types.Hash = null,
    gas_used: ?u256 = null,
    effective_gas_price: ?u256 = null,
    executed: bool = true,
    /// The receipt's block hash matched the canonical header at its height.
    verified: bool = false,
};

const WinningReceipt = struct {
    hash: types.Hash,
    block_number: u64,
    block_hash: types.Hash,
    gas_used: ?u256,
    effective_gas_price: ?u256,
    executed: bool,
};

const Observed = struct {
    status: types.Status,
    winning: ?WinningReceipt = null,
    /// Finalized height this classification used (null: none was needed).
    finalized_height: ?u64 = null,
};

const ReceiptProgress = struct {
    items: []ReceiptItem,
    next: usize = 0,
};

pub fn allocateReceiptItems(allocator: std.mem.Allocator, count: usize) ![]ReceiptItem {
    const items = try allocator.alloc(ReceiptItem, count);
    @memset(items, .{});
    return items;
}

fn ensureReceiptProgress(progress: *std.AutoHashMap(types.Uuid, ReceiptProgress), allocator: std.mem.Allocator, uuid: types.Uuid, count: usize) !*ReceiptProgress {
    const result = try progress.getOrPut(uuid);
    if (!result.found_existing) result.value_ptr.* = .{ .items = &.{} };
    if (result.value_ptr.items.len != count) {
        const items = try allocateReceiptItems(allocator, count);
        if (result.value_ptr.items.len > 0) allocator.free(result.value_ptr.items);
        result.value_ptr.* = .{ .items = items };
    }
    return result.value_ptr;
}

pub const Service = struct {
    allocator: std.mem.Allocator,
    store: storage.Store,
    chain: chain.Chain,
    config: Config,
    nonces: nonce.Manager,
    cancel: *const std.atomic.Value(bool),
    mutex: std.Thread.Mutex = .{},
    scan_cursor: u32,
    recovery_complete: bool = false,
    recovery_blocked: bool = false,
    fast_recovery: bool,
    /// Mirror of the durable active index; `store.active` points at it.
    active: *storage.ActiveSet,
    /// `store.pending_floor` points at it.
    pending_floor: *storage.PendingFloor,
    active_cursor: u32 = 0,
    past_old_boundary: bool = false,
    next_boundary_refresh_ms: u64 = 0,
    boundary_refreshed_ms: u64 = 0,
    payload_reconcile_cursor: u32,
    payload_reconcile_complete: bool,
    queued_transactions: u32 = 0,
    pending_payloads: u64 = 0,
    included_transactions: u32 = 0,
    oldest_unchecked_age_seconds: u64 = 0,
    reorg_cursor: ?u256 = null,
    reorg_active: ?storage.ReorgRange = null,
    receipt_progress: std.AutoHashMap(types.Uuid, ReceiptProgress),
    /// In-memory schedule of active transactions (fast path only). A not-due
    /// transaction is skipped before its JSON record is loaded.
    checks: std.AutoHashMapUnmanaged(types.Uuid, Check) = .empty,
    /// Source caches Multicall code existence for the adapter's lifetime; a
    /// configured batch contract that has code is not re-read per batch.
    batch_contract_present: bool = false,
    /// Decoded rows of active transactions once recovery is complete (as
    /// Source keeps its inclusion pool in memory). A check mutates the entry
    /// (in the entry's own arena) and encodes it only to write; it never
    /// re-reads a row this service wrote. Invariants:
    /// - An entry equals its stored row (encodes to what the stored row
    ///   decodes to), so persisted bytes are those the reload-per-check path
    ///   wrote. A check that wrote nothing restores `status` and
    ///   `last_status_check`, the only fields changed before a write; any
    ///   error, terminal status or reorg rewrite evicts the entry, and the
    ///   next check decodes the stored row. Tests check this every tick
    ///   (`rowsMatchStore`).
    /// - The service is the sole writer of lander rows while open; a write
    ///   behind it (e.g. processReorg's own reload) evicts the entry first.
    /// - `Row.payloads` assumes a retained transaction's payload rows are
    ///   written only through it and delivery rows never change after
    ///   enqueue.
    /// - Durability is unchanged: every row write keeps its commit mode, and
    ///   the effect gates before signing and sending still run.
    /// Open and recovery always decode from the database.
    rows: std.AutoHashMapUnmanaged(types.Uuid, *Row) = .empty,
    /// Transaction rows committed by this service (a check compares it to
    /// tell whether it wrote).
    row_writes: u64 = 0,
    /// Transaction rows decoded from the database.
    row_loads: u64 = 0,
    /// Payload rows read from the database by finality checks.
    payload_loads: u64 = 0,

    pub fn open(allocator: std.mem.Allocator, store: storage.Store, chain_adapter: chain.Chain, config: Config, cancel: *const std.atomic.Value(bool)) !Service {
        if (config.max_batch_size == 0 or config.domain_name.len == 0 or config.estimated_block_time_ms == 0) return error.InvalidLanderConfig;
        if (config.mev_submission != null and config.mev_submission.?.timeout_ms == 0) return error.InvalidLanderConfig;
        const highest = try store.highestTransactionIndex(allocator);
        const fast_recovery = try store.activeCheckpoint(allocator);
        const payload_highest = try store.beginPendingReconciliation(allocator);
        const active = try allocator.create(storage.ActiveSet);
        errdefer allocator.destroy(active);
        active.* = .init(allocator);
        errdefer active.deinit();
        if (fast_recovery) try active.rebuild(store);
        const pending_floor = try allocator.create(storage.PendingFloor);
        errdefer allocator.destroy(pending_floor);
        pending_floor.* = .{};
        var owned_store = store;
        owned_store.active = active;
        owned_store.pending_floor = pending_floor;
        return .{
            .allocator = allocator,
            .store = owned_store,
            .chain = chain_adapter,
            .config = config,
            .nonces = nonce.Manager.init(owned_store, config.signer.address),
            .cancel = cancel,
            .scan_cursor = highest,
            .fast_recovery = fast_recovery,
            .active = active,
            .pending_floor = pending_floor,
            .payload_reconcile_cursor = payload_highest,
            .payload_reconcile_complete = payload_highest == 0,
            .receipt_progress = std.AutoHashMap(types.Uuid, ReceiptProgress).init(allocator),
        };
    }

    const Check = struct {
        creation_ms: u64,
        last_ms: u64,
        included: bool,
        /// Included transactions await finality once per block, as Source's
        /// finality stage; others keep the age-based inclusion backoff.
        fn due(self: Check, block_time_ms: u64, now_ms: u64) bool {
            if (self.included) return now_ms -| self.last_ms >= block_time_ms;
            return backoff.ready(block_time_ms, now_ms, self.creation_ms, self.last_ms);
        }
    };

    fn batchContractPresent(self: *Service, allocator: std.mem.Allocator, address: types.Address) !bool {
        if (self.batch_contract_present) return true;
        const code = try self.chain.getCode(allocator, address);
        self.batch_contract_present = code.len != 0;
        return self.batch_contract_present;
    }

    fn rememberPersistedCheck(self: *Service, uuid: types.Uuid, value: std.json.Value) void {
        const creation = (rfc3339(types.stringField(value, "creation_timestamp") catch return) catch return) * 1000;
        const last = types.optionalField(value, "last_status_check") orelse return;
        if (last != .string) return;
        const last_ms = (rfc3339(last.string) catch return) * 1000;
        // Allocation failure only loses the skip; the next tick loads again.
        self.checks.put(self.allocator, uuid, .{ .creation_ms = creation, .last_ms = last_ms, .included = false }) catch {};
    }

    fn rememberCheck(self: *Service, uuid: types.Uuid, value: std.json.Value, now_ms: u64) void {
        const status = records.status(value) catch {
            _ = self.checks.remove(uuid);
            return;
        };
        if (!status.isActive()) {
            _ = self.checks.remove(uuid);
            return;
        }
        const creation = (rfc3339(types.stringField(value, "creation_timestamp") catch return) catch return) * 1000;
        self.checks.put(self.allocator, uuid, .{ .creation_ms = creation, .last_ms = now_ms, .included = status == .included }) catch {};
    }

    /// A decoded transaction row and what it replaces at its next write.
    const Row = struct {
        uuid: types.Uuid,
        record: storage.JsonRecord,
        /// Status of the stored row.
        status: storage.StatusTag,
        /// `tx_index_by_uuid` of the transaction.
        index: ?u32,
        /// Arena capacity when decoded (bounds growth from mutations).
        base_capacity: usize,
        /// What finality checks read of each payload of `payload_details`, in
        /// order, filled by the first check (null: not yet, or the details
        /// changed). Owned by the service allocator.
        payloads: ?[]PayloadFacts = null,

        fn value(self: *const Row) std.json.Value {
            return self.record.value();
        }

        fn arena(self: *Row) std.mem.Allocator {
            return self.record.parsed.arena.allocator();
        }
    };

    /// A payload row as finality checks use it. Payload rows of a retained
    /// transaction are written only through it (delivery rows never change
    /// after enqueue), so the facts stay those of the stored rows.
    const PayloadFacts = struct {
        uuid: types.Uuid,
        /// The stored status value, re-encoded compactly.
        status: []u8,
        gas_limit: u256,
        /// The delivery read (null: delivered by inclusion).
        call: ?chain.Call,

        fn deinit(self: *PayloadFacts, allocator: std.mem.Allocator) void {
            allocator.free(self.status);
            if (self.call) |call| allocator.free(call.calldata);
            self.* = undefined;
        }
    };

    fn freePayloadFacts(self: *Service, row: *Row) void {
        const facts = row.payloads orelse return;
        for (facts) |*item| item.deinit(self.allocator);
        self.allocator.free(facts);
        row.payloads = null;
    }

    fn payloadFacts(self: *Service, allocator: std.mem.Allocator, payload: records.PayloadView) !PayloadFacts {
        const uuid = try payload.uuid(allocator);
        const status = try std.json.Stringify.valueAlloc(self.allocator, try payload.statusValue(allocator), .{});
        errdefer self.allocator.free(status);
        const gas_limit = try payload.gasLimit(allocator);
        var call = try self.deliveryCall(allocator, payload);
        if (call) |*value| value.calldata = try self.allocator.dupe(u8, value.calldata);
        return .{ .uuid = uuid, .status = status, .gas_limit = gas_limit, .call = call };
    }

    fn destroyRow(self: *Service, row: *Row) void {
        self.freePayloadFacts(row);
        row.record.deinit();
        self.allocator.destroy(row);
    }

    fn newRow(self: *Service, uuid: types.Uuid, record: storage.JsonRecord, index: ?u32) !*Row {
        var owned = record;
        errdefer owned.deinit();
        const status = std.meta.activeTag(try records.status(owned.value()));
        const row = try self.allocator.create(Row);
        row.* = .{ .uuid = uuid, .record = owned, .status = status, .index = index, .base_capacity = owned.parsed.arena.queryCapacity() };
        return row;
    }

    /// The stored row decoded (null: absent). Not retained.
    fn loadRow(self: *Service, uuid: types.Uuid) !?*Row {
        const record = (try self.store.loadTransaction(self.allocator, uuid)) orelse return null;
        self.row_loads += 1;
        var owned = record;
        const index = self.store.transactionIndex(self.allocator, uuid) catch |err| {
            owned.deinit();
            return err;
        };
        return try self.newRow(uuid, owned, index);
    }

    /// Frees a row and removes it from `rows` if retained there.
    fn dropRow(self: *Service, row: *Row) void {
        if (self.rows.get(row.uuid)) |retained| if (retained == row) {
            _ = self.rows.remove(row.uuid);
        };
        self.destroyRow(row);
    }

    fn evictRow(self: *Service, uuid: types.Uuid) void {
        if (self.rows.get(uuid)) |row| self.dropRow(row);
    }

    fn clearRows(self: *Service) void {
        var iterator = self.rows.valueIterator();
        while (iterator.next()) |row| self.destroyRow(row.*);
        self.rows.clearRetainingCapacity();
    }

    /// Keeps an active row for later checks, else frees it. Allocation
    /// failure only loses the entry; the next check decodes the stored row.
    fn retainRow(self: *Service, row: *Row) void {
        if (row.status == .dropped or row.status == .finalized) return self.dropRow(row);
        if (self.rows.get(row.uuid)) |retained| if (retained == row) return;
        self.evictRow(row.uuid);
        self.rows.put(self.allocator, row.uuid, row) catch return self.dropRow(row);
    }

    /// Mutations allocate in the row's arena. Past a bound, the row is
    /// re-decoded from its own encoding (equal to the stored row), which
    /// drops what earlier mutations replaced.
    fn boundRowGrowth(self: *Service, row: *Row) !void {
        if (row.record.parsed.arena.queryCapacity() <= 2 * row.base_capacity + 64 * 1024) return;
        const json = try std.json.Stringify.valueAlloc(self.allocator, row.value(), .{});
        defer self.allocator.free(json);
        const parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, json, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always });
        row.record.deinit();
        row.record = .{ .parsed = parsed };
        row.base_capacity = parsed.arena.queryCapacity();
    }

    /// The store write of the row as it is now; `json` is its encoding.
    fn rowWrite(row: *const Row, scratch: std.mem.Allocator, json: []const u8) !storage.Store.Row {
        return .{
            .uuid = row.uuid,
            .json = json,
            .status = std.meta.activeTag(try records.status(row.value())),
            .hashes = try records.hashes(scratch, row.value()),
            .prior = .{ .status = row.status, .index = row.index },
        };
    }

    fn committedRow(self: *Service, row: *Row, write: storage.Store.Row) void {
        row.status = write.status;
        self.row_writes += 1;
    }

    fn writeRow(self: *Service, row: *Row, scratch: std.mem.Allocator) !void {
        const json = try std.json.Stringify.valueAlloc(self.allocator, row.value(), .{});
        defer self.allocator.free(json);
        const write = try rowWrite(row, scratch, json);
        try self.store.writeTransactionRow(self.allocator, write);
        self.committedRow(row, write);
    }

    fn writeRowAndPayloads(self: *Service, row: *Row, scratch: std.mem.Allocator, payloads: []const storage.PayloadUpdate, receipt: ?storage.FinalizedReceipt) !void {
        const json = try std.json.Stringify.valueAlloc(self.allocator, row.value(), .{});
        defer self.allocator.free(json);
        const write = try rowWrite(row, scratch, json);
        try self.store.writeTransactionRowAndPayloads(self.allocator, write, payloads, receipt);
        self.committedRow(row, write);
    }

    /// Test oracle: every retained row encodes as its stored row decodes.
    fn rowsMatchStore(self: *Service) !bool {
        var iterator = self.rows.valueIterator();
        while (iterator.next()) |entry| {
            const row = entry.*;
            var stored = (try self.store.loadTransaction(self.allocator, row.uuid)) orelse return false;
            defer stored.deinit();
            const expected = try std.json.Stringify.valueAlloc(self.allocator, stored.value(), .{});
            defer self.allocator.free(expected);
            const actual = try std.json.Stringify.valueAlloc(self.allocator, row.value(), .{});
            defer self.allocator.free(actual);
            if (!std.mem.eql(u8, expected, actual)) return false;
            if (row.status != std.meta.activeTag(try records.status(stored.value()))) return false;
            if (!std.meta.eql(row.index, try self.store.transactionIndex(self.allocator, row.uuid))) return false;
        }
        return true;
    }

    pub fn deinit(self: *Service) void {
        var iterator = self.receipt_progress.iterator();
        while (iterator.next()) |entry| self.allocator.free(entry.value_ptr.items);
        self.receipt_progress.deinit();
        self.clearRows();
        self.rows.deinit(self.allocator);
        self.checks.deinit(self.allocator);
        self.active.deinit();
        self.allocator.destroy(self.active);
        self.allocator.destroy(self.pending_floor);
        self.* = undefined;
    }

    /// Input is borrowed only for this call. The canonical payload, indexes and
    /// delivery metadata are synchronized before the UUID is returned.
    pub fn enqueue(self: *Service, input: EnqueueInput) !EnqueueResult {
        self.lock();
        defer self.mutex.unlock();
        if (self.cancel.load(.acquire)) return error.Cancelled;
        if (std.mem.eql(u8, &input.payload.uuid, &types.nil_uuid)) return error.InvalidPayloadUuid;
        const canonical = try records.payloadJson(self.allocator, input.payload);
        defer self.allocator.free(canonical);
        if (try self.store.loadPayloadBytes(self.allocator, input.payload.uuid)) |existing_bytes| {
            defer self.allocator.free(existing_bytes);
            var arena = std.heap.ArenaAllocator.init(self.allocator);
            defer arena.deinit();
            const existing = try records.PayloadView.parse(arena.allocator(), existing_bytes);
            const replacement = try records.PayloadView.parse(arena.allocator(), canonical);
            if (!try records.samePayloadIdentity(self.allocator, existing, replacement)) return error.PayloadAssociationConflict;
            var stored_delivery = try self.store.delivery(self.allocator, input.payload.uuid);
            defer if (stored_delivery) |*value| value.deinit(self.allocator);
            if (!deliveryMatches(stored_delivery, input.delivery)) return error.DeliveryAssociationConflict;
            const index = (try self.store.payloadIndex(self.allocator, input.payload.uuid)) orelse return error.MissingPayloadIndex;
            return .{ .uuid = input.payload.uuid, .index = index, .created = false };
        }
        const index = try self.store.writePayloadWith(self.allocator, input.payload.uuid, canonical, canonical, input.delivery, input.durability);
        self.pending_payloads +|= 1;
        return .{ .uuid = input.payload.uuid, .index = index, .created = true };
    }

    /// True once recovery finished and the durable store holds no pending
    /// payload, active (unfinalized) transaction or reorged nonce range. Such a
    /// tick would only refresh the nonce boundary; owners may stop ticking
    /// until their next enqueue. Reads durable indexes, not in-memory counters.
    pub fn idle(self: *Service) !bool {
        self.lock();
        defer self.mutex.unlock();
        if (!self.recovery_complete or !self.payload_reconcile_complete) return false;
        if (try self.store.reorgRange(self.allocator, self.config.signer.address) != null) return false;
        if (!self.active.fresh) try self.active.rebuild(self.store);
        if (self.active.count() != 0) return false;
        var pending = (try self.store.pendingPayloads(self.allocator)) orelse return true;
        defer pending.deinit();
        const first = try pending.nextBorrowed();
        self.store.observeFirstPending(if (first) |entry| entry.key else null);
        return first == null;
    }

    /// A tick holds the mutex across its RPCs. When it runs on a fiber beside
    /// its owner's other fibers (one thread), a sibling must not block that
    /// thread on the mutex: it parks in short slices until the tick is done.
    fn lock(self: *Service) void {
        if (!@import("../runtime/fiber.zig").inFiber()) return self.mutex.lock();
        while (!self.mutex.tryLock()) {
            var nap: @import("../runtime/fiber.zig").Waiter = .{};
            _ = nap.waitTimeout(@import("../runtime/fiber.zig").monoMs() + 1);
        }
    }

    pub fn tick(self: *Service, now_ms: u64, limits: TickLimits) !Report {
        self.lock();
        defer self.mutex.unlock();
        if (self.cancel.load(.acquire)) return error.Cancelled;
        if (limits.max_transactions == 0 or limits.max_receipts == 0 or limits.max_payload_scan == 0) return error.InvalidTickLimits;
        var report: Report = .{};
        const started_ms = std.time.milliTimestamp();
        self.oldest_unchecked_age_seconds = 0;
        try self.reconcilePendingPage(limits.max_payload_scan);
        var boundary_ready = true;
        // The finalized-nonce boundary only matters for building, submitting
        // or recovering transactions. When idle, refresh it rarely (as
        // Source's nonce poll backs off to 5 minutes) instead of every block.
        const has_work = self.pending_payloads != 0 or self.queued_transactions != 0 or !self.recovery_complete or !self.payload_reconcile_complete or self.reorg_active != null;
        if (!has_work and self.next_boundary_refresh_ms != 0 and now_ms -| self.boundary_refreshed_ms < idle_boundary_refresh_ms) {
            // Idle: boundary stays valid; nothing will consume it this tick.
        } else if (now_ms >= self.next_boundary_refresh_ms) {
            const account_nonce = self.chain.accountNonceFinalized(self.config.signer.address) catch {
                self.metric(.{ .call_retries = .{ .name = "account_nonce" } });
                report.deferred += 1;
                boundary_ready = false;
                return self.tickAfterBoundaryError(now_ms, limits, &report);
            };
            self.nonces.updateBoundaryFromAccountNonce(self.allocator, account_nonce) catch {
                report.deferred += 1;
                boundary_ready = false;
            };
            if (boundary_ready) {
                self.next_boundary_refresh_ms = now_ms + self.config.estimated_block_time_ms;
                self.boundary_refreshed_ms = now_ms;
                self.metric(.{ .finalized_nonce = .{ .signer = self.config.signer.address, .value = if (account_nonce == 0) 0 else account_nonce - 1 } });
                if (self.store.upperNonce(self.allocator, self.config.signer.address)) |upper| self.metric(.{ .upper_nonce = .{ .signer = self.config.signer.address, .value = upper } }) else |_| {}
            }
        }
        try self.processReorg(limits.max_reorg, &report);
        // Reorg handling can reactivate or rewrite transactions: reschedule all.
        if (report.reprocessed != 0) {
            self.checks.clearRetainingCapacity();
            self.clearRows();
        }
        try self.scanTransactions(now_ms, limits, boundary_ready, &report);
        try self.buildPending(now_ms, limits, &report);
        self.tickMetrics(&report, started_ms);
        report.recovery_complete = self.recovery_complete;
        if (@import("builtin").is_test and !try self.active.matchesStore(self.store)) return error.ActiveSetDiverged;
        if (@import("builtin").is_test and !try self.rowsMatchStore()) return error.RetainedRowDiverged;
        if (@import("builtin").is_test and !try self.store.pendingFloorHolds(self.allocator)) return error.PendingFloorAboveRow;
        return report;
    }

    fn tickAfterBoundaryError(self: *Service, now_ms: u64, limits: TickLimits, report: *Report) !Report {
        const started_ms = std.time.milliTimestamp();
        self.oldest_unchecked_age_seconds = 0;
        try self.scanTransactions(now_ms, limits, false, report);
        try self.buildPending(now_ms, limits, report);
        self.tickMetrics(report, started_ms);
        report.recovery_complete = self.recovery_complete;
        if (@import("builtin").is_test and !try self.active.matchesStore(self.store)) return error.ActiveSetDiverged;
        if (@import("builtin").is_test and !try self.rowsMatchStore()) return error.RetainedRowDiverged;
        if (@import("builtin").is_test and !try self.store.pendingFloorHolds(self.allocator)) return error.PendingFloorAboveRow;
        return report.*;
    }

    fn reconcilePendingPage(self: *Service, maximum: usize) !void {
        if (self.payload_reconcile_complete) return;
        var count: usize = 0;
        while (self.payload_reconcile_cursor > 0 and count < maximum) : (count += 1) {
            const index = self.payload_reconcile_cursor;
            self.payload_reconcile_cursor -= 1;
            const uuid = (try self.store.payloadUuidByIndex(self.allocator, index)) orelse continue;
            const json = (try self.store.loadPayloadBytes(self.allocator, uuid)) orelse continue;
            defer self.allocator.free(json);
            var arena = std.heap.ArenaAllocator.init(self.allocator);
            defer arena.deinit();
            const view = try records.PayloadView.parse(arena.allocator(), json);
            const status = try view.statusValue(arena.allocator());
            const pending = (status == .string and std.mem.eql(u8, status.string, "ReadyToSubmit")) or (status == .object and status.object.contains("Retry"));
            if (pending) self.pending_payloads +|= 1;
            try self.store.reconcilePendingEntry(self.allocator, index, json, pending);
        }
        if (self.payload_reconcile_cursor == 0) {
            try self.store.finishPendingReconciliation(self.allocator);
            self.payload_reconcile_complete = true;
        }
    }

    fn processReorg(self: *Service, maximum: usize, report: *Report) !void {
        const range = (try self.store.reorgRange(self.allocator, self.config.signer.address)) orelse {
            self.reorg_cursor = null;
            self.reorg_active = null;
            return;
        };
        if (self.reorg_active == null or self.reorg_active.?.start != range.start or self.reorg_active.?.end != range.end) {
            self.reorg_cursor = range.start;
            self.reorg_active = range;
        }
        var current = self.reorg_cursor orelse range.start;
        var count: usize = 0;
        while (current <= range.end and count < maximum) : (count += 1) {
            const uuid = try self.store.trackedUuid(self.allocator, self.config.signer.address, current);
            if (!std.mem.eql(u8, &uuid, &types.nil_uuid)) {
                if (try self.store.loadTransaction(self.allocator, uuid)) |value| {
                    var record = value;
                    defer record.deinit();
                    var arena = std.heap.ArenaAllocator.init(self.allocator);
                    defer arena.deinit();
                    const previous = try records.status(record.value());
                    if (self.recovery_complete and !previous.isActive()) self.queued_transactions +|= 1;
                    if (self.recovery_complete and previous == .included) self.included_transactions -|= 1;
                    try records.setStatus(&record.parsed.value, arena.allocator(), .pending_inclusion);
                    const json = try std.json.Stringify.valueAlloc(self.allocator, record.value(), .{});
                    defer self.allocator.free(json);
                    // Written behind any retained row: decode it again.
                    self.evictRow(uuid);
                    try self.store.writeTransaction(self.allocator, uuid, json);
                    report.reprocessed += 1;
                }
            }
            if (current == range.end) {
                self.reorg_cursor = null;
                self.reorg_active = null;
                var clear = try self.store.typed.batch(self.allocator);
                defer clear.deinit();
                try storage.Store.putReorgRange(&clear, self.config.signer.address, null);
                try clear.commitSync();
                return;
            }
            current +|= 1;
            self.reorg_cursor = current;
        }
    }

    fn scanTransactions(self: *Service, now_ms: u64, limits: TickLimits, boundary_ready: bool, report: *Report) !void {
        if (self.fast_recovery) return self.scanActiveTransactions(now_ms, limits, boundary_ready, report);
        if (self.scan_cursor == 0) self.scan_cursor = try self.store.highestTransactionIndex(self.allocator);
        self.recovery_blocked = false;
        var scanned: usize = 0;
        while (self.scan_cursor > 0 and scanned < limits.max_transactions and report.receipts_read < limits.max_receipts) {
            const index = self.scan_cursor;
            scanned += 1;
            const uuid = (try self.store.transactionUuidByIndex(self.allocator, index)) orelse {
                self.past_old_boundary = true;
                self.scan_cursor -= 1;
                continue;
            };
            const row = (try self.loadRow(uuid)) orelse {
                self.past_old_boundary = true;
                try self.store.setActive(self.allocator, index, uuid, false);
                self.scan_cursor -= 1;
                continue;
            };
            defer self.dropRow(row);
            const status = try records.status(row.value());
            if (!status.isActive()) {
                self.past_old_boundary = true;
                try self.store.setActive(self.allocator, index, uuid, false);
                self.scan_cursor -= 1;
                continue;
            }
            self.trackOldest(row.value(), now_ms);
            report.transactions_scanned += 1;
            if (!self.recovery_complete) {
                self.queued_transactions +|= 1;
                if (status == .included) self.included_transactions +|= 1;
            }
            const completed = self.reconcileRow(row, now_ms, limits, boundary_ready, report) catch |err| blk: {
                std.log.warn("transaction reconciliation failed: {s}", .{@errorName(err)});
                self.metric(.{ .inclusion_error = .{ .name = "transaction_lifecycle" } });
                self.metric(.{ .call_retries = .{ .name = "transaction_lifecycle" } });
                report.deferred += 1;
                break :blk false;
            };
            if (completed) {
                self.scan_cursor -= 1;
            } else if (self.recovery_complete) {
                self.scan_cursor -= 1;
            } else {
                self.recovery_blocked = true;
                break;
            }
        }
        if (self.scan_cursor == 0 and !self.recovery_blocked and self.receipt_progress.count() == 0) {
            self.recovery_complete = true;
            try self.store.setActiveCheckpoint(self.allocator);
            self.fast_recovery = true;
        }
    }

    fn scanActiveTransactions(self: *Service, now_ms: u64, limits: TickLimits, boundary_ready: bool, report: *Report) !void {
        self.recovery_blocked = false;
        var scanned: usize = 0;
        while (scanned < limits.max_transactions and report.receipts_read < limits.max_receipts) {
            // A failed write in the previous step left the mirror stale.
            if (!self.active.fresh) try self.active.rebuild(self.store);
            // Looked up per step: reconciliation removes entries as it goes.
            const entry = self.active.atOrAfter(self.active_cursor) orelse {
                self.recovery_complete = true;
                self.active_cursor = 0;
                return;
            };
            const index = entry.index;
            self.active_cursor = if (index == std.math.maxInt(u32)) 0 else index + 1;
            const uuid = entry.uuid;
            if (self.recovery_complete) if (self.checks.get(uuid)) |check| if (!check.due(self.config.estimated_block_time_ms, now_ms)) {
                self.oldest_unchecked_age_seconds = @max(self.oldest_unchecked_age_seconds, now_ms / 1000 -| check.last_ms / 1000);
                report.transactions_scanned += 1;
                scanned += 1;
                continue;
            };
            // Retained only after recovery and only while it succeeds.
            const row = self.rows.get(uuid) orelse (try self.loadRow(uuid)) orelse {
                try self.store.setActive(self.allocator, index, uuid, false);
                continue;
            };
            var retain = false;
            defer if (retain) self.retainRow(row) else self.dropRow(row);
            const status = try records.status(row.value());
            if (!status.isActive()) {
                try self.store.setActive(self.allocator, index, uuid, false);
                continue;
            }
            self.trackOldest(row.value(), now_ms);
            report.transactions_scanned += 1;
            if (!self.recovery_complete) {
                self.queued_transactions +|= 1;
                if (status == .included) self.included_transactions +|= 1;
            }
            if (self.recovery_complete and status != .included and !readyForProcessing(row.value(), self.config.estimated_block_time_ms, now_ms)) {
                self.rememberPersistedCheck(uuid, row.value());
                retain = true;
                scanned += 1;
                continue;
            }
            var failed = false;
            const completed = self.reconcileRow(row, now_ms, limits, boundary_ready, report) catch blk: {
                self.metric(.{ .inclusion_error = .{ .name = "transaction_lifecycle" } });
                self.metric(.{ .call_retries = .{ .name = "transaction_lifecycle" } });
                report.deferred += 1;
                failed = true;
                break :blk false;
            };
            retain = !failed and self.recovery_complete;
            if (completed and self.recovery_complete) self.rememberCheck(uuid, row.value(), now_ms);
            scanned += 1;
            if (!completed and !self.recovery_complete) {
                self.recovery_blocked = true;
                self.active_cursor = index;
                break;
            }
        }
    }

    /// Reconciles a row; on success the row equals the stored row again (see
    /// `rows`). A check that wrote nothing changed at most `status` and
    /// `last_status_check`, which are restored; on error the caller drops it.
    fn reconcileRow(self: *Service, row: *Row, now_ms: u64, limits: TickLimits, boundary_ready: bool, report: *Report) !bool {
        const value = &row.record.parsed.value;
        if (value.* != .object) return error.InvalidLanderRecord;
        const saved_status = value.object.get("status");
        const saved_check = value.object.get("last_status_check");
        const writes = self.row_writes;
        const completed = try self.reconcileTransaction(row, now_ms, limits, boundary_ready, report);
        if (self.row_writes == writes) {
            try restoreField(value, "status", saved_status);
            try restoreField(value, "last_status_check", saved_check);
        }
        try self.boundRowGrowth(row);
        return completed;
    }

    fn restoreField(value: *std.json.Value, name: []const u8, saved: ?std.json.Value) !void {
        if (saved) |previous| {
            // Present before, so present now: no allocation.
            try value.object.put(name, previous);
        } else {
            _ = value.object.orderedRemove(name);
        }
    }

    fn reconcileTransaction(self: *Service, row: *Row, now_ms: u64, limits: TickLimits, boundary_ready: bool, report: *Report) !bool {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const record = &row.record;
        const owned = row.arena();
        const uuid = try records.transactionUuid(record.value());
        const previous_status = try records.status(record.value());
        const observation = try self.reconcileReceipts(record, allocator, limits, report) orelse return false;
        const observed = observation.status;
        if (self.recovery_complete) {
            if (previous_status == .included and observed != .included and observed != .finalized) self.included_transactions -|= 1;
            if (previous_status != .included and observed == .included) self.included_transactions +|= 1;
        }
        try records.setStatus(&record.parsed.value, owned, observed);
        try records.setTimestamp(&record.parsed.value, "last_status_check", try records.timestamp(owned, now_ms));
        if (observed == .included or observed == .finalized) {
            const finalized_height = observation.finalized_height orelse try self.chain.finalizedHeight();
            const delivery_height = if (observed == .included) (try self.chain.latestBlock()).number else finalized_height;
            try self.writePayloadOutcomes(row, allocator, observed, delivery_height, observation.winning, report, sameStatus(previous_status, observed));
            if (observed == .finalized) {
                try self.clearProgress(uuid);
                self.queued_transactions -|= 1;
                self.included_transactions -|= 1;
                report.finalized += 1;
            }
            return true;
        }
        // An unchanged status only advanced last_status_check, which the
        // in-memory schedule now owns; skip the rewrite and its fsync.
        if (!(self.recovery_complete and sameStatus(previous_status, observed))) try self.writeRow(row, allocator);
        if (observed == .dropped) {
            try self.clearProgress(uuid);
            self.queued_transactions -|= 1;
            return true;
        }
        if (!self.recovery_complete and (self.fast_recovery or self.past_old_boundary)) {
            if (try self.staleRecovered(record, allocator)) {
                try records.setStatus(&record.parsed.value, owned, .{ .dropped = .{ .other = "stale recovered transaction: payloads already delivered or terminal" } });
                try self.writeRow(row, allocator);
                self.metric(.{ .dropped_transaction = .{ .name = "Other" } });
                try self.clearProgress(uuid);
                self.queued_transactions -|= 1;
                report.stale_dropped += 1;
            }
            return true;
        }
        if (!boundary_ready) return true;
        try self.submit(row, allocator, uuid, now_ms, observed, report);
        return true;
    }

    fn reconcileReceipts(self: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator, limits: TickLimits, report: *Report) !?Observed {
        const uuid = try records.transactionUuid(record.value());
        const tx_hashes = try records.hashes(allocator, record.value());
        if (tx_hashes.len == 0) return .{ .status = .pending_inclusion };
        const progress = try ensureReceiptProgress(&self.receipt_progress, self.allocator, uuid, tx_hashes.len);
        // One finalized-height read per reconciliation, shared by every receipt
        // and by the caller. Only a receipt at or below it can classify as
        // finalized, so only those need their block's canonical header; an
        // included receipt above it is provisional and is re-read next check.
        var finalized_height: ?u64 = null;
        while (progress.next < tx_hashes.len and report.receipts_read < limits.max_receipts) {
            const index = progress.next;
            const hash = tx_hashes[index];
            report.receipts_read += 1;
            var item: ReceiptItem = .{ .read = true };
            if (try self.chain.receipt(hash)) |receipt_value| {
                item.hash = hash;
                item.gas_used = receipt_value.gas_used;
                item.effective_gas_price = receipt_value.effective_gas_price;
                item.executed = receipt_value.executed;
                if (receipt_value.block_number) |number| {
                    if (receipt_value.block_hash) |receipt_hash| {
                        if (finalized_height == null) finalized_height = try self.chain.finalizedHeight();
                        item.block = number;
                        item.block_hash = receipt_hash;
                        item.status = .included;
                        if (number <= finalized_height.?) try self.verifyReceiptBlock(&item);
                    }
                } else {
                    item.status = .mempool;
                }
            }
            progress.items[index] = item;
            progress.next += 1;
        }
        if (progress.next < tx_hashes.len) return null;
        if (finalized_height == null) finalized_height = try self.chain.finalizedHeight();
        const finalized = finalized_height.?;
        // A receipt read in an earlier tick may have become finalizable since.
        for (progress.items) |*item| if (item.block) |number| if (number <= finalized and !item.verified) try self.verifyReceiptBlock(item);
        var statuses = try allocator.alloc(?types.Status, tx_hashes.len);
        for (progress.items, 0..) |item, i| {
            if (!item.read or item.status == null) {
                statuses[i] = null;
            } else if (item.block) |number| {
                statuses[i] = if (number <= finalized) .finalized else .included;
            } else {
                statuses[i] = item.status.?;
            }
        }
        const classified = types.classify(statuses);
        var winning: ?WinningReceipt = null;
        for (progress.items) |item| {
            if (item.hash == null or item.block == null) continue;
            if (classified == .finalized and item.block.? <= finalized) {
                winning = .{ .hash = item.hash.?, .block_number = item.block.?, .block_hash = item.block_hash.?, .gas_used = item.gas_used, .effective_gas_price = item.effective_gas_price, .executed = item.executed };
                break;
            }
            if (classified == .included and item.block.? > finalized) {
                winning = .{ .hash = item.hash.?, .block_number = item.block.?, .block_hash = item.block_hash.?, .gas_used = item.gas_used, .effective_gas_price = item.effective_gas_price, .executed = item.executed };
                break;
            }
        }
        try self.clearProgress(uuid);
        return .{ .status = classified, .winning = winning, .finalized_height = finalized };
    }

    /// Canonical-block membership of a receipt about to count as finalized:
    /// its block hash must match the header at its height, else the receipt
    /// is treated as not yet included (as a reorged receipt is).
    fn verifyReceiptBlock(self: *Service, item: *ReceiptItem) !void {
        const number = item.block.?;
        const header = try self.chain.blockHeader(number);
        if (header.number == number and std.mem.eql(u8, &header.hash, &item.block_hash.?)) {
            item.verified = true;
            return;
        }
        item.status = .pending_inclusion;
        item.block = null;
    }

    fn clearProgress(self: *Service, uuid: types.Uuid) !void {
        if (self.receipt_progress.fetchRemove(uuid)) |removed| self.allocator.free(removed.value.items);
    }

    fn writePayloadOutcomes(self: *Service, row: *Row, allocator: std.mem.Allocator, observed: types.Status, finalized_height: u64, winning: ?WinningReceipt, report: *Report, unchanged: bool) !void {
        const record = &row.record;
        const payload_uuids = try records.payloadTransactionUuids(allocator, record.value());
        const updates = try allocator.alloc(storage.PayloadUpdate, payload_uuids.len);
        const outcomes = try allocator.alloc(observer.PayloadOutcome, payload_uuids.len);
        const previous_reverted = report.reverted_payloads;
        // Views of the stored rows, read only when needed (null: not read).
        const payloads = try allocator.alloc(?records.PayloadView, payload_uuids.len);
        @memset(payloads, null);
        const facts = row.payloads orelse blk: {
            const loaded = try self.allocator.alloc(PayloadFacts, payload_uuids.len);
            var count: usize = 0;
            errdefer {
                for (loaded[0..count]) |*item| item.deinit(self.allocator);
                self.allocator.free(loaded);
            }
            for (payload_uuids, payloads, loaded) |payload_uuid, *payload, *item| {
                payload.* = try self.loadPayloadView(allocator, payload_uuid);
                item.* = try self.payloadFacts(allocator, payload.*.?);
                count += 1;
            }
            row.payloads = loaded;
            break :blk loaded;
        };
        if (facts.len != payload_uuids.len) return error.InvalidLanderRecord;
        const delivered_flags = try allocator.alloc(bool, payload_uuids.len);
        // Success criteria are independent reads at one height: one
        // overlapped round instead of one round trip per payload.
        const checks = try allocator.alloc(chain.Call, payload_uuids.len);
        const check_of = try allocator.alloc(?usize, payload_uuids.len);
        var check_count: usize = 0;
        for (payload_uuids, facts, check_of) |payload_uuid, item, *slot| {
            if (!std.mem.eql(u8, &payload_uuid, &item.uuid)) return error.InvalidLanderRecord;
            slot.* = null;
            if (item.call) |check| {
                checks[check_count] = check;
                slot.* = check_count;
                check_count += 1;
            }
        }
        const results = try allocator.alloc([]u8, check_count);
        try self.chain.callMany(allocator, checks[0..check_count], finalized_height, results);
        var all_delivered = true;
        for (check_of, delivered_flags) |slot, *delivered| {
            delivered.* = if (slot) |index| try abi.decodeBool(results[index]) else true;
            all_delivered = all_delivered and delivered.*;
        }
        // Still included, every payload still delivered and already stored
        // with that status: the records carry exactly this outcome. Skip the
        // re-encode and fsync that only refreshed last_status_check.
        const target = try records.payloadStatusText(allocator, observed);
        if (unchanged and observed == .included and all_delivered and self.recovery_complete) {
            const stored = for (facts) |item| {
                if (!std.mem.eql(u8, target, item.status)) break false;
            } else true;
            if (stored) return;
        }
        const statuses = try allocator.alloc([]const u8, payload_uuids.len);
        for (payload_uuids, payloads, facts, delivered_flags, statuses, 0..) |payload_uuid, *payload, item, delivered, *status, i| {
            if (!delivered) report.reverted_payloads += 1;
            if (payload.* == null) payload.* = try self.loadPayloadView(allocator, payload_uuid);
            status.* = if (delivered) target else records.payload_reverted_status;
            updates[i] = .{ .uuid = payload_uuid, .canonical_json = try payload.*.?.withStatus(allocator, status.*) };
            outcomes[i] = .{ .uuid = payload_uuid, .delivered = delivered, .estimated_gas = item.gas_limit };
        }
        if (observed == .finalized) try self.emitFinalizedOutcome(record, winning, outcomes);
        const projection = if (observed == .finalized) try finalizedProjection(record, winning) else null;
        // The new statuses are copied first: the write cannot be undone.
        const written = try allocator.alloc([]u8, facts.len);
        var copied: usize = 0;
        var adopted = false;
        defer if (!adopted) for (written[0..copied]) |copy| self.allocator.free(copy);
        for (written, statuses) |*copy, status| {
            copy.* = try self.allocator.dupe(u8, status);
            copied += 1;
        }
        try self.writeRowAndPayloads(row, allocator, updates, projection);
        for (facts, written) |*item, copy| {
            self.allocator.free(item.status);
            item.status = copy;
        }
        adopted = true;
        for (previous_reverted..report.reverted_payloads) |_| self.metric(.{ .dropped_payload = .{ .name = "Reverted" } });
        if (observed == .finalized) self.metric(.finalized_transaction);
    }

    fn finalizedProjection(record: *storage.JsonRecord, winning: ?WinningReceipt) !storage.FinalizedReceipt {
        const receipt = winning orelse return error.MissingFinalizedOutcome;
        return .{
            .transaction_uuid = try records.transactionUuid(record.value()),
            .transaction_hash = receipt.hash,
            .block_number = receipt.block_number,
            .block_hash = receipt.block_hash,
            .executed = receipt.executed,
            .gas_used = receipt.gas_used orelse return error.MissingFinalizedOutcome,
            .effective_gas_price = receipt.effective_gas_price,
        };
    }

    fn emitFinalizedOutcome(self: *Service, record: *storage.JsonRecord, winning: ?WinningReceipt, outcomes: []const observer.PayloadOutcome) !void {
        const obs = self.config.observer orelse return;
        if (obs.finalized_fn == null) return;
        const receipt = winning orelse return error.MissingFinalizedOutcome;
        const gas_used = receipt.gas_used orelse return error.MissingFinalizedOutcome;
        const gas_price = receipt.effective_gas_price orelse return error.MissingFinalizedOutcome;
        const transaction_uuid = try records.transactionUuid(record.value());
        var total_estimated: u256 = 0;
        for (outcomes) |outcome| total_estimated = gas.satAdd(total_estimated, outcome.estimated_gas);
        try obs.finalized(.{
            .outcome_id = observer.outcomeId(transaction_uuid, receipt.hash),
            .transaction_uuid = transaction_uuid,
            .winning_hash = receipt.hash,
            .executed = receipt.executed,
            .gas_used = gas_used,
            .effective_gas_price = gas_price,
            .total_estimated_gas = total_estimated,
            .payloads = outcomes,
        });
    }

    fn loadPayloadView(self: *Service, allocator: std.mem.Allocator, uuid: types.Uuid) !records.PayloadView {
        self.payload_loads += 1;
        const bytes = (try self.store.loadPayloadBytes(allocator, uuid)) orelse return error.MissingPayload;
        return records.PayloadView.parse(allocator, bytes);
    }

    fn payloadDelivered(self: *Service, allocator: std.mem.Allocator, payload: records.PayloadView, block: u64) !bool {
        const check = (try self.deliveryCall(allocator, payload)) orelse return true;
        return abi.decodeBool(try self.chain.call(allocator, check, block));
    }

    /// The read that decides whether `payload` was delivered (null: no
    /// criteria, delivered by inclusion). Allocations live in `allocator`.
    fn deliveryCall(self: *Service, allocator: std.mem.Allocator, payload: records.PayloadView) !?chain.Call {
        const uuid = try payload.uuid(allocator);
        if (try self.store.delivery(allocator, uuid)) |owned_value| {
            const owned = owned_value;
            switch (owned.value) {
                .none => {},
                .mailbox_message => |id| {
                    const to = try abi.fixedHex(32, try payload.toText(allocator));
                    if (!std.mem.allEqual(u8, to[0..12], 0)) return error.InvalidMailboxAddress;
                    const calldata = try allocator.dupe(u8, &abi.hashCall("delivered(bytes32)", id));
                    return .{ .from = self.config.signer.address, .to = to[12..32].*, .calldata = calldata };
                },
                .contract => |call| return .{ .from = self.config.signer.address, .to = call.to, .calldata = call.calldata },
            }
        }
        const bytes = (try payload.successCriteriaBytes(allocator)) orelse return null;
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{});
        if (parsed != .array or parsed.array.items.len != 2) return error.InvalidSuccessCriteria;
        const request = try types.parseRequest(allocator, parsed.array.items[0]);
        const to = switch (request.request) {
            .legacy => |tx| tx.to,
            .eip2930 => |tx| tx.to,
            .eip1559 => |tx| tx.to,
        } orelse return error.InvalidSuccessCriteria;
        return .{ .from = self.config.signer.address, .to = to, .calldata = request.owned_data };
    }

    fn staleRecovered(self: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator) !bool {
        const payload_uuids = try records.payloadTransactionUuids(allocator, record.value());
        if (payload_uuids.len == 0) return false;
        const height = self.chain.finalizedHeight() catch return false;
        for (payload_uuids) |uuid| {
            const payload_bytes = (try self.store.loadPayloadBytes(allocator, uuid)) orelse return false;
            const payload = try records.PayloadView.parse(allocator, payload_bytes);
            const status_value = try payload.statusValue(allocator);
            if (status_value == .object and status_value.object.contains("Dropped")) {
                const reason = status_value.object.get("Dropped").?;
                if (reason == .string and std.mem.eql(u8, reason.string, "Reverted")) return false;
                continue;
            }
            if (status_value == .object) if (status_value.object.get("InTransaction")) |inner| {
                const status = try types.statusFromJson(inner);
                if (status == .finalized or status == .dropped) continue;
            };
            if (try self.store.delivery(allocator, uuid)) |proof| {
                if (proof.value == .none) return false;
            } else {
                const criteria = payload.success_criteria orelse return false;
                if (std.mem.eql(u8, criteria, "null")) return false;
            }
            if (!try self.payloadDelivered(allocator, payload, height)) return false;
        }
        return true;
    }

    fn metric(self: *Service, event: observer.Metric) void {
        if (self.config.observer) |obs| obs.metric(event) catch {};
    }

    fn tickMetrics(self: *Service, report: *const Report, started_ms: i64) void {
        if (report.transactions_scanned > 0) {
            self.metric(.{ .status_read_batch = report.transactions_scanned });
            self.metric(.{ .status_read_requests = 1 });
            self.metric(.{ .status_read_requests_avoided = report.transactions_scanned - 1 });
        }
        const now_seconds: u64 = @intCast(@max(std.time.timestamp(), 0));
        self.metric(.{ .task_liveness = .{ .stage = .building, .unix_seconds = now_seconds } });
        self.metric(.{ .task_liveness = .{ .stage = .inclusion, .unix_seconds = now_seconds } });
        self.metric(.{ .task_liveness = .{ .stage = .finality, .unix_seconds = now_seconds } });
        self.metric(.{ .building_queue_length = self.pending_payloads });
        self.metric(.{ .inclusion_pool_length = self.queued_transactions });
        self.metric(.{ .finality_pool_length = self.included_transactions });
        self.metric(.{ .oldest_unchecked_transaction_age_seconds = self.oldest_unchecked_age_seconds });
        self.metric(.{ .status_scan_duration_milliseconds = @intCast(@max(std.time.milliTimestamp() - started_ms, 0)) });
    }

    fn submit(self: *Service, row: *Row, allocator: std.mem.Allocator, uuid: types.Uuid, now_ms: u64, observed: types.Status, report: *Report) !void {
        const record = &row.record;
        const owned = row.arena();
        if (types.optionalField(record.value(), "last_submission_attempt")) |last| if (last != .null) {
            const elapsed = now_ms -| ((try rfc3339(last.string)) * 1000);
            if (elapsed <= @max(self.config.estimated_block_time_ms, 1000)) return;
        };
        const submission = try self.submissionChain(record, allocator);
        const simulated = if (!self.config.bypass_batch_simulation and (try types.uintField(record.value(), "submission_attempts")) == 0) try self.simulateBatch(row, allocator, submission) else null;
        const previous_nonce = try types.optionalUint(try types.requestFromRecord(record.value()), "nonce");
        // The simulation's latest block also prices and caps this submission.
        var prepared = try self.prepareSubmission(record, allocator, submission, if (submission.context == self.chain.context) simulated else null);
        const old_price = try requestPrice(try types.requestFromRecord(record.value()));
        const db_nonce = try self.store.transactionNonce(allocator, self.config.signer.address, uuid);
        if (previous_nonce != db_nonce and (previous_nonce != null or db_nonce != null)) {
            self.metric(.{ .mismatched_nonce = .{ .signer = self.config.signer.address, .value = db_nonce orelse previous_nonce.? } });
        }
        const reservation = try self.nonces.validateAndReserve(allocator, uuid, previous_nonce, observed);
        if (self.store.upperNonce(self.allocator, self.config.signer.address)) |upper| self.metric(.{ .upper_nonce = .{ .signer = self.config.signer.address, .value = upper } }) else |_| {}
        const nonce_changed = previous_nonce == null or previous_nonce.? != reservation.nonce;
        setRequestNonce(&prepared.request, reservation.nonce);
        const price_unchanged = prepared.price != .none and std.meta.eql(old_price, prepared.price);
        if (!nonce_changed and price_unchanged and observed != .pending_inclusion) return;
        try types.updateRequest(try types.requestPtr(&record.parsed.value), owned, prepared.request);
        var signed: ?evm_transaction.SignedTransaction = null;
        var reused_bytes: ?[]u8 = null;
        const previous_hashes = try records.hashes(allocator, record.value());
        if (!nonce_changed and price_unchanged and previous_hashes.len > 0) {
            if (try self.store.loadAttempt(allocator, uuid, previous_hashes[previous_hashes.len - 1])) |attempt| {
                if (attempt.nonce == reservation.nonce) reused_bytes = attempt.bytes;
            }
        }
        // Effect gate: the nonce reservation and every row this transaction
        // depends on are durable before signing (db.rocks.Durability).
        try self.store.typed.database.effectGate();
        var hash: types.Hash = undefined;
        var bytes: []const u8 = undefined;
        if (reused_bytes) |existing| {
            bytes = existing;
            std.crypto.hash.sha3.Keccak256.hash(bytes, &hash, .{});
        } else {
            const digest = try prepared.request.signingHash(allocator);
            const signature = try self.config.signer.sign(digest);
            const recovered = try prepared.request.recoverSigner(allocator, signature);
            if (!std.mem.eql(u8, &recovered, &self.config.signer.address)) return error.SignerMismatch;
            const encoded = try prepared.request.encodeSigned(allocator, signature);
            signed = .{ .allocator = allocator, .bytes = encoded, .hash = undefined, .signature = signature, .signer = recovered };
            std.crypto.hash.sha3.Keccak256.hash(encoded, &signed.?.hash, .{});
            hash = signed.?.hash;
            bytes = encoded;
        }
        _ = try records.appendHash(&record.parsed.value, owned, hash);
        try records.incrementAttempts(&record.parsed.value);
        try records.setTimestamp(&record.parsed.value, "last_submission_attempt", try records.timestamp(owned, now_ms));
        {
            const json = try std.json.Stringify.valueAlloc(self.allocator, record.value(), .{});
            defer self.allocator.free(json);
            const write = try rowWrite(row, allocator, json);
            try self.store.writeSubmissionRow(self.allocator, write, if (reused_bytes != null) null else .{ .hash = hash, .nonce = reservation.nonce, .bytes = bytes });
            self.committedRow(row, write);
        }
        try self.store.typed.database.effectGate();
        const returned = submission.sendRaw(bytes) catch {
            if (self.config.mev_submission) |protected| {
                if (submission.context == protected.protected_chain.context) self.metric(.{ .mev_submission = false });
            }
            self.metric(.{ .call_retries = .{ .name = "send_raw_transaction" } });
            report.deferred += 1;
            return;
        };
        if (!std.mem.eql(u8, &returned, &hash)) return error.BroadcastHashMismatch;
        if (self.config.mev_submission) |protected| {
            if (submission.context == protected.protected_chain.context) self.metric(.{ .mev_submission = true });
        }
        try records.setStatus(&record.parsed.value, owned, .mempool);
        try self.writeRow(row, allocator);
        try self.clearProgress(uuid);
        const fee: observer.Metric.FeeMetric = switch (prepared.price) {
            .none => observer.Metric.FeeMetric{ .gas_price = null, .priority_fee = null, .gas_limit = requestGas(prepared.request) },
            .legacy => |price| .{ .gas_price = price, .priority_fee = null, .gas_limit = requestGas(prepared.request) },
            .eip1559 => |price| .{ .gas_price = price.max_fee, .priority_fee = price.max_priority_fee, .gas_limit = requestGas(prepared.request) },
        };
        self.metric(.{ .transaction_submission = fee });
        report.broadcasts += 1;
    }

    fn submissionChain(self: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator) !chain.Chain {
        const protected = self.config.mev_submission orelse return self.chain;
        const payload_uuids = try records.payloadTransactionUuids(allocator, record.value());
        for (payload_uuids) |payload_uuid| {
            const payload = try self.loadPayloadView(allocator, payload_uuid);
            const data = try payload.dataBytes(allocator);
            if (try mev.matchesPayload(protected.policy, data, allocator)) return protected.protected_chain;
        }
        return self.chain;
    }

    /// Returns the submission chain's latest block it simulated against.
    fn simulateBatch(self: *Service, row: *Row, allocator: std.mem.Allocator, submission: chain.Chain) !?chain.LatestBlock {
        const record = &row.record;
        const details = try types.field(record.value(), "payload_details");
        if (details.array.items.len <= 1) return null;
        const request = try types.parseRequest(allocator, try types.requestFromRecord(record.value()));
        const to = switch (request.request) {
            .legacy => |tx| tx.to,
            .eip2930 => |tx| tx.to,
            .eip1559 => |tx| tx.to,
        } orelse return error.InvalidBatch;
        const value = switch (request.request) {
            .legacy => |tx| tx.value,
            .eip2930 => |tx| tx.value,
            .eip1559 => |tx| tx.value,
        };
        const latest = try submission.latestBlock();
        const raw = try submission.call(allocator, .{ .from = self.config.signer.address, .to = to, .calldata = request.owned_data, .value = value }, latest.number);
        const results = try multicall.decode(allocator, raw, details.array.items.len);
        const payloads = try allocator.alloc(records.PayloadView, details.array.items.len);
        const survivors = try allocator.alloc(records.PayloadView, details.array.items.len);
        const calls = try allocator.alloc(multicall.Call, details.array.items.len);
        var survivor_count: usize = 0;
        var failed_count: usize = 0;
        var floor: u256 = 0;
        for (details.array.items, results, 0..) |detail, result, i| {
            payloads[i] = try self.loadPayloadView(allocator, try types.parseUuid(try types.stringField(detail, "uuid")));
            if (!result.success) {
                failed_count += 1;
                continue;
            }
            survivors[survivor_count] = payloads[i];
            survivor_count += 1;
            floor = gas.satAdd(floor, try payloads[i].gasLimit(allocator));
            const tuple = try payloads[i].dataTuple(allocator);
            const member = try types.parseRequest(allocator, tuple.array.items[0]);
            calls[survivor_count - 1] = switch (member.request) {
                .legacy => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
                .eip2930 => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
                .eip1559 => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
            };
        }
        if (survivor_count == 0) {
            try records.setStatus(&record.parsed.value, row.arena(), .{ .dropped = .{ .other = "Non-retryable error: simulation failed" } });
            const failed = try allocator.alloc(storage.PayloadUpdate, details.array.items.len);
            for (details.array.items, payloads, 0..) |detail, payload, i| {
                const payload_uuid = try types.parseUuid(try types.stringField(detail, "uuid"));
                failed[i] = .{ .uuid = payload_uuid, .canonical_json = try payload.withStatus(allocator, records.payload_simulation_failed_status) };
            }
            try self.writeRowAndPayloads(row, allocator, failed, null);
            self.queued_transactions -|= 1;
            self.metric(.{ .dropped_transaction = .{ .name = "Other" } });
            for (failed) |_| self.metric(.{ .dropped_payload = .{ .name = "FailedSimulation" } });
            return error.SimulationFailed;
        }
        const uuid = try records.transactionUuid(record.value());
        const timestamp = try types.stringField(record.value(), "creation_timestamp");
        var rebuilt: records.OwnedJson = .init(self.allocator);
        defer rebuilt.deinit();
        if (survivor_count == 1) {
            try records.createTransaction(&rebuilt, survivors[0], uuid, self.config.signer.address, self.config.chain_id, timestamp);
        } else {
            const batch_address = self.config.batch_contract_address orelse return error.SimulationFailed;
            if (floor != 0) floor = gas.satAdd(floor, gas.satMul(survivor_count, 3500));
            if (floor != 0) {
                const buffered = gas.bufferGasLimit(floor, self.config.arbitrum_nitro);
                _ = try gas.capGasLimit(buffered, buffered, latest.gas_limit, self.config.overrides);
            }
            if (!try self.batchContractPresent(allocator, batch_address)) return error.SimulationFailed;
            const encoded = try multicall.encode(allocator, calls[0..survivor_count]);
            try records.createBatchTransaction(&rebuilt, survivors[0..survivor_count], uuid, self.config.signer.address, self.config.chain_id, timestamp, batch_address, encoded.calldata, encoded.value);
        }
        const details_slot = record.parsed.value.object.getPtr("payload_details") orelse return error.InvalidLanderRecord;
        const vm_slot = record.parsed.value.object.getPtr("vm_specific_data") orelse return error.InvalidLanderRecord;
        // Managed JSON containers retain their arena allocator context. Clone
        // into the record's stable owner before the temporary rebuilt dies;
        // copying Value alone would retain freed buffers and a stack allocator.
        // Finish the fallible clone before replacing either existing field.
        const rebuilt_json = try rebuilt.stringify(allocator);
        const retained = try std.json.parseFromSliceLeaky(std.json.Value, record.parsed.arena.allocator(), rebuilt_json, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always });
        details_slot.* = retained.object.get("payload_details").?;
        vm_slot.* = retained.object.get("vm_specific_data").?;
        self.freePayloadFacts(row);
        const failed = try allocator.alloc(storage.PayloadUpdate, failed_count);
        var failed_index: usize = 0;
        for (details.array.items, results, payloads) |detail, result, payload| {
            if (result.success) continue;
            const payload_uuid = try types.parseUuid(try types.stringField(detail, "uuid"));
            failed[failed_index] = .{ .uuid = payload_uuid, .canonical_json = try payload.withStatus(allocator, records.payload_simulation_failed_status) };
            failed_index += 1;
        }
        try self.writeRowAndPayloads(row, allocator, failed, null);
        for (failed) |_| self.metric(.{ .dropped_payload = .{ .name = "FailedSimulation" } });
        return latest;
    }

    const Prepared = struct { request: types.Request, price: gas.GasPrice };

    fn prepareSubmission(self: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator, submission: chain.Chain, known_latest: ?chain.LatestBlock) !Prepared {
        const tx_json = try types.requestFromRecord(record.value());
        const info = try types.parseRequest(allocator, tx_json);
        var request = info.request;
        switch (request) {
            .legacy => {},
            .eip2930 => |*tx| if (tx.chain_id == 0) {
                tx.chain_id = self.config.chain_id;
            },
            .eip1559 => |*tx| if (tx.chain_id == 0) {
                tx.chain_id = self.config.chain_id;
            },
        }
        const latest = known_latest orelse try self.chain.latestBlock();
        const gas_latest = if (submission.context == self.chain.context) latest else try submission.latestBlock();
        const attempts = try types.uintField(record.value(), "submission_attempts");
        if (attempts == 0) {
            const details = try types.field(record.value(), "payload_details");
            if (details.array.items.len > 1) {
                setRequestGas(&request, try self.estimateBatchGas(record, allocator, submission, request, gas_latest));
            } else {
                const estimate = try submission.estimateGas(request, self.config.signer.address);
                const floor = requestGas(request);
                const limit = try gas.applyGasLimit(estimate, floor, gas_latest.gas_limit, self.config.arbitrum_nitro, self.config.overrides);
                setRequestGas(&request, limit);
            }
        }
        const old = try requestPrice(tx_json);
        var price: gas.GasPrice = undefined;
        if (self.config.overrides.gas_price) |configured| {
            price = gas.escalate(old, .{ .legacy = configured }, self.config.overrides);
        } else if (latest.base_fee == null or latest.base_fee.? == 0) {
            const precursor = if (tx_json == .object and tx_json.object.contains("gasPrice")) try types.optionalUint(tx_json, "gasPrice") else switch (old) {
                .eip1559 => |fee| fee.max_fee,
                else => null,
            };
            price = gas.escalate(old, gas.applyLegacyOverrides(precursor, self.config.overrides), self.config.overrides);
        } else if (self.config.zksync_stack) {
            const estimated = try submission.zksEstimateFee(request, self.config.signer.address);
            price = try gas.finish1559(old, latest.base_fee.?, .{ .max_fee = estimated.max_fee_per_gas, .max_priority_fee = estimated.max_priority_fee_per_gas }, self.config.overrides);
        } else {
            var history = try self.chain.feeHistory(allocator, 5);
            if (!gas.hasRewards(history.rewards)) {
                history.deinit();
                history = .{ .allocator = allocator, .rewards = try allocator.dupe(u256, &.{}) };
                for ([_]u64{ 10, 15, 20, 50 }) |percentile| {
                    var fallback = self.chain.feeHistory(allocator, percentile) catch continue;
                    if (gas.hasRewards(fallback.rewards)) {
                        history = fallback;
                        break;
                    }
                    fallback.deinit();
                }
            }
            const estimated = try gas.defaultEstimate(allocator, latest.base_fee.?, history.rewards);
            price = try gas.finish1559(old, latest.base_fee.?, estimated, self.config.overrides);
        }
        try applyPrice(&request, price, self.config.chain_id);
        return .{ .request = request, .price = price };
    }

    fn estimateBatchGas(self: *Service, record: *storage.JsonRecord, allocator: std.mem.Allocator, submission: chain.Chain, request: types.Request, latest: chain.LatestBlock) !u256 {
        const payload_uuids = try records.payloadTransactionUuids(allocator, record.value());
        var floor: u256 = 0;
        // Members and the batch estimate independently: one overlapped round.
        const requests = try allocator.alloc(types.Request, payload_uuids.len + 1);
        for (payload_uuids, requests[0..payload_uuids.len]) |payload_uuid, *member| {
            const payload = try self.loadPayloadView(allocator, payload_uuid);
            floor = gas.satAdd(floor, try payload.gasLimit(allocator));
            const tuple = try payload.dataTuple(allocator);
            member.* = (try types.parseRequest(allocator, tuple.array.items[0])).request;
        }
        requests[payload_uuids.len] = request;
        const estimates = try allocator.alloc(u256, requests.len);
        try submission.estimateGasMany(requests, self.config.signer.address, estimates);
        var estimate_sum: u256 = 0;
        for (requests[0..payload_uuids.len], estimates[0..payload_uuids.len]) |member, estimate| {
            const member_floor = requestGas(member);
            const capped = try gas.capGasLimit(@max(estimate, member_floor), member_floor, latest.gas_limit, self.config.overrides);
            estimate_sum = gas.satAdd(estimate_sum, gas.satAdd(capped, 3500));
        }
        if (floor != 0) floor = gas.satAdd(floor, gas.satMul(payload_uuids.len, 3500));
        const outer = estimates[payload_uuids.len];
        var result = @max(outer, estimate_sum);
        if (floor != 0) result = gas.bufferGasLimit(@max(result, floor), self.config.arbitrum_nitro);
        return gas.capGasLimit(@max(result, floor), floor, latest.gas_limit, self.config.overrides);
    }

    fn buildPending(self: *Service, now_ms: u64, limits: TickLimits, report: *Report) !void {
        if (!self.payload_reconcile_complete or !self.recovery_complete) return;
        var iterator = (try self.store.pendingPayloads(self.allocator)) orelse return;
        defer iterator.deinit();
        var observed = false;
        var scanned: usize = 0;
        while (scanned < limits.max_payload_scan and report.built < limits.max_build) {
            if (self.config.max_submit_queue_length) |maximum| {
                if (self.queued_transactions >= maximum) {
                    report.deferred += 1;
                    return;
                }
            }
            var group: std.ArrayList([]u8) = .empty;
            defer {
                for (group.items) |json| self.allocator.free(json);
                group.deinit(self.allocator);
            }
            while (group.items.len < self.config.max_batch_size and scanned < limits.max_payload_scan) : (scanned += 1) {
                const next = try iterator.next(self.allocator);
                if (!observed) {
                    observed = true;
                    self.store.observeFirstPending(if (next) |entry| entry.key[iterator.prefix_bytes.len..] else null);
                }
                var entry = next orelse break;
                defer entry.deinit();
                try group.append(self.allocator, try self.allocator.dupe(u8, entry.value));
            }
            if (group.items.len == 0) break;
            const built = self.buildGroup(now_ms, group.items) catch blk: {
                report.rejected += 1;
                break :blk @as(usize, 0);
            };
            self.queued_transactions +|= @intCast(built);
            if (built > 0) self.pending_payloads -|= group.items.len;
            report.built += built;
        }
    }

    fn buildGroup(self: *Service, now_ms: u64, group: []const []u8) !usize {
        if (group.len == 1) {
            try self.buildOne(now_ms, group[0]);
            return 1;
        }
        self.buildBatch(now_ms, group) catch {
            self.metric(.{ .batch_built = .{ .success = false, .payloads = group.len } });
            var built: usize = 0;
            for (group) |json| {
                self.buildOne(now_ms, json) catch continue;
                built += 1;
            }
            return built;
        };
        self.metric(.{ .batch_built = .{ .success = true, .payloads = group.len } });
        return 1;
    }

    fn checkAssociation(self: *Service, allocator: std.mem.Allocator, payload_uuid: types.Uuid) !void {
        if (try self.store.payloadTransaction(allocator, payload_uuid)) |existing| {
            if (!std.mem.eql(u8, &existing, &types.nil_uuid)) {
                var associated = (try self.store.transactionStatus(allocator, existing)) orelse return error.PayloadAssociationConflict;
                defer associated.deinit(allocator);
                if (associated.value != .dropped) return error.PayloadAssociationConflict;
            }
        }
    }

    fn buildOne(self: *Service, now_ms: u64, payload_json: []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const payload = try records.PayloadView.parse(allocator, payload_json);
        const payload_uuid = try payload.uuid(allocator);
        try self.checkAssociation(allocator, payload_uuid);
        const uuid = types.newUuid();
        var record = try self.newRecord();
        var record_owned = true;
        defer if (record_owned) record.deinit();
        const owned = record.parsed.arena.allocator();
        record.parsed.value = try records.transactionValue(owned, payload, uuid, self.config.signer.address, self.config.chain_id, try records.timestamp(owned, now_ms));
        const transaction_json = try std.json.Stringify.valueAlloc(self.allocator, record.value(), .{});
        defer self.allocator.free(transaction_json);
        const payload_updated = try payload.withStatus(allocator, try records.payloadStatusText(allocator, .pending_inclusion));
        const update = [_]storage.PayloadUpdate{.{ .uuid = payload_uuid, .canonical_json = payload_updated }};
        const index = try self.store.writeBuiltTransaction(self.allocator, uuid, transaction_json, &update);
        record_owned = false;
        self.retainBuilt(uuid, record, index);
    }

    fn newRecord(self: *Service) !storage.JsonRecord {
        const arena = try self.allocator.create(std.heap.ArenaAllocator);
        arena.* = .init(self.allocator);
        return .{ .parsed = .{ .arena = arena, .value = .null } };
    }

    /// Retains a just-written new row. Its payload details still borrow the
    /// payload rows' raw spans; they are decoded into the row's arena first,
    /// as a reader of the written bytes would have them. Failure only loses
    /// the entry.
    fn retainBuilt(self: *Service, uuid: types.Uuid, built: storage.JsonRecord, index: u32) void {
        var record = built;
        records.ownDetails(&record.parsed.value, record.parsed.arena.allocator()) catch return record.deinit();
        const row = self.newRow(uuid, record, index) catch return;
        self.retainRow(row);
    }

    fn buildBatch(self: *Service, now_ms: u64, group: []const []u8) !void {
        const batch_address = self.config.batch_contract_address orelse return error.MissingBatchContract;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const payloads = try allocator.alloc(records.PayloadView, group.len);
        const calls = try allocator.alloc(multicall.Call, group.len);
        var floor: u256 = 0;
        for (group, 0..) |json, i| {
            payloads[i] = try records.PayloadView.parse(allocator, json);
            const payload_uuid = try payloads[i].uuid(allocator);
            try self.checkAssociation(allocator, payload_uuid);
            floor = gas.satAdd(floor, try payloads[i].gasLimit(allocator));
            const tuple = try payloads[i].dataTuple(allocator);
            const request = try types.parseRequest(allocator, tuple.array.items[0]);
            calls[i] = switch (request.request) {
                .legacy => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
                .eip2930 => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
                .eip1559 => |tx| .{ .to = tx.to orelse return error.InvalidBatchCall, .value = tx.value, .data = tx.data },
            };
        }
        if (floor != 0) floor = gas.satAdd(floor, gas.satMul(group.len, 3500));
        if (floor != 0) {
            const latest = try self.chain.latestBlock();
            const buffered = gas.bufferGasLimit(floor, self.config.arbitrum_nitro);
            _ = try gas.capGasLimit(buffered, buffered, latest.gas_limit, self.config.overrides);
        }
        if (!try self.batchContractPresent(allocator, batch_address)) return error.BatchContractNotFound;
        const encoded = try multicall.encode(allocator, calls);
        const uuid = types.newUuid();
        var record = try self.newRecord();
        var record_owned = true;
        defer if (record_owned) record.deinit();
        const owned = record.parsed.arena.allocator();
        record.parsed.value = try records.batchTransactionValue(owned, payloads, uuid, self.config.signer.address, self.config.chain_id, try records.timestamp(owned, now_ms), batch_address, encoded.calldata, encoded.value);
        const updates = try allocator.alloc(storage.PayloadUpdate, payloads.len);
        const pending_status = try records.payloadStatusText(allocator, .pending_inclusion);
        for (payloads, 0..) |payload, i| {
            updates[i] = .{ .uuid = try payload.uuid(allocator), .canonical_json = try payload.withStatus(allocator, pending_status) };
        }
        const transaction_json = try std.json.Stringify.valueAlloc(self.allocator, record.value(), .{});
        defer self.allocator.free(transaction_json);
        const index = try self.store.writeBuiltTransaction(self.allocator, uuid, transaction_json, updates);
        record_owned = false;
        self.retainBuilt(uuid, record, index);
    }

    fn trackOldest(self: *Service, value: std.json.Value, now_ms: u64) void {
        const timestamp = if (types.optionalField(value, "last_status_check")) |last|
            if (last != .null) (rfc3339(last.string) catch return) else (rfc3339(types.stringField(value, "creation_timestamp") catch return) catch return)
        else
            return;
        self.oldest_unchecked_age_seconds = @max(self.oldest_unchecked_age_seconds, now_ms / 1000 -| timestamp);
    }
};

fn sameStatus(left: types.Status, right: types.Status) bool {
    if (left == .dropped or right == .dropped) return false;
    return std.meta.activeTag(left) == std.meta.activeTag(right);
}

fn readyForProcessing(value: std.json.Value, block_time_ms: u64, now_ms: u64) bool {
    const creation = (rfc3339(types.stringField(value, "creation_timestamp") catch return true) catch return true) * 1000;
    const last = types.optionalField(value, "last_status_check");
    const last_ms = if (last != null and last.? != .null) (rfc3339(last.?.string) catch return true) * 1000 else null;
    return backoff.ready(block_time_ms, now_ms, creation, last_ms);
}

fn deliveryMatches(stored: ?storage.OwnedDelivery, requested: storage.Delivery) bool {
    const value = if (stored) |owned| owned.value else return requested == .none;
    return switch (value) {
        .none => requested == .none,
        .mailbox_message => |id| switch (requested) {
            .mailbox_message => |other| std.mem.eql(u8, &id, &other),
            else => false,
        },
        .contract => |call| switch (requested) {
            .contract => |other| std.mem.eql(u8, &call.to, &other.to) and std.mem.eql(u8, call.calldata, other.calldata),
            else => false,
        },
    };
}

fn requestNonce(request: types.Request) ?u256 {
    return switch (request) {
        .legacy => |tx| if (tx.nonce == 0) null else tx.nonce,
        .eip2930 => |tx| if (tx.nonce == 0) null else tx.nonce,
        .eip1559 => |tx| if (tx.nonce == 0) null else tx.nonce,
    };
}

fn setRequestNonce(request: *types.Request, value: u256) void {
    switch (request.*) {
        .legacy => |*tx| tx.nonce = value,
        .eip2930 => |*tx| tx.nonce = value,
        .eip1559 => |*tx| tx.nonce = value,
    }
}

fn requestGas(request: types.Request) u256 {
    return switch (request) {
        .legacy => |tx| tx.gas_limit,
        .eip2930 => |tx| tx.gas_limit,
        .eip1559 => |tx| tx.gas_limit,
    };
}

fn setRequestGas(request: *types.Request, value: u256) void {
    switch (request.*) {
        .legacy => |*tx| tx.gas_limit = value,
        .eip2930 => |*tx| tx.gas_limit = value,
        .eip1559 => |*tx| tx.gas_limit = value,
    }
}

fn requestPrice(value: std.json.Value) !gas.GasPrice {
    const kind: std.json.Value = types.optionalField(value, "type") orelse .{ .string = "0x00" };
    if (kind != .string) return error.InvalidLanderRecord;
    if (std.mem.eql(u8, kind.string, "0x02")) {
        const max = try types.optionalUint(value, "maxFeePerGas");
        const priority = try types.optionalUint(value, "maxPriorityFeePerGas");
        if (max == null or priority == null) return .none;
        return .{ .eip1559 = .{ .max_fee = max.?, .max_priority_fee = priority.? } };
    }
    return if (try types.optionalUint(value, "gasPrice")) |price| .{ .legacy = price } else .none;
}

fn applyPrice(request: *types.Request, price: gas.GasPrice, chain_id: u256) !void {
    switch (price) {
        .none => {},
        .legacy => |value| switch (request.*) {
            .legacy => |*tx| tx.gas_price = value,
            .eip2930 => |*tx| tx.gas_price = value,
            .eip1559 => |*tx| {
                tx.max_fee_per_gas = value;
                tx.max_priority_fee_per_gas = value;
            },
        },
        .eip1559 => |fee| switch (request.*) {
            .legacy => |tx| request.* = .{ .eip1559 = .{
                .chain_id = tx.chain_id orelse chain_id,
                .nonce = tx.nonce,
                .max_priority_fee_per_gas = fee.max_priority_fee,
                .max_fee_per_gas = fee.max_fee,
                .gas_limit = tx.gas_limit,
                .to = tx.to,
                .value = tx.value,
                .data = tx.data,
            } },
            .eip2930 => |tx| request.* = .{ .eip1559 = .{
                .chain_id = tx.chain_id,
                .nonce = tx.nonce,
                .max_priority_fee_per_gas = fee.max_priority_fee,
                .max_fee_per_gas = fee.max_fee,
                .gas_limit = tx.gas_limit,
                .to = tx.to,
                .value = tx.value,
                .data = tx.data,
            } },
            .eip1559 => |*tx| {
                tx.max_fee_per_gas = fee.max_fee;
                tx.max_priority_fee_per_gas = fee.max_priority_fee;
                tx.access_list = &.{};
            },
        },
    }
}

test "new receipt progress entry is initialized before item OOM" {
    var progress = std.AutoHashMap(types.Uuid, ReceiptProgress).init(std.testing.allocator);
    try progress.ensureTotalCapacity(1);
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    progress.allocator = failing.allocator();
    const uuid: types.Uuid = @splat(0x61);
    try std.testing.expectError(error.OutOfMemory, ensureReceiptProgress(&progress, progress.allocator, uuid, 1));
    const inserted = progress.get(uuid).?;
    try std.testing.expectEqual(@as(usize, 0), inserted.items.len);
    try std.testing.expectEqual(@as(usize, 0), inserted.next);
    progress.allocator = std.testing.allocator;
    const ready = try ensureReceiptProgress(&progress, progress.allocator, uuid, 1);
    try std.testing.expectEqual(@as(usize, 1), ready.items.len);
    try std.testing.expect(!ready.items[0].read);
    defer {
        var iterator = progress.iterator();
        while (iterator.next()) |entry| if (entry.value_ptr.items.len > 0) std.testing.allocator.free(entry.value_ptr.items);
        progress.deinit();
    }
}
