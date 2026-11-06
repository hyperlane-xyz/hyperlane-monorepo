//! Destination-owned CCIP sessions bridging static metadata handlers to pinned
//! EVM lookups, bounded native HTTP retries, and caller-owned metadata.
const std = @import("std");
const builtin = @import("builtin");
const ccip = @import("../../relayer/ccip.zig");
const evm_source = @import("../../relayer/evm_source.zig");
const evm = @import("../../evm/root.zig");
const curl = @import("../../net/curl.zig");
const http_runtime = @import("../../net/http_runtime.zig");
const byte_budget = @import("../../net/byte_budget.zig");
const native = @import("../store.zig");
const protocol = @import("../../protocol/root.zig");
const Allocator = std.mem.Allocator;
const Address = [20]u8;
const Hash = [32]u8;
const Cancel = ?*const std.atomic.Value(bool);

pub const Options = struct {
    max_sessions: usize = 256,
    max_bytes: usize = 16 * 1024 * 1024,
    allow_caching: bool = true,
    cache_ttl_ms: u64 = 120000,
    active_ttl_ms: u64 = 120000,
    shared_budget: ?*byte_budget.Budget = null,
};

pub const OriginStore = struct {
    context: *anyopaque,
    dispatched_transaction_fn: *const fn (*anyopaque, Hash) anyerror!?[64]u8,

    pub fn fromStore(store: *native.Store) OriginStore {
        return .{ .context = store, .dispatched_transaction_fn = dispatchedTransaction };
    }

    fn dispatchedTransaction(context: *anyopaque, id: Hash) !?[64]u8 {
        const store: *native.Store = @ptrCast(@alignCast(context));
        return store.dispatchedTransaction(id);
    }

    pub fn dispatchedTransactionOrNull(self: OriginStore, id: Hash) !?[64]u8 {
        return self.dispatched_transaction_fn(self.context, id);
    }
};

pub const Context = struct {
    allocator: Allocator,
    origin_store: OriginStore,
    client: ?*evm.RpcClient = null,
    native_lookup: ?ccip.LookupSource = null,
    native: *curl.Client,
    runtime: ?*http_runtime.Runtime = null,
    signer: ?ccip.Signer = null,
    signer_provider: ?ccip.SignerProvider = null,
    signature_cache: ?*ccip.SignatureCache = null,
    block_number: u64,
    now_ms: u64,
    cancel: Cancel = null,
    context_hash: Hash,
    async_fixture: if (builtin.is_test) ?ccip.AsyncTransport else void = if (builtin.is_test) null else {},
};

const Key = struct {
    context_hash: Hash,
    ism: Address,
    message_id: Hash,
};

const Memo = struct {
    key: Key,
    bytes: []u8,
};

const Entry = struct {
    owner: ?*Owner = null,
    key: Key = std.mem.zeroes(Key),
    session: ?ccip.Session = null,
    metadata: ?[]u8 = null,
    borrowed: bool = false,
    touched: u64 = 0,
    expires_at_ms: u64 = 0,
    attempt_expires_at_ms: u64 = 0,
    runtime: ?*http_runtime.Runtime = null,
    async_handle: ?http_runtime.Handle = null,
    async_cost: usize = 0,
    async_fixture: if (builtin.is_test) ?ccip.AsyncTransport else void = if (builtin.is_test) null else {},
};

pub const Stats = struct {
    sessions: usize,
    borrowed: usize,
    bytes: usize,
};

pub const StepFixture = struct {
    context: *anyopaque,
    step_fn: *const fn (*anyopaque, *ccip.Session, Allocator, u64, ?[]const u8, ?*ccip.SignatureCache, ?ccip.Signer, ?ccip.SignerProvider, Cancel) anyerror!ccip.Step,
};

pub const Owner = struct {
    allocator: Allocator,
    entries: []Entry,
    max_bytes: usize,
    allow_caching: bool,
    cache_ttl_ms: u64,
    active_ttl_ms: u64,
    shared_budget: ?*byte_budget.Budget,
    used_bytes: usize = 0,
    sequence: u64 = 0,
    mutex: std.Thread.Mutex = .{},
    fixture_step: if (builtin.is_test) ?StepFixture else void = if (builtin.is_test) null else {},

    pub fn init(allocator: Allocator, options: Options) !Owner {
        if (options.max_sessions == 0 or options.max_sessions > 4096 or options.max_bytes == 0 or options.active_ttl_ms == 0) return error.InvalidCcipSessionLimit;
        const entries = try allocator.alloc(Entry, options.max_sessions);
        @memset(entries, .{});
        return .{ .allocator = allocator, .entries = entries, .max_bytes = options.max_bytes, .allow_caching = options.allow_caching, .cache_ttl_ms = options.cache_ttl_ms, .active_ttl_ms = options.active_ttl_ms, .shared_budget = options.shared_budget };
    }

    /// All handler callers must be joined before deinit.
    pub fn deinit(self: *Owner) void {
        self.mutex.lock();
        for (self.entries) |*entry| {
            std.debug.assert(!entry.borrowed);
            self.clearLocked(entry);
        }
        self.mutex.unlock();
        self.allocator.free(self.entries);
        self.* = undefined;
    }

    pub fn bind(self: *Owner, context: Context) !*Binding {
        var owned = context;
        if (owned.client == null and owned.native_lookup == null) return error.InvalidCcipLookupSource;
        if ((owned.signer != null or owned.signer_provider != null) and owned.signature_cache == null) return error.SignatureCacheRequired;
        if (owned.signer) |signer| {
            if (owned.signature_cache == null) return error.SignatureCacheRequired;
            owned.signer = try signer.retain();
        }
        errdefer if (owned.signer) |signer| signer.release();
        const bound = try context.allocator.create(Binding);
        bound.* = .{ .owner = self, .context = owned };
        return bound;
    }

    pub fn stats(self: *Owner) Stats {
        self.mutex.lock();
        defer self.mutex.unlock();
        var result: Stats = .{ .sessions = 0, .borrowed = 0, .bytes = self.used_bytes };
        for (self.entries) |entry| {
            if (entry.session != null or entry.metadata != null) result.sessions += 1;
            if (entry.borrowed) result.borrowed += 1;
        }
        return result;
    }

    pub fn pendingDelayFor(self: *Owner, context_hash: Hash, ism: Address, message: protocol.Message, now_ms: u64) ?u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const key: Key = .{ .context_hash = context_hash, .ism = ism, .message_id = message.id() };
        const entry = self.findLocked(key) orelse return null;
        if (entry.metadata != null) return null;
        if (entry.borrowed) return 1000;
        if (entry.session == null) return null;
        if (now_ms >= entry.attempt_expires_at_ms) return null;
        return entry.session.?.attempt.ready_at_ms -| now_ms;
    }

    pub fn pendingDelayForMessage(self: *Owner, context_hash: Hash, message: protocol.Message, now_ms: u64) ?u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const message_id = message.id();
        var result: ?u64 = null;
        for (self.entries) |entry| {
            if (!std.mem.eql(u8, &entry.key.context_hash, &context_hash) or !std.mem.eql(u8, &entry.key.message_id, &message_id) or entry.metadata != null) continue;
            if (now_ms >= entry.attempt_expires_at_ms) continue;
            const delay = if (entry.borrowed) @as(u64, 1000) else if (entry.session) |session| session.attempt.ready_at_ms -| now_ms else continue;
            if (result == null or delay < result.?) result = delay;
        }
        return result;
    }

    pub fn installFixtureStep(self: *Owner, fixture: StepFixture) void {
        if (comptime !builtin.is_test) @compileError("CCIP step fixtures are test-only");
        self.fixture_step = fixture;
    }

    fn sessionCost(session: ccip.Session) usize {
        return session.lookup.encoded.len + session.lookup.urls.len * @sizeOf([]const u8);
    }

    fn asyncRequestCost(request: curl.Request) !usize {
        var cost = try std.math.add(usize, @sizeOf(http_runtime.Handle), request.url.len);
        cost = try std.math.add(usize, cost, (request.body orelse "").len);
        cost = try std.math.add(usize, cost, try std.math.mul(usize, request.headers.len, @sizeOf(curl.Header)));
        for (request.headers) |header| cost = try std.math.add(usize, cost, try std.math.add(usize, header.name.len, header.value.len));
        return cost;
    }

    fn clearAsyncLocked(self: *Owner, entry: *Entry) void {
        const handle = entry.async_handle orelse return;
        if (entry.runtime) |runtime| runtime.cancel(handle);
        if (comptime builtin.is_test) if (entry.async_fixture) |fixture| fixture.cancel_fn(fixture.context);
        self.used_bytes -= entry.async_cost;
        if (self.shared_budget) |budget| budget.release(entry.async_cost);
        entry.async_handle = null;
        entry.async_cost = 0;
    }

    fn clearLocked(self: *Owner, entry: *Entry) void {
        self.clearAsyncLocked(entry);
        if (entry.session) |*session| {
            const cost = sessionCost(session.*);
            self.used_bytes -= cost;
            if (self.shared_budget) |budget| budget.release(cost);
            session.deinit();
        }
        if (entry.metadata) |metadata| {
            self.used_bytes -= metadata.len;
            if (self.shared_budget) |budget| budget.release(metadata.len);
            self.allocator.free(metadata);
        }
        entry.* = .{};
    }

    fn evictLocked(self: *Owner, except: ?*Entry) bool {
        var candidate: ?*Entry = null;
        for (self.entries) |*entry| {
            if (entry.borrowed or entry == except or (entry.session == null and entry.metadata == null)) continue;
            if (candidate == null or entry.touched < candidate.?.touched) candidate = entry;
        }
        const entry = candidate orelse return false;
        self.clearLocked(entry);
        return true;
    }

    fn makeRoomLocked(self: *Owner, entry: *Entry, additional: usize) bool {
        while (additional > self.max_bytes -| self.used_bytes) {
            if (!self.evictLocked(entry)) return false;
        }
        return true;
    }

    fn chargeLocked(self: *Owner, entry: *Entry, additional: usize) !void {
        if (!self.makeRoomLocked(entry, additional)) return error.CcipSessionMemoryLimit;
        if (self.shared_budget) |budget| try budget.reserve(additional);
    }

    fn chargeMemoLocked(self: *Owner, additional: usize) !void {
        while (additional > self.max_bytes -| self.used_bytes) {
            if (!self.evictLocked(null)) return error.CcipSessionMemoryLimit;
        }
        if (self.shared_budget) |budget| try budget.reserve(additional);
    }

    fn releaseShared(self: *Owner, bytes: usize) void {
        if (self.shared_budget) |budget| budget.release(bytes);
    }

    fn findLocked(self: *Owner, key: Key) ?*Entry {
        for (self.entries) |*entry| {
            if ((entry.borrowed or entry.session != null or entry.metadata != null) and std.meta.eql(entry.key, key)) return entry;
        }
        return null;
    }

    fn reserveLocked(self: *Owner, key: Key, now_ms: u64) !*Entry {
        var candidate: ?*Entry = null;
        for (self.entries) |*entry| {
            if (entry.borrowed) continue;
            if (entry.session == null and entry.metadata == null) {
                candidate = entry;
                break;
            }
            if (candidate == null or entry.touched < candidate.?.touched) candidate = entry;
        }
        const entry = candidate orelse return error.CcipSessionCapacity;
        self.clearLocked(entry);
        self.sequence +|= 1;
        entry.* = .{ .owner = self, .key = key, .borrowed = true, .touched = self.sequence, .expires_at_ms = if (self.allow_caching) now_ms +| self.cache_ttl_ms else now_ms, .attempt_expires_at_ms = now_ms +| self.active_ttl_ms };
        return entry;
    }

    fn touchLocked(self: *Owner, entry: *Entry) void {
        self.sequence +|= 1;
        entry.touched = self.sequence;
    }

    fn asyncHasActive(context: *anyopaque) bool {
        const entry: *Entry = @ptrCast(@alignCast(context));
        return entry.async_handle != null;
    }

    fn asyncSubmit(context: *anyopaque, request: curl.Request) !void {
        const entry: *Entry = @ptrCast(@alignCast(context));
        const self = entry.owner.?;
        const cost = try asyncRequestCost(request);
        self.mutex.lock();
        self.chargeLocked(entry, cost) catch |err| {
            self.mutex.unlock();
            return err;
        };
        if (entry.runtime) |runtime| {
            entry.async_handle = runtime.submit(request, null) catch |err| {
                self.releaseShared(cost);
                self.mutex.unlock();
                return err;
            };
        } else if (comptime builtin.is_test) {
            const fixture = entry.async_fixture.?;
            fixture.submit_fn(fixture.context, request) catch |err| {
                self.releaseShared(cost);
                self.mutex.unlock();
                return err;
            };
            self.sequence +|= 1;
            entry.async_handle = .{ .id = self.sequence };
        }
        entry.async_cost = cost;
        self.used_bytes += cost;
        self.mutex.unlock();
    }

    fn finishAsyncLocked(self: *Owner, entry: *Entry) void {
        self.used_bytes -= entry.async_cost;
        self.releaseShared(entry.async_cost);
        entry.async_handle = null;
        entry.async_cost = 0;
    }

    fn asyncPoll(context: *anyopaque) !?curl.Response {
        const entry: *Entry = @ptrCast(@alignCast(context));
        const self = entry.owner.?;
        const result = if (entry.runtime) |runtime|
            runtime.poll(entry.async_handle.?)
        else if (comptime builtin.is_test)
            entry.async_fixture.?.poll_fn(entry.async_fixture.?.context)
        else
            unreachable;
        if (result) |maybe_response| {
            if (maybe_response == null) return null;
            self.mutex.lock();
            self.finishAsyncLocked(entry);
            self.mutex.unlock();
            return maybe_response;
        } else |err| {
            if (err == error.PendingReadIo) return err;
            self.mutex.lock();
            self.finishAsyncLocked(entry);
            self.mutex.unlock();
            return err;
        }
    }

    fn asyncCancel(context: *anyopaque) void {
        const entry: *Entry = @ptrCast(@alignCast(context));
        const self = entry.owner.?;
        self.mutex.lock();
        self.clearAsyncLocked(entry);
        self.mutex.unlock();
    }

    fn asyncTransport(entry: *Entry) ccip.AsyncTransport {
        return .{ .context = entry, .has_active_fn = asyncHasActive, .submit_fn = asyncSubmit, .poll_fn = asyncPoll, .cancel_fn = asyncCancel };
    }

    fn step(self: *Owner, entry: *Entry, bound: *Binding, origin_tx_hash: ?[]const u8) !ccip.Step {
        entry.runtime = bound.context.runtime;
        if (comptime builtin.is_test) {
            entry.async_fixture = bound.context.async_fixture;
            if (entry.runtime != null or entry.async_fixture != null) return entry.session.?.stepAsyncLazy(self.allocator, asyncTransport(entry), bound.context.now_ms, origin_tx_hash, bound.context.signature_cache, bound.context.signer, bound.context.signer_provider, bound.context.cancel);
            if (self.fixture_step) |fixture| return fixture.step_fn(fixture.context, &entry.session.?, self.allocator, bound.context.now_ms, origin_tx_hash, bound.context.signature_cache, bound.context.signer, bound.context.signer_provider, bound.context.cancel);
        } else if (entry.runtime != null) return entry.session.?.stepAsyncLazy(self.allocator, asyncTransport(entry), bound.context.now_ms, origin_tx_hash, bound.context.signature_cache, bound.context.signer, bound.context.signer_provider, bound.context.cancel);
        return entry.session.?.stepLazy(self.allocator, bound.context.native, bound.context.now_ms, origin_tx_hash, bound.context.signature_cache, bound.context.signer, bound.context.signer_provider, bound.context.cancel);
    }

    fn fetch(self: *Owner, bound: *Binding, ism: Address, message: protocol.Message) ![]u8 {
        bound.retry_at_ms = null;
        const key: Key = .{ .context_hash = bound.context.context_hash, .ism = ism, .message_id = message.id() };

        self.mutex.lock();
        if (bound.context.cancel) |cancel| if (cancel.load(.acquire)) {
            if (self.findLocked(key)) |entry| if (!entry.borrowed) self.clearAsyncLocked(entry);
            self.mutex.unlock();
            return error.RequestCancelled;
        };
        if (bound.memo) |memo| if (std.meta.eql(memo.key, key)) {
            const result = bound.context.allocator.dupe(u8, memo.bytes) catch |err| {
                self.mutex.unlock();
                return err;
            };
            self.mutex.unlock();
            return result;
        };
        if (self.findLocked(key)) |entry| {
            if (entry.metadata) |metadata| {
                if (self.allow_caching and bound.context.now_ms < entry.expires_at_ms) {
                    const result = bound.context.allocator.dupe(u8, metadata) catch |err| {
                        self.mutex.unlock();
                        return err;
                    };
                    self.touchLocked(entry);
                    self.mutex.unlock();
                    return result;
                }
            } else if (bound.context.now_ms < entry.attempt_expires_at_ms) {
                if (entry.borrowed) {
                    const retry_at = bound.context.now_ms +| 1000;
                    self.mutex.unlock();
                    bound.retry_at_ms = retry_at;
                    return error.CcipReadPending;
                }
                entry.borrowed = true;
                self.touchLocked(entry);
                self.mutex.unlock();
                return self.advance(bound, entry, message);
            }
            if (entry.borrowed) {
                const retry_at = bound.context.now_ms +| 1000;
                self.mutex.unlock();
                bound.retry_at_ms = retry_at;
                return error.CcipReadPending;
            }
            self.clearLocked(entry);
        }
        const entry = self.reserveLocked(key, bound.context.now_ms) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.mutex.unlock();

        var keep_entry = false;
        defer if (!keep_entry) {
            self.mutex.lock();
            self.clearLocked(entry);
            self.mutex.unlock();
        };
        var lookup = if (bound.context.native_lookup) |lookup_source|
            try lookup_source.lookup_fn(lookup_source.context, self.allocator, ism, message, bound.context.block_number, bound.context.cancel)
        else lookup: {
            var empty_origin: evm_source.LocalOrigin = .{ .allocator = self.allocator, .leaves = &.{}, .stores = &.{} };
            var source: evm_source.Source(evm_source.LocalOrigin) = .{
                .allocator = self.allocator,
                .client = bound.context.client.?,
                .block_number = bound.context.block_number,
                .origin = &empty_origin,
                .cancel = bound.context.cancel,
            };
            break :lookup try source.offchainLookup(ism, message);
        };
        var session = ccip.Session.init(lookup, ism, message.id()) catch |err| {
            lookup.deinit();
            return err;
        };
        var session_live = true;
        errdefer if (session_live) session.deinit();
        if (bound.context.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;

        self.mutex.lock();
        self.chargeLocked(entry, sessionCost(session)) catch |err| {
            self.mutex.unlock();
            return err;
        };
        self.used_bytes += sessionCost(session);
        entry.session = session;
        entry.expires_at_ms = if (self.allow_caching) bound.context.now_ms +| self.cache_ttl_ms else bound.context.now_ms;
        entry.attempt_expires_at_ms = bound.context.now_ms +| self.active_ttl_ms;
        session_live = false;
        keep_entry = true;
        self.mutex.unlock();
        return self.advance(bound, entry, message);
    }

    fn release(self: *Owner, entry: *Entry) void {
        self.mutex.lock();
        entry.borrowed = false;
        self.touchLocked(entry);
        self.mutex.unlock();
    }

    fn advance(self: *Owner, bound: *Binding, entry: *Entry, message: protocol.Message) ![]u8 {
        var keep_entry = true;
        defer if (!keep_entry) {
            self.mutex.lock();
            self.clearLocked(entry);
            self.mutex.unlock();
        };
        const transaction = bound.context.origin_store.dispatchedTransactionOrNull(message.id()) catch |err| {
            self.release(entry);
            return err;
        };
        const origin_tx_hash = if (transaction) |hash| evm.codecs.hexAlloc(self.allocator, &hash) catch |err| {
            self.release(entry);
            return err;
        } else null;
        defer if (origin_tx_hash) |hash| self.allocator.free(hash);
        const outcome = self.step(entry, bound, origin_tx_hash) catch |err| {
            self.release(entry);
            return err;
        };
        if (bound.context.cancel) |cancel| if (cancel.load(.acquire)) {
            switch (outcome) {
                .ready => |metadata| {
                    self.allocator.free(metadata);
                    keep_entry = false;
                },
                else => {},
            }
            self.release(entry);
            return error.RequestCancelled;
        };

        switch (outcome) {
            .retry_at_ms => |retry_at| {
                self.release(entry);
                bound.retry_at_ms = retry_at;
                return error.CcipReadPending;
            },
            .exhausted => {
                keep_entry = false;
                return error.CcipReadExhausted;
            },
            .ready => |metadata| {
                self.mutex.lock();
                const cache_cost = if (self.allow_caching) metadata.len else 0;
                if (cache_cost > 0) self.chargeLocked(entry, cache_cost) catch |err| {
                    self.mutex.unlock();
                    self.allocator.free(metadata);
                    keep_entry = false;
                    return err;
                };
                bound.remember(entry.key, metadata) catch |err| {
                    if (cache_cost > 0) self.releaseShared(cache_cost);
                    entry.borrowed = false;
                    self.mutex.unlock();
                    self.allocator.free(metadata);
                    return err;
                };
                const result = bound.context.allocator.dupe(u8, metadata) catch |err| {
                    if (cache_cost > 0) self.releaseShared(cache_cost);
                    entry.borrowed = false;
                    self.mutex.unlock();
                    self.allocator.free(metadata);
                    return err;
                };
                const session_cost = sessionCost(entry.session.?);
                self.used_bytes -= session_cost;
                self.releaseShared(session_cost);
                entry.session.?.deinit();
                entry.session = null;
                if (self.allow_caching) {
                    entry.metadata = metadata;
                    self.used_bytes += cache_cost;
                } else {
                    self.allocator.free(metadata);
                    keep_entry = false;
                }
                entry.borrowed = false;
                self.touchLocked(entry);
                self.mutex.unlock();
                return result;
            },
        }
    }
};

pub const Binding = struct {
    owner: *Owner,
    context: Context,
    retry_at_ms: ?u64 = null,
    memo: ?Memo = null,

    fn remember(self: *Binding, key: Key, metadata: []const u8) !void {
        if (self.memo) |memo| if (std.meta.eql(memo.key, key)) return;
        const bytes = try self.context.allocator.dupe(u8, metadata);
        errdefer self.context.allocator.free(bytes);
        try self.owner.chargeMemoLocked(bytes.len);
        self.owner.used_bytes += bytes.len;
        if (self.memo) |old| {
            self.owner.used_bytes -= old.bytes.len;
            self.owner.releaseShared(old.bytes.len);
            self.context.allocator.free(old.bytes);
        }
        self.memo = .{ .key = key, .bytes = bytes };
    }

    fn cloneMemo(parent: *Binding, child: *Binding) !void {
        if (parent.memo) |memo| {
            child.owner.mutex.lock();
            const result = child.remember(memo.key, memo.bytes);
            child.owner.mutex.unlock();
            try result;
        }
    }

    pub fn clearMemo(self: *Binding) void {
        const memo = self.memo orelse return;
        self.owner.mutex.lock();
        self.owner.used_bytes -= memo.bytes.len;
        self.owner.releaseShared(memo.bytes.len);
        self.owner.mutex.unlock();
        self.context.allocator.free(memo.bytes);
        self.memo = null;
    }

    pub fn deinit(self: *Binding) void {
        self.clearMemo();
        const allocator = self.context.allocator;
        const signer = self.context.signer;
        self.* = undefined;
        allocator.destroy(self);
        if (signer) |value| value.release();
    }

    pub fn handler(self: *Binding) ccip.Handler {
        return .{ .context = self, .fetch_fn = fetchStatic, .fork_fn = forkStatic, .native_fork_fn = nativeForkStatic, .deinit_fn = deinitStatic };
    }

    pub fn fetch(self: *Binding, ism: Address, message: protocol.Message) ![]u8 {
        return self.owner.fetch(self, ism, message);
    }

    pub fn retryAt(self: *const Binding) ?u64 {
        return self.retry_at_ms;
    }

    fn fetchStatic(context: *anyopaque, ism: Address, message: protocol.Message) ![]u8 {
        const self: *Binding = @ptrCast(@alignCast(context));
        return self.fetch(ism, message);
    }

    fn forkStatic(context: *anyopaque, allocator: Allocator, client: *evm.RpcClient, block_number: u64, cancel: *const std.atomic.Value(bool)) !ccip.Handler {
        const parent: *Binding = @ptrCast(@alignCast(context));
        var child_context = parent.context;
        child_context.allocator = allocator;
        child_context.client = client;
        child_context.native_lookup = null;
        child_context.block_number = block_number;
        child_context.cancel = cancel;
        const child = try parent.owner.bind(child_context);
        errdefer child.deinit();
        try cloneMemo(parent, child);
        return child.handler();
    }

    fn nativeForkStatic(context: *anyopaque, allocator: Allocator, lookup_source: ccip.LookupSource, block_number: u64, cancel: *const std.atomic.Value(bool)) !ccip.Handler {
        const parent: *Binding = @ptrCast(@alignCast(context));
        var child_context = parent.context;
        child_context.allocator = allocator;
        child_context.client = null;
        child_context.native_lookup = lookup_source;
        child_context.block_number = block_number;
        child_context.cancel = cancel;
        const child = try parent.owner.bind(child_context);
        errdefer child.deinit();
        try cloneMemo(parent, child);
        return child.handler();
    }

    fn deinitStatic(context: *anyopaque) void {
        const self: *Binding = @ptrCast(@alignCast(context));
        self.deinit();
    }
};
