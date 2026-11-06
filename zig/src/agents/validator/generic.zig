//! Native non-EVM validator. Network reads run in one retained worker; checkpoint
//! slots fan out through curl_multi, never one blocking worker per endpoint.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const objects = @import("../../storage/objects.zig");
const rocks = @import("../../db/rocks.zig");
const native = @import("../store.zig");
const resources = @import("../chain_source.zig");
const indexing = @import("../indexing/source.zig");
const source = @import("../scraper/source.zig");
const service = @import("../validator.zig");
const driver = @import("driver.zig");
const reader = @import("chain_checkpoint.zig");
const votes = @import("chain_votes.zig");
const frontier_audit = @import("frontier_audit.zig");
const endpoint = @import("../../net/endpoint.zig");
const stream_binding = @import("stream.zig");
const A = std.mem.Allocator;
const Core = indexing.Core(native.Store);
const index_source = @import("index_source.zig");
const tick_clock = @import("tick_clock.zig");
const cursor_initialization = @import("cursor_init.zig");
const Critical = @import("../../ops/critical_metrics.zig");
const IndexMetrics = @import("../../ops/indexing_metrics.zig");
pub const Announcer = struct {
    context: *anyopaque,
    /// The concrete destination owner persists the native announcement intent
    /// and signed transaction before broadcast. Repeated digests are idempotent.
    submit: *const fn (*anyopaque, objects.SignedAnnouncement) anyerror!void,
};
pub const Runtime = struct {
    critical: ?*Critical.Tracker = null,
    stream_wake: ?*std.atomic.Value(bool) = null,
    websocket_ca_info: ?[]const u8 = null,
    halt_signal: ?*std.atomic.Value(bool) = null,
    readiness: ?*@import("readiness.zig").State = null,
    clients: resources.Options,
    signer: service.Signer,
    signer_address: [20]u8,
    publisher: service.Publisher,
    storage_location: []const u8,
    announcer: ?Announcer = null,
    cancel: ?*const std.atomic.Value(bool) = null,
};
pub const Tick = struct { next_delay_ms: ?u64 = null, announcement_pending: bool = false, indexed_range: bool = false, audit_pending: bool = false, progress: ?driver.Progress = null };
const Audit = struct {
    proof: frontier_audit.Proof,
    next: u32,
    tip: u32,
    pending: ?source.Batch = null,
    position: usize = 0,
    fn deinit(self: *Audit) void {
        if (self.pending) |*batch| batch.deinit();
        self.proof.deinit();
    }
};
pub const Role = struct {
    allocator: A,
    settings: *const settings.Settings,
    chain: *const settings.Chain,
    runtime: Runtime,
    environment: *const std.process.EnvMap,
    index_preferred: usize = 0,
    audit_required: bool = false,
    state: service.Service,
    stream: ?*stream_binding.Bridge = null,
    stream_cadence: @import("stream_cadence.zig").Cadence = .{},
    store: native.Store,
    slots: []votes.Slot,
    identities: [][]u8,
    index_resources: *resources.Resources,
    core: ?Core = null,
    index_fallback: index_source.Fallback = undefined,
    index_due_ms: ?u64 = null,
    cycle_clock: tick_clock.Clock = .{},
    cursor_initialization: cursor_initialization.State = .{},
    stream_initialization: cursor_initialization.State = .{},
    index_metrics: ?IndexMetrics.Adapter = null,
    consensus: bool,
    round: ?[]votes.Result = null,
    primary: ?usize = null,
    fallback_initialized: bool = false,
    fallback_preferred: usize = 0,
    signed_announcement: ?objects.SignedAnnouncement = null,
    announcement_ready: bool = false,
    next_announcement_ms: u64 = 0,
    audit: ?Audit = null,
    /// Only allocates clients/local DB state; all remote checks happen in tick.
    pub fn open(a: A, s: *const settings.Settings, env: *const std.process.EnvMap, database: *rocks.Database, runtime: Runtime) !*Role {
        if (s.role != .validator) return error.ExpectedValidatorSettings;
        const config = s.role.validator;
        const chain = s.chainByName(config.origin_chain) orelse return error.UnknownOriginChain;
        if (chain.protocol == .ethereum) return error.UseConcreteEvmValidator;
        if (config.lightweight and config.websocket_url == null) return error.LightweightRequiresWebsocket;
        for (config.rpcs) |rpc| if (rpc.public and !config.allow_public_rpcs) return error.PublicRpcRequiresOptIn;
        var slots: std.array_list.Managed(votes.Slot) = .init(a);
        defer slots.deinit();
        var identities: std.array_list.Managed([]u8) = .init(a);
        defer identities.deinit();
        errdefer {
            for (slots.items) |slot| slot.resources.deinit();
            for (identities.items) |identity| a.free(identity);
        }
        const consensus = config.checkpoint_consensus != null;
        // Match the actual state-read authority used by Rust, not an unrelated
        // event RPC sharing a gRPC/solidity endpoint with every alleged voter.
        const urls = switch (chain.protocol) {
            .cosmos, .cosmosnative => chain.grpc_urls,
            .tron => chain.connection.tron.wallet_solidity_urls,
            else => chain.rpc_urls,
        };
        for (urls) |url| try addSlot(a, chain, env, runtime.clients, consensus, url, &slots, &identities);
        if (slots.items.len == 0 or slots.items.len > 256) return error.InvalidVotePool;
        const index_resources = try openIndexer(a, chain, env, runtime.clients, 0);
        errdefer index_resources.deinit();
        const state = try service.Service.open(a, database, .{ .domain_name = chain.name, .domain = chain.domain, .hook = chain.contracts.merkle_tree_hook, .signer_address = runtime.signer_address, .readiness = runtime.readiness, .halt_signal = runtime.halt_signal, .endpoint_count = if (consensus) slots.items.len else 1, .consensus = if (config.checkpoint_consensus) |c| switch (c) {
            .majority => .majority,
            .quorum => .quorum,
        } else null, .reorg_period = period(chain.reorg) });
        const self = try a.create(Role);
        errdefer a.destroy(self);
        const owned_slots = try slots.toOwnedSlice();
        errdefer {
            for (owned_slots) |slot| slot.resources.deinit();
            a.free(owned_slots);
        }
        self.* = .{ .allocator = a, .settings = s, .chain = chain, .runtime = runtime, .environment = env, .state = state, .store = native.Store.init(a, database, chain.name), .slots = owned_slots, .identities = try identities.toOwnedSlice(), .index_resources = index_resources, .consensus = consensus };
        if (runtime.clients.metrics) |registry| self.index_metrics = .{ .registry = registry, .chain = chain.name };
        const index_urls = runtime.clients.rpc_urls orelse chain.rpc_urls;
        self.index_fallback = .{ .context = self, .current_fn = currentIndexSource, .advance_fn = advanceIndexReader, .bind_fn = bindIndexSource, .endpoint_count = index_urls.len, .native_timeouts = true };
        return self;
    }
    fn currentIndexSource(context: *anyopaque) !source.Source {
        const self = cast(context);
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        return self.index_resources.source();
    }
    fn bindIndexSource(context: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        cast(context).index_resources.setCancellation(cancel);
    }
    fn advanceIndexReader(context: *anyopaque) !void {
        const self = cast(context);
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const urls = self.runtime.clients.rpc_urls orelse self.chain.rpc_urls;
        const next = (self.index_preferred + 1) % urls.len;
        const replacement = try openIndexer(self.allocator, self.chain, self.environment, self.runtime.clients, next);
        replacement.setCancellation(self.runtime.cancel);
        // Source callbacks borrow the stable Role wrapper, so changing this
        // event client never destroys Core's cursor or failed-range union.
        self.index_resources.deinit();
        self.index_resources = replacement;
        self.index_preferred = next;
    }
    fn addSlot(a: A, chain: *const settings.Chain, env: *const std.process.EnvMap, options: resources.Options, consensus: bool, url: []const u8, slots: *std.array_list.Managed(votes.Slot), identities: *std.array_list.Managed([]u8)) !void {
        const identity = try endpoint.canonicalIdentity(a, url);
        errdefer a.free(identity);
        for (identities.items) |previous| if (std.mem.eql(u8, previous, identity)) {
            a.free(identity);
            return;
        };
        var copy = options;
        copy.indexer_tip_cache = false;
        copy.direct_native_transport = true;
        copy.rpc_role = if (consensus) .quorum else .primary;
        copy.operation = .validator_checkpoint;
        const one = [_][]const u8{url};
        switch (chain.protocol) {
            .cosmos, .cosmosnative => copy.grpc_urls = &one,
            .tron => copy.wallet_solidity_urls = &one,
            else => copy.rpc_urls = &one,
        }
        // Resources borrows override lists. Use arena-owned list, then construct
        // against that stable storage; URL bytes themselves belong to Settings.
        const stable = try a.dupe([]const u8, &one);
        defer a.free(stable);
        switch (chain.protocol) {
            .cosmos, .cosmosnative => copy.grpc_urls = stable,
            .tron => copy.wallet_solidity_urls = stable,
            else => copy.rpc_urls = stable,
        }
        const client = try resources.Resources.open(a, chain, env, copy);
        errdefer client.deinit();
        // Resource copies Settings but borrows lists, so retain the singleton in
        // its own arena before releasing our temporary constructor list.
        const retained = try client.arena.allocator().dupe([]const u8, stable);
        switch (chain.protocol) {
            .cosmos, .cosmosnative => {
                client.chain.grpc_urls = retained;
                client.options.grpc_urls = retained;
            },
            .tron => {
                client.chain.connection.tron.wallet_solidity_urls = retained;
                client.options.wallet_solidity_urls = retained;
            },
            else => {
                client.chain.rpc_urls = retained;
                client.options.rpc_urls = retained;
            },
        }
        const slot: votes.Slot = .{ .resources = client, .reader = try reader.Reader.fromResources(client) };
        try identities.append(identity);
        errdefer _ = identities.pop();
        try slots.append(slot);
    }
    fn openIndexer(a: A, chain: *const settings.Chain, env: *const std.process.EnvMap, options: resources.Options, selected: usize) !*resources.Resources {
        const urls = options.rpc_urls orelse chain.rpc_urls;
        if (urls.len == 0) return error.EmptyIndexerEndpoints;
        var copy = options;
        copy.direct_native_transport = true;
        copy.indexer_tip_cache = copy.dynamic_tip_cache != null;
        copy.rpc_role = .primary;
        copy.operation = .contract_sync;
        const one = [_][]const u8{urls[selected % urls.len]};
        copy.rpc_urls = &one;
        const client = try resources.Resources.open(a, chain, env, copy);
        errdefer client.deinit();
        const retained = try client.arena.allocator().dupe([]const u8, &one);
        client.chain.rpc_urls = retained;
        client.options.rpc_urls = retained;
        return client;
    }
    fn rotateIndexer(self: *Role) !void {
        const urls = self.runtime.clients.rpc_urls orelse self.chain.rpc_urls;
        const next = (self.index_preferred + 1) % urls.len;
        const replacement = try openIndexer(self.allocator, self.chain, self.environment, self.runtime.clients, next);
        replacement.setCancellation(self.runtime.cancel);
        if (self.core) |*core| core.deinit();
        self.core = null;
        self.index_resources.deinit();
        self.index_resources = replacement;
        self.index_preferred = next;
    }
    pub fn deinit(self: *Role) void {
        if (self.stream) |stream| stream.deinit();
        self.state.deinit();
        if (self.audit) |*audit| audit.deinit();
        if (self.core) |*core| core.deinit();
        if (self.round) |round| self.allocator.free(round);
        for (self.slots) |slot| slot.resources.deinit();
        for (self.identities) |identity| self.allocator.free(identity);
        self.allocator.free(self.identities);
        self.allocator.free(self.slots);
        self.index_resources.deinit();
        self.allocator.destroy(self);
    }
    pub fn setCancellation(self: *Role, flag: ?*const std.atomic.Value(bool)) void {
        self.runtime.cancel = flag;
        self.index_resources.setCancellation(flag);
        for (self.slots) |slot| slot.resources.setCancellation(flag);
    }
    fn prepare(self: *Role) !*Core {
        if (self.core == null) self.core = .{ .allocator = self.allocator, .source = try self.index_fallback.interface(), .store = &self.store, .options = .{ .source_fetch_backoff = true, .domain = self.chain.domain, .contracts = .{ .mailbox = self.chain.contracts.mailbox, .hook = self.chain.contracts.merkle_tree_hook, .paymaster = self.chain.contracts.interchain_gas_paymaster }, .chunk = @min(65535, self.chain.index.chunk), .lowest = self.chain.index.from, .interval_ms = try std.math.mul(u64, self.chain.index.interval, 1000), .configured_interval_ms = if (self.chain.index.configured_interval) |value| try std.math.mul(u64, value, 1000) else null, .gas_enabled = false, .enabled_streams = .{ false, true, false } } };
        if (self.index_metrics) |*sink| self.core.?.observer = sink.interface();
        return &self.core.?;
    }
    fn required(self: *Role) usize {
        return if (self.state.options.consensus) |c| c.required(self.state.options.endpoint_count) catch unreachable else 1;
    }
    fn cast(context: *anyopaque) *Role {
        return @ptrCast(@alignCast(context));
    }
    fn ready(context: *anyopaque, results: []const votes.Result) bool {
        const self = cast(context);
        if (!self.consensus) {
            for (results) |result| if (result.ready) return true;
            return false;
        }
        var target: ?u32 = null;
        var empty: usize = 0;
        for (results) |result| {
            if (!result.ready) continue;
            const tree = result.value.?.tree;
            if (tree.count == 0) {
                empty += 1;
                continue;
            }
            var same: usize = 0;
            var matching: usize = 0;
            for (results) |other| {
                if (!other.ready) continue;
                const value = other.value.?.tree;
                if (value.count == tree.count and std.mem.eql(u8, &value.root(), &tree.root())) same += 1;
                if (value.count >= tree.count and value.count > 0) {
                    const local = self.state.checkpoint(value.count - 1) catch continue;
                    if (std.mem.eql(u8, &local.root, &value.root())) matching += 1;
                }
            }
            if (same >= self.required() or matching >= self.required()) target = @max(target orelse 0, tree.count);
        }
        if (target == null and empty < self.required()) return false;
        var higher: usize = 0;
        for (results) |result| {
            if (!result.ready) {
                if (result.failure == null) higher += 1;
            } else if (target == null or result.value.?.tree.count > target.?) higher += 1;
        }
        return higher < self.required();
    }
    fn collect(self: *Role) !void {
        defer if (self.runtime.readiness) |status| {
            const healthy = if (self.round) |round| ready(self, round) else false;
            if (healthy) status.ready("merkle_tree_hook.tree") else status.blocked("merkle_tree_hook.tree") catch |err| std.log.warn("validator readiness update failed: {s}", .{@errorName(err)});
        };
        self.state.invalidateAuthorization();
        if (self.round) |round| {
            self.allocator.free(round);
            self.round = null;
        }
        defer for (self.slots) |slot| slot.resources.setCancellation(self.runtime.cancel);
        const config: votes.Config = .{ .library_path = self.runtime.clients.curl_library, .period = self.state.options.reorg_period, .timeout_ms = self.runtime.clients.request_timeout_ms, .cancel = self.runtime.cancel };
        if (self.consensus or !self.fallback_initialized) {
            // Protocol-authenticated readiness may require reading the actual
            // frontier (e.g. SVM's owner/domain-bound mailbox account). Only the
            // first normal round fans out; explicit consensus always does.
            self.round = try votes.collect(self.allocator, self.slots, config, self, ready);
            self.primary = null;
            for (self.round.?, 0..) |result, i| if (result.ready) {
                self.primary = i;
                self.fallback_preferred = i;
                self.fallback_initialized = true;
                break;
            };
        } else {
            const round = try self.allocator.alloc(votes.Result, self.slots.len);
            errdefer self.allocator.free(round);
            @memset(round, .{});
            const start = self.primary orelse self.fallback_preferred;
            self.primary = null;
            for (0..self.slots.len) |offset| {
                const index = (start + offset) % self.slots.len;
                const observed = try votes.collect(self.allocator, self.slots[index .. index + 1], config, self, ready);
                defer self.allocator.free(observed);
                round[index] = observed[0];
                if (observed[0].ready) {
                    self.primary = index;
                    self.fallback_preferred = index;
                    break;
                }
                // Rotate only after an actual failed read under its original
                // deadline; no competing successful data masks that response.
                self.fallback_preferred = (index + 1) % self.slots.len;
            }
            self.round = round;
        }
        if (self.primary == null) return error.NoHealthyValidatorEndpoint;
    }
    fn startup(self: *Role, now_ms: u64) !bool {
        if (self.announcement_ready) return true;
        try self.state.checkBackendGuard(self.runtime.publisher);
        if (self.signed_announcement == null) {
            const value: objects.Announcement = .{ .validator = self.runtime.signer_address, .mailbox_address = self.chain.contracts.mailbox, .mailbox_domain = self.chain.domain, .storage_location = self.runtime.storage_location };
            const signed: objects.SignedAnnouncement = .{ .value = value, .signature = objects.Signature.fromBytes(try self.runtime.signer.digest(value.digest())) };
            if (!std.mem.eql(u8, &try signed.recover(), &self.runtime.signer_address)) return error.WrongSigner;
            const write = self.runtime.publisher.write_announcement orelse return error.MissingAnnouncementPublisher;
            try write(self.runtime.publisher.context, signed);
            self.signed_announcement = signed;
        }
        if (self.settings.role.validator.skip_announce or try self.announced()) {
            self.announcement_ready = true;
            return true;
        }
        if (now_ms >= self.next_announcement_ms) {
            const announcer = self.runtime.announcer orelse return error.MissingAnnouncementTransactionOwner;
            try announcer.submit(announcer.context, self.signed_announcement.?);
            self.next_announcement_ms = now_ms +| 60000;
        }
        return false;
    }
    fn announced(self: *Role) !bool {
        const value = self.slots[self.primary.?].reader;
        const validators = &.{self.runtime.signer_address};
        switch (value) {
            .sealevel => |mailbox| {
                var locations = try @import("../../sealevel/announcement.zig").locations(self.allocator, mailbox.client, self.chain.contracts.validator_announce, validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .cosmos_wasm => |c| {
                var locations = try c.client.wasmLocations(self.chain.contracts.validator_announce, validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .cosmos_native => |c| {
                var locations = try c.client.nativeLocations(c.mailbox, validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .radix => |c| {
                var locations = try c.client.locations(try @import("../../radix/address.zig").node(self.chain.contracts.validator_announce), validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .tron => |c| {
                var locations = try c.announcedLocations(try evmAddress(self.chain.contracts.validator_announce), validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .starknet => |c| {
                var locations = try c.announcedLocations(try @import("../../starknet/contracts.zig").Felt.fromBytes(self.chain.contracts.validator_announce), validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
            .aleo => |configured| {
                var c = configured;
                var locations = try c.locations(validators);
                defer locations.deinit();
                return contains(locations.values[0], self.runtime.storage_location);
            },
        }
    }
    pub fn tick(self: *Role, timestamp: u64, now_ms: u64) !Tick {
        try self.cycle_clock.begin(now_ms);
        defer self.cycle_clock.end();
        self.index_due_ms = null;
        if (self.index_metrics) |*sink| sink.unix_seconds = timestamp;
        var result = try self.tickInner(timestamp, now_ms);
        if (self.index_due_ms) |due| result.next_delay_ms = due -| self.cycle_clock.now(now_ms);
        return result;
    }
    fn tickInner(self: *Role, timestamp: u64, now_ms: u64) !Tick {
        if (self.settings.role.validator.websocket_url != null) return self.tickStream(timestamp, now_ms);
        if (self.state.halted) {
            try self.state.publishReorg(self.runtime.publisher);
            return error.ValidatorHalted;
        }
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        try self.collect();
        if (!try self.startup(now_ms)) return .{ .announcement_pending = true };
        return self.tickRpcAfterStartup(timestamp, now_ms);
    }
    fn tickRpcAfterStartup(self: *Role, timestamp: u64, now_ms: u64) !Tick {
        if (!try self.initializeInsertionCursor(now_ms)) return .{};
        const core = &self.core.?;
        if (self.audit_required and self.audit == null) {
            if (!try self.beginAudit(true)) return .{ .audit_pending = true };
        }
        if (self.audit != null) {
            const completed = self.auditTick(timestamp) catch |err| {
                if (self.state.halted) return err;
                if (err == error.CanonicalAuditAnchorMismatch or err == error.MissingCanonicalAuditInsertion or err == error.IncompleteCanonicalAuditHistory or err == error.OriginIndexingReorg or err == error.OriginLogForkMismatch) {
                    if (self.audit) |*audit| audit.deinit();
                    self.audit = null;
                    try self.rotateIndexer();
                }
                return err;
            };
            return .{ .audit_pending = !completed, .progress = if (completed) .{ .observed = 0, .published = 0, .unavailable_endpoints = 0, .more_observations = true, .recovery_reset = true } else null };
        }
        const indexed = try self.runIndex(core, now_ms);
        self.index_resources.setCancellation(self.runtime.cancel);
        const progress = driver.tick(&self.state, .{ .context = self, .finalized_height = finalized, .insertion = insertion, .checkpoint = checkpoint }, self.runtime.signer, self.runtime.publisher, timestamp, .{ .publications = self.settings.role.validator.max_sign_concurrency }) catch |err| {
            if (self.state.halted) try self.state.publishReorg(self.runtime.publisher) else if (err == error.NonmonotonicHistory or err == error.UnverifiedSuffixChanged) {
                if (try self.beginAudit(true)) return .{ .indexed_range = indexed.ranges > 0, .audit_pending = true };
            }
            return err;
        };
        if (try self.beginAudit(false)) return .{ .indexed_range = indexed.ranges > 0, .audit_pending = true, .progress = progress };
        return .{ .indexed_range = indexed.ranges > 0, .progress = progress, .next_delay_ms = indexed.next_delay_ms };
    }
    fn initializeInsertionCursor(self: *Role, now_ms: u64) !bool {
        if (self.cursor_initialization.initialized) {
            _ = try self.prepare();
            return true;
        }
        if (!try self.cursor_initialization.ready(self.cycle_clock.now(now_ms), self.runtime.critical)) {
            self.index_due_ms = self.cursor_initialization.retry_at_ms;
            return false;
        }
        self.constructInsertionCursor() catch |err| {
            try self.cursor_initialization.failed(err, self.cycle_clock.now(now_ms));
            self.index_due_ms = self.cursor_initialization.retry_at_ms;
            return false;
        };
        self.cursor_initialization.succeeded(self.runtime.critical);
        return true;
    }
    fn constructInsertionCursor(self: *Role) !void {
        const core = try self.prepare();
        core.source.bindCancellation(self.runtime.cancel);
        defer core.source.bindCancellation(null);
        try core.source.beginCycle();
        const tip = try core.source.streamTip(3);
        const count = tip.count orelse return error.MissingOriginSequenceCount;
        const height = std.math.cast(u32, tip.tip) orelse return error.IndexHeightOutOfRange;
        if (count > 0) _ = try self.store.backwardProgress(.insertion, count - 1);
        core.cursors[1] = try @import("../../runtime/sequence_cursor.zig").Cursor.init(self.allocator, count, height, .{ .chunk = core.options.chunk, .lowest = core.options.lowest, .mode = if (core.source.sequence_mode) .sequence else .block, .idle_ms = core.options.interval_ms });
    }
    fn runIndex(self: *Role, core: *Core, now_ms: u64) !indexing.Report {
        const index_started = self.cycle_clock.now(now_ms);
        const previous_retry = core.fetch_retries[1];
        if (core.cursors[1]) |*value| @import("../../runtime/indexing_observer.zig").completed(core.observer, .insertion, value, null, null, index_started);
        const indexed = try core.tick(index_started, self.runtime.cancel);
        const completed_now = self.cycle_clock.now(index_started);
        if (!std.meta.eql(previous_retry, core.fetch_retries[1]) and core.fetch_retries[1].consecutive_failures != 0) {
            // Direct SDK I/O can block within a single tick. Core receives its
            // injected start time; rebase this one handled failure at actual
            // completion without adding a second failure or resetting its union.
            var retry = previous_retry;
            const delay = retry.recordFailure(core.fetch_retries[1].failed_range.?, completed_now);
            core.fetch_retries[1] = retry;
            core.due[1] = completed_now +| @min(delay, 5000);
        }
        self.index_due_ms = core.due[1];
        return indexed;
    }
    fn tickStream(self: *Role, timestamp: u64, now_ms: u64) !Tick {
        if (self.state.halted) {
            if (self.stream) |stream| stream.stop();
            try self.state.publishReorg(self.runtime.publisher);
            return error.ValidatorHalted;
        }
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        var frames: stream_binding.Progress = .{};
        var round_refreshed = false;
        if (self.stream) |stream| frames = try stream.drive(now_ms, self.runtime.cancel);
        if (self.stream_cadence.due(now_ms, if (self.stream) |stream| stream.fallback_active else true, try self.store.insertionByIndex(self.state.nextVerificationIndex()) != null, self.state.tree.count)) {
            var elapsed = try std.time.Timer.start();
            self.collect() catch |err| {
                self.stream_cadence.attemptedAt(now_ms +| elapsed.read() / std.time.ns_per_ms, self.settings.role.validator.interval *| 1000);
                return err;
            };
            self.stream_cadence.attemptedAt(now_ms +| elapsed.read() / std.time.ns_per_ms, self.settings.role.validator.interval *| 1000);
            round_refreshed = true;
        }
        if (!try self.startup(now_ms)) return .{ .announcement_pending = true };
        if (self.stream == null) {
            _ = self.state.bootstrap(self.runtime.publisher) catch |err| blk: {
                if (self.state.halted) return err;
                break :blk false;
            };
            if (!try self.stream_initialization.ready(self.cycle_clock.now(now_ms), self.runtime.critical)) {
                self.index_due_ms = self.stream_initialization.retry_at_ms;
                return .{};
            }
            self.stream = stream_binding.Bridge.open(self.allocator, &self.state, &self.store, .{ .context = self, .count_fn = streamCount, .checkpoint_fn = checkpoint, .height_fn = streamHeight }, .{ .url = self.settings.role.validator.websocket_url.?, .library_path = self.runtime.clients.curl_library, .ca_info = self.runtime.websocket_ca_info, .lightweight = self.settings.role.validator.lightweight, .wake = self.runtime.stream_wake }) catch |err| {
                try self.stream_initialization.failed(err, self.cycle_clock.now(now_ms));
                self.index_due_ms = self.stream_initialization.retry_at_ms;
                return .{};
            };
            self.stream_initialization.succeeded(self.runtime.critical);
        }
        const stream = self.stream.?;
        try stream.probe(now_ms);
        if (!self.settings.role.validator.lightweight and (stream.fallback_active or self.audit_required or self.audit != null)) {
            // The existing RPC path keeps bounded canonical audits/recovery.
            return self.tickRpcAfterStartup(timestamp, now_ms);
        }
        if (!round_refreshed and self.stream_cadence.verified() and try self.store.insertionByIndex(self.state.nextVerificationIndex()) == null and !try self.state.hasPendingPublication()) return .{ .indexed_range = frames.remaining };
        const progress = stream.tickCheckpoints(self.runtime.signer, self.runtime.publisher, timestamp, self.settings.role.validator.max_sign_concurrency) catch |err| {
            if (self.state.halted) try self.state.publishReorg(self.runtime.publisher) else if (!self.settings.role.validator.lightweight and (err == error.NonmonotonicHistory or err == error.UnverifiedSuffixChanged)) {
                try stream.forceFallback();
                if (try self.beginAudit(true)) return .{ .audit_pending = true };
            }
            return err;
        };
        var empty_ready: usize = 0;
        if (self.round) |results| for (results) |result| {
            if (result.ready and result.value.?.tree.count == 0) empty_ready += 1;
        };
        self.stream_cadence.processed(self.state.fresh_verified_through != null, progress.more_observations, self.state.tree.count == 0 and empty_ready >= self.required());
        if (!self.settings.role.validator.lightweight and try self.beginAudit(false)) {
            try stream.forceFallback();
            return .{ .audit_pending = true, .progress = progress };
        }
        return .{ .indexed_range = frames.insertions > 0 or frames.remaining or (progress.more_observations and try self.store.insertionByIndex(self.state.nextVerificationIndex()) != null) or progress.published == self.settings.role.validator.max_sign_concurrency, .progress = progress };
    }
    fn streamProbeReady(_: *anyopaque, results: []const votes.Result) bool {
        return results[0].ready or results[0].failure != null;
    }
    fn streamCount(context: *anyopaque) !u32 {
        const self = cast(context);
        const index = self.primary orelse return error.NoHealthyCheckpointEndpoint;
        const results = try votes.collect(self.allocator, self.slots[index .. index + 1], .{ .library_path = self.runtime.clients.curl_library, .period = self.state.options.reorg_period, .timeout_ms = self.runtime.clients.request_timeout_ms, .cancel = self.runtime.cancel }, self, streamProbeReady);
        defer self.allocator.free(results);
        if (!results[0].ready) return results[0].failure orelse error.NoHealthyCheckpointEndpoint;
        return results[0].value.?.tree.count;
    }
    fn streamHeight(context: *anyopaque, _: objects.ReorgPeriod) !u64 {
        const self = cast(context);
        var maximum: ?u64 = null;
        for (self.round orelse return error.MissingCheckpointRound) |result| if (result.ready) {
            if (result.value.?.height) |height| maximum = @max(maximum orelse 0, height);
        };
        // Latest-only native state readers have no authenticated header height.
        // Only matching endpoint roots authorize any reconstructed stream leaves.
        return maximum orelse std.math.maxInt(u64);
    }
    fn finalized(context: *anyopaque, _: objects.ReorgPeriod) !u64 {
        const self = cast(context);
        var maximum: ?u64 = null;
        for (self.round.?) |result| if (result.ready) {
            if (result.value.?.height) |height| maximum = @max(maximum orelse 0, height);
        };
        return maximum orelse (try (try self.prepare()).source.streamTip(3)).tip;
    }
    fn insertion(context: *anyopaque, index: u32, height: u64) !?service.Observation {
        const self = cast(context);
        const value = try self.store.insertionByIndex(index) orelse return null;
        const block = try self.store.logBlock(.insertion, index) orelse return null;
        if (block > height) return null;
        // Rust validator replays native DB leaves and authenticates their entire
        // frontier against fresh endpoint roots. Never fabricate a header hash:
        // historical PDA mappings may have pruned block provenance.
        return .{ .message_id = value.message_id, .block_height = block, .block_hash = @splat(0) };
    }
    fn checkpoint(context: *anyopaque, slot: usize, _: objects.ReorgPeriod) !?service.Checkpoint {
        const self = cast(context);
        const results = self.round orelse return error.MissingCheckpointRound;
        if (self.consensus) {
            if (slot >= results.len) return error.EndpointPoolChanged;
            return if (results[slot].ready) results[slot].value.?.checkpoint(self.chain.domain, self.chain.contracts.merkle_tree_hook) else null;
        }
        if (slot != 0) return error.EndpointPoolChanged;
        return results[self.primary.?].value.?.checkpoint(self.chain.domain, self.chain.contracts.merkle_tree_hook);
    }
    fn beginAudit(self: *Role, force: bool) !bool {
        // A whole-tree matching quorum cryptographically authenticates every
        // prefix. Growing-fork disagreement cannot authorize a new signature;
        // independently replay to distinguish signed-prefix conflict from an
        // unverified suffix before deciding halt versus reset.
        if (!force and self.state.fresh_verified_through != null) return false;
        const length = self.state.options.endpoint_count;
        const anchors = try self.allocator.alloc(?frontier_audit.Anchor, length);
        defer self.allocator.free(anchors);
        @memset(anchors, null);
        var available: usize = 0;
        var covered: usize = 0;
        var maximum_height: ?u64 = null;
        for (anchors, 0..) |*anchor, slot| {
            const index = if (self.consensus) slot else self.primary.?;
            const result = self.round.?[index];
            if (!result.ready or result.value.?.tree.count == 0) continue;
            const value = result.value.?;
            anchor.* = .{ .count = value.tree.count, .root = value.tree.root() };
            available += 1;
            if (value.tree.count <= self.state.tree.count) covered += 1;
            if (value.height) |height| maximum_height = @max(maximum_height orelse 0, height);
        }
        if (available < self.required() or (!force and covered < self.required())) return false;
        const core = try self.prepare();
        const tip = try core.source.streamTip(3);
        var proof = try frontier_audit.Proof.init(self.allocator, anchors, self.required(), self.state.verified_through orelse self.state.signed_watermark);
        errdefer proof.deinit();
        self.audit = .{ .proof = proof, .next = if (core.source.sequence_mode) 0 else std.math.cast(u32, @max(0, self.chain.index.from)) orelse return error.IndexHeightOutOfRange, .tip = std.math.cast(u32, if (maximum_height) |h| @min(h, tip.tip) else tip.tip) orelse return error.IndexHeightOutOfRange };
        self.state.invalidateAuthorization();
        self.audit_required = true;
        return true;
    }
    fn auditTick(self: *Role, timestamp: u64) !bool {
        const core = try self.prepare();
        const audit = &self.audit.?;
        if (audit.pending == null) {
            try core.source.beginCycle();
            const through = if (core.source.sequence_mode) @min(audit.proof.maximum_count - 1, audit.next +| @min(63, self.chain.index.chunk)) else @min(audit.tip, audit.next +| self.chain.index.chunk);
            audit.pending = try core.fetchInsertionRange(.{ .from = audit.next, .to = through }, audit.tip, self.runtime.cancel);
            audit.position = 0;
            audit.next = through +| 1;
            std.mem.sort(source.Event, audit.pending.?.events, {}, struct {
                fn less(_: void, x: source.Event, y: source.Event) bool {
                    return x.data.insertion.index < y.data.insertion.index;
                }
            }.less);
        }
        var consumed: usize = 0;
        const batch = &audit.pending.?;
        while (audit.position < batch.events.len and consumed < 64 and audit.proof.tree.count < audit.proof.maximum_count) {
            const event = batch.events[audit.position];
            const value = event.data.insertion;
            if (value.index < audit.proof.tree.count) {
                audit.position += 1;
                continue;
            }
            if (value.index != audit.proof.tree.count) return error.MissingCanonicalAuditInsertion;
            if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            _ = try self.store.storeInsertion(.{ .leaf_index = value.index, .message_id = value.message_id }, event.block_number);
            try audit.proof.ingest(value.message_id);
            audit.position += 1;
            consumed += 1;
            if (audit.proof.authenticated()) break;
        }
        if (audit.position == batch.events.len) {
            batch.deinit();
            audit.pending = null;
        }
        if (!audit.proof.authenticated() and audit.proof.tree.count < audit.proof.maximum_count) {
            if (audit.pending == null and !core.source.sequence_mode and audit.next > audit.tip) return error.IncompleteCanonicalAuditHistory;
            return false;
        }
        if (!audit.proof.authenticated()) return error.CanonicalAuditAnchorMismatch;
        if (audit.proof.trusted_index) |index| {
            const root = audit.proof.trusted_root orelse return error.CanonicalAuditBeforeSignedWatermark;
            self.state.verifyCommitted(index, root, timestamp) catch |err| {
                if (self.state.halted) try self.state.publishReorg(self.runtime.publisher);
                return err;
            };
        }
        _ = try self.state.resetUnverifiedSuffix();
        audit.deinit();
        self.audit = null;
        self.audit_required = false;
        // Existing native DB skip markers may point at the discarded suffix;
        // canonical replay has already repaired every covered leaf atomically.
        // Recreate only in-memory cursor state and require a new live vote round.
        core.deinit();
        self.core = null;
        return true;
    }
};
fn contains(values: []const []const u8, expected: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, expected)) return true;
    return false;
}
fn evmAddress(value: [32]u8) ![20]u8 {
    if (!std.mem.allEqual(u8, value[0..12], 0)) return error.InvalidEvmStyleAddress;
    return value[12..].*;
}
fn period(value: @import("../../settings/types.zig").Reorg) objects.ReorgPeriod {
    return switch (value) {
        .blocks => |n| .{ .blocks = n },
        .tag => |tag| .{ .tag = tag },
    };
}

/// Native regression entrypoints stay outside the dependency-light test root.
/// Keeping the calls here grants access to private scheduling methods.
pub const NativeTests = if (@import("builtin").is_test) struct {
    pub fn fetchBackoff() !void {
        try @import("fetch_backoff_test.zig").generic(Role, Role.prepare, Role.runIndex);
    }
    pub fn cursorInitialization() !void {
        try @import("fetch_backoff_test.zig").genericInitialization(Role, Role.initializeInsertionCursor);
    }
} else struct {};
