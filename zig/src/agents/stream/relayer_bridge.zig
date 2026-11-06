//! Operational scraper WS bridge: one transport owner, one controller/DB consumer,
//! and independent retained canonical probe lanes per ready origin.
const std = @import("std");
const origins = @import("../origin_tasks.zig");
const resources = @import("../chain_source.zig");
const relayer = @import("relayer.zig");
const store = @import("relayer_store.zig");
const wire = @import("protocol.zig");
const observer = @import("observer.zig");
const socket_owner = @import("socket_owner.zig");
const supervisor = @import("../../runtime/supervisor.zig");
const lane_owner = @import("../../runtime/lane_owner.zig");
const evm = @import("../../evm/indexer.zig");
const objects = @import("../../storage/objects.zig");
const settings = @import("../../settings/types.zig");
const A = std.mem.Allocator;

pub const Options = struct {
    url: []const u8,
    origins: *origins.Set,
    controller: relayer.Options,
    transport: socket_owner.Config,
    observer: ?observer.Observer = null,
    probe_timeout_ms: u64 = 15000,
    max_events_per_poll: usize = 128,
};

const ProbeJob = struct {
    allocator: A,
    resources: *resources.Resources,
    parent_stop: *const std.atomic.Value(bool),
    owner: lane_owner.Owner,
    plan: ?relayer.ProbePlan = null,
    result: ?relayer.CanonicalCounts = null,
    failed: bool = false,
    runs: std.atomic.Value(usize) = .init(0),

    fn init(allocator: A, parent: *resources.Resources, parent_stop: *const std.atomic.Value(bool), timeout_ms: u64) !*ProbeJob {
        const self = try allocator.create(ProbeJob);
        errdefer allocator.destroy(self);
        const child = try parent.forkRead(allocator);
        errdefer child.deinit();
        self.* = .{
            .allocator = allocator,
            .resources = child,
            .parent_stop = parent_stop,
            .owner = try lane_owner.Owner.init(self, run, .{ .timeout_ms = timeout_ms }),
        };
        return self;
    }

    fn deinit(self: *ProbeJob) void {
        self.owner.deinit();
        self.resources.deinit();
        self.allocator.destroy(self);
    }

    fn stopped(self: *ProbeJob, cancel: *const std.atomic.Value(bool)) bool {
        return self.parent_stop.load(.acquire) or cancel.load(.acquire);
    }

    fn cooperativeWait(self: *ProbeJob, cancel: *const std.atomic.Value(bool)) !void {
        if (self.stopped(cancel)) return error.RequestCancelled;
        std.Thread.sleep(std.time.ns_per_ms);
        if (self.stopped(cancel)) return error.RequestCancelled;
    }

    fn run(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *ProbeJob = @ptrCast(@alignCast(context));
        _ = self.runs.fetchAdd(1, .acq_rel);
        if (self.stopped(cancel) or self.plan == null) return error.RequestCancelled;
        self.failed = false;
        self.result = null;
        while (!self.stopped(cancel)) {
            self.resources.beginReadPass(cancel) catch |err| {
                if (err == error.PendingReadIo) {
                    try self.cooperativeWait(cancel);
                    continue;
                }
                self.failed = true;
                return .{ .work = 1 };
            };
            var failure: ?anyerror = null;
            defer self.resources.endReadPass(failure);
            if (self.stopped(cancel)) {
                failure = error.RequestCancelled;
                return error.RequestCancelled;
            }
            const counts = self.probe() catch |err| {
                failure = err;
                if (err == error.PendingReadIo) {
                    try self.cooperativeWait(cancel);
                    continue;
                }
                self.failed = true;
                return .{ .work = 1 };
            };
            if (self.stopped(cancel)) {
                failure = error.RequestCancelled;
                return error.RequestCancelled;
            }
            self.resources.commitReadSection() catch |err| {
                failure = err;
                if (err == error.PendingReadIo or err == error.PendingReadSection) {
                    try self.cooperativeWait(cancel);
                    continue;
                }
                self.failed = true;
                return .{ .work = 1 };
            };
            if (self.stopped(cancel)) {
                failure = error.RequestCancelled;
                return error.RequestCancelled;
            }
            self.result = counts;
            return .{ .work = 1 };
        }
        return error.RequestCancelled;
    }

    fn probe(self: *ProbeJob) !relayer.CanonicalCounts {
        const chain = &self.resources.chain;
        if (chain.protocol == .ethereum) {
            const client = if (self.resources.rpc_client) |*value| value else return error.MissingEvmSourceClient;
            var indexer = try evm.Indexer.init(self.allocator, client, .{
                .chain_id = try std.fmt.parseInt(u256, chain.chain_id, 0),
                .domain = chain.domain,
                .mailbox = try evmAddress(chain.contracts.mailbox),
                .hook = try evmAddress(chain.contracts.merkle_tree_hook),
                .paymaster = try evmAddress(chain.contracts.interchain_gas_paymaster),
                .reorg_period = reorgPeriod(chain.reorg),
            });
            try indexer.check();
            return .{
                .dispatch = (try indexer.countTip(.dispatch)).count,
                .merkle_tree_insertion = (try indexer.countTip(.insertion)).count,
            };
        }
        const source = try self.resources.source();
        return .{
            .dispatch = (try source.streamTip(0)).count,
            .merkle_tree_insertion = (try source.streamTip(3)).count,
        };
    }
};

fn evmAddress(value: [32]u8) ![20]u8 {
    if (!std.mem.allEqual(u8, value[0..12], 0)) return error.InvalidEvmStyleAddress;
    return value[12..].*;
}

fn reorgPeriod(value: settings.Reorg) objects.ReorgPeriod {
    return switch (value) {
        .blocks => |n| .{ .blocks = n },
        .tag => |tag| .{ .tag = tag },
    };
}

fn sequencedIndex(kind: relayer.EventKind) usize {
    return switch (kind) {
        .dispatch => 0,
        .merkle_tree_insertion => 1,
        .gas_payment => unreachable,
    };
}

const OriginState = struct {
    domain: u32,
    slot: *origins.Slot,
    adapter: store.Adapter,
    controller: relayer.Controller,
    generation: u64,
    probe: ?*ProbeJob,
    degraded: bool = false,
    parity_ready: [2]bool = .{ false, false },
    sequenced_caught_up: bool = false,

    fn init(allocator: A, slot: *origins.Slot, options: Options) !*OriginState {
        const handle = slot.handle() orelse return error.OriginNotReady;
        const self = try allocator.create(OriginState);
        errdefer allocator.destroy(self);
        self.* = .{
            .domain = slot.chain.domain,
            .slot = slot,
            .adapter = store.Adapter.init(handle.store, .{
                .mailbox = slot.chain.contracts.mailbox,
                .interchain_gas_paymaster = slot.chain.contracts.interchain_gas_paymaster,
                .merkle_tree_hook = slot.chain.contracts.merkle_tree_hook,
            }),
            .controller = undefined,
            .generation = 0,
            .probe = null,
        };
        self.controller = try relayer.Controller.init(allocator, &.{.{ .domain = slot.chain.domain, .adapter = &self.adapter }}, options.controller);
        errdefer self.controller.deinit();
        return self;
    }

    fn deinit(self: *OriginState, allocator: A) void {
        if (self.probe) |probe| probe.deinit();
        self.controller.deinit();
        allocator.destroy(self);
    }

    fn controllerGeneration(self: *OriginState) !u64 {
        self.generation = try self.controller.beginConnection(self.domain);
        return self.generation;
    }
};

const SubscriptionPlan = struct {
    domains: []u32,
    expected: []wire.SubscribedStream,
    bytes: []u8,
    fn deinit(self: *SubscriptionPlan, allocator: A) void {
        wire.freeConfirmation(allocator, self.expected);
        allocator.free(self.bytes);
        allocator.free(self.domains);
    }
};

pub fn isUnsupportedGasRowCursorError(message: []const u8) bool {
    return std.mem.indexOf(u8, message, "cursors are only supported for sequenced streams") != null or
        std.mem.indexOf(u8, message, "row ID cursors are not supported") != null;
}

fn observerKind(kind: relayer.EventKind) observer.Kind {
    return switch (kind) {
        .dispatch => .dispatch,
        .gas_payment => .gas_payment,
        .merkle_tree_insertion => .merkle_tree_insertion,
    };
}

fn observerSequencedKind(kind: relayer.EventKind) observer.SequencedKind {
    return switch (kind) {
        .dispatch => .dispatch,
        .merkle_tree_insertion => .merkle_tree_insertion,
        .gas_payment => unreachable,
    };
}

fn sequencedEventError(err: anyerror) observer.EventResult {
    return switch (err) {
        error.StreamGap => .gap,
        error.ParityOverflow, error.ParityUnhealthy => .dropped,
        else => .invalid,
    };
}

pub const Bridge = struct {
    allocator: A,
    options: Options,
    owner: *socket_owner.Owner,
    origins: std.AutoHashMap(u32, *OriginState),
    wake: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
    online: bool = false,
    socket_generation: u64 = 0,
    subscribed: bool = false,
    subscribe_sent: bool = false,
    expected: ?SubscriptionPlan = null,
    planned_domains: []u32 = &.{},
    planned_gas: bool = false,
    gas_row_unsupported: bool = false,
    last_error: ?anyerror = null,
    random: std.Random.DefaultPrng,

    pub fn init(allocator: A, options: Options) !*Bridge {
        if (options.probe_timeout_ms == 0 or options.max_events_per_poll == 0) return error.InvalidBridgeOptions;
        const self = try allocator.create(Bridge);
        errdefer allocator.destroy(self);
        var transport_options = options.transport;
        transport_options.wake = &self.wake;
        const owner = try socket_owner.Owner.init(allocator, options.url, transport_options);
        errdefer owner.deinit();
        self.* = .{
            .allocator = allocator,
            .options = options,
            .owner = owner,
            .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
            .random = std.Random.DefaultPrng.init(0x5c0f3a1),
        };
        return self;
    }

    pub fn start(self: *Bridge) !void {
        try self.owner.start();
    }

    fn stop(context: *anyopaque) void {
        const self: *Bridge = @ptrCast(@alignCast(context));
        self.requestStop();
    }

    pub fn descriptor(self: *Bridge) supervisor.Task {
        return .{ .context = self, .run = poll, .interval_ms = 20, .timeout_ms = self.options.probe_timeout_ms, .wake = &self.wake, .stop_fn = stop };
    }

    pub fn requestStop(self: *Bridge) void {
        if (self.stopping.swap(true, .acq_rel)) return;
        self.owner.requestStop();
    }

    pub fn deinit(self: *Bridge) void {
        self.requestStop();
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |origin| origin.*.deinit(self.allocator);
        self.origins.deinit();
        self.clearExpected();
        if (self.planned_domains.len > 0) self.allocator.free(self.planned_domains);
        self.owner.deinit();
        self.allocator.destroy(self);
    }

    fn clearExpected(self: *Bridge) void {
        if (self.expected) |*plan| plan.deinit(self.allocator);
        self.expected = null;
    }

    fn notify(self: *Bridge, state: *OriginState, change: observer.Change) void {
        if (self.options.observer) |sink| sink.notify(state.slot.chain.name, change);
    }

    fn observeState(self: *Bridge, state: *OriginState) !void {
        const current = try state.controller.authorityObservation(state.domain);
        self.notify(state, .{ .state = .{ .active = self.subscribed, .authority = current.active, .fresh = current.fresh } });
    }

    fn observeStream(self: *Bridge, state: *OriginState, kind: relayer.EventKind) !void {
        const current = try state.controller.streamObservation(state.domain, kind);
        self.notify(state, .{ .stream = .{
            .kind = observerKind(kind),
            .caught_up = if (kind == .gas_payment) current.caught_up else null,
            .degraded = if (kind == .gas_payment) (self.gas_row_unsupported or current.degraded) else null,
            .parity_pending = if (kind == .gas_payment) null else current.parity_pending,
            .parity_ready = if (kind == .gas_payment) null else state.parity_ready[sequencedIndex(kind)],
        } });
    }

    fn observeInitial(self: *Bridge, state: *OriginState) void {
        self.notify(state, .initial);
        self.notify(state, .{ .state = .{ .active = false, .authority = false, .fresh = false } });
        for ([_]relayer.EventKind{ .dispatch, .merkle_tree_insertion, .gas_payment }) |kind| self.notify(state, .{ .stream = .{
            .kind = observerKind(kind),
            .caught_up = false,
            .degraded = if (kind == .gas_payment) self.gas_row_unsupported else null,
            .parity_pending = if (kind == .gas_payment) null else 0,
            .parity_ready = if (kind == .gas_payment) null else false,
        } });
    }

    fn observeReset(self: *Bridge, state: *OriginState) !void {
        state.sequenced_caught_up = false;
        try self.observeState(state);
        for ([_]relayer.EventKind{ .dispatch, .merkle_tree_insertion, .gas_payment }) |kind| self.notify(state, .{ .stream = .{
            .kind = observerKind(kind),
            .caught_up = false,
            .degraded = if (kind == .gas_payment) self.gas_row_unsupported else null,
            .parity_pending = if (kind == .gas_payment) null else 0,
            .parity_ready = if (kind == .gas_payment) null else state.parity_ready[sequencedIndex(kind)],
        } });
    }

    fn observeSequencedReady(self: *Bridge, state: *OriginState) !void {
        if (state.sequenced_caught_up) return;
        const dispatch = try state.controller.streamObservation(state.domain, .dispatch);
        const merkle = try state.controller.streamObservation(state.domain, .merkle_tree_insertion);
        if (!dispatch.caught_up or !merkle.caught_up) return;
        state.sequenced_caught_up = true;
        for ([_]relayer.EventKind{ .dispatch, .merkle_tree_insertion }) |kind| {
            const current = try state.controller.streamObservation(state.domain, kind);
            state.parity_ready[sequencedIndex(kind)] = current.parity_ready;
            self.notify(state, .{ .stream = .{
                .kind = observerKind(kind),
                .caught_up = true,
                .parity_pending = current.parity_pending,
                .parity_ready = state.parity_ready[sequencedIndex(kind)],
            } });
        }
    }

    fn observeCursor(self: *Bridge, state: *OriginState, kind: relayer.EventKind) !void {
        if (kind == .gas_payment) return;
        if (try state.adapter.cursor(kind)) |sequence| self.notify(state, .{ .cursor = .{ .kind = observerSequencedKind(kind), .sequence = sequence } });
    }

    fn observeCanonicalCounts(self: *Bridge, state: *OriginState, counts: relayer.CanonicalCounts) void {
        if (counts.dispatch) |count| if (count > 0) self.notify(state, .{ .cursor = .{ .kind = .dispatch, .sequence = count - 1, .max_only = true } });
        if (counts.merkle_tree_insertion) |count| if (count > 0) self.notify(state, .{ .cursor = .{ .kind = .merkle_tree_insertion, .sequence = count - 1, .max_only = true } });
    }

    fn ensureOrigins(self: *Bridge, configured: *origins.Set) !void {
        for (configured.slots) |*slot| {
            if (self.origins.contains(slot.chain.domain) or slot.handle() == null) continue;
            const state = try OriginState.init(self.allocator, slot, self.options);
            errdefer state.deinit(self.allocator);
            try self.origins.put(slot.chain.domain, state);
            self.observeInitial(state);
        }
    }

    fn domains(self: *Bridge) ![]u32 {
        var list: std.ArrayList(u32) = .empty;
        errdefer list.deinit(self.allocator);
        var iterator = self.origins.keyIterator();
        while (iterator.next()) |domain| try list.append(self.allocator, domain.*);
        std.mem.sort(u32, list.items, {}, std.sort.asc(u32));
        return list.toOwnedSlice(self.allocator);
    }

    fn updatePlan(self: *Bridge) !void {
        const next = try self.domains();
        errdefer self.allocator.free(next);
        const changed = next.len != self.planned_domains.len or !std.mem.eql(u32, next, self.planned_domains);
        if (!changed) {
            self.allocator.free(next);
            return;
        }
        self.clearExpected();
        self.subscribe_sent = false;
        self.subscribed = false;
        if (self.online) {
            var iterator = self.origins.valueIterator();
            while (iterator.next()) |state| {
                const origin = state.*;
                _ = try origin.controllerGeneration();
                _ = origin.slot.authority.request((try origin.controller.command(origin.domain)).generation, .{});
                try self.observeReset(origin);
            }
            self.online = false;
            try self.owner.reconnect(self.socket_generation, 0);
        }
        if (self.planned_domains.len > 0) self.allocator.free(self.planned_domains);
        self.planned_domains = next;
    }

    fn buildPlan(self: *Bridge, gas_version: ?u32) !SubscriptionPlan {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const scratch = arena.allocator();
        const domain_list = try self.domains();
        errdefer self.allocator.free(domain_list);
        var cursors: [3]std.ArrayList(wire.StreamCursor) = .{ .empty, .empty, .empty };
        defer for (&cursors) |*list| list.deinit(self.allocator);
        for (domain_list) |domain| {
            const state = self.origins.get(domain).?;
            for ([_]relayer.EventKind{ .dispatch, .merkle_tree_insertion, .gas_payment }) |kind| {
                if (kind == .gas_payment and gas_version != relayer.GAS_PAYMENT_STREAM_CURSOR_VERSION) continue;
                const cursor = try state.controller.subscription(domain, kind);
                const address = try wire.formatAddress(scratch, cursor.address);
                const index: usize = switch (kind) {
                    .dispatch => 0,
                    .merkle_tree_insertion => 1,
                    .gas_payment => 2,
                };
                if (kind == .gas_payment) {
                    const after = if (cursor.after_stream_cursor) |value| try std.fmt.allocPrint(scratch, "{d}", .{value}) else null;
                    try cursors[index].append(self.allocator, .{ .gas_payment = .{ .address = address, .after_stream_cursor = after, .domain = domain } });
                } else {
                    const after = if (cursor.after_sequence) |value| try std.fmt.allocPrint(scratch, "{d}", .{value}) else null;
                    try cursors[index].append(self.allocator, .{ .sequence = .{ .address = address, .allow_replay = true, .after_sequence = after, .domain = domain } });
                }
            }
        }
        var streams: std.ArrayList(wire.SubscribeStream) = .empty;
        defer streams.deinit(self.allocator);
        for (0..3) |index| {
            if (index == 2 and gas_version != relayer.GAS_PAYMENT_STREAM_CURSOR_VERSION) continue;
            const kind: relayer.EventKind = switch (index) {
                0 => .dispatch,
                1 => .merkle_tree_insertion,
                else => .gas_payment,
            };
            try streams.append(self.allocator, .{
                .cursors = cursors[index].items,
                .domains = domain_list,
                .event_type = kind.label(),
                .stream_cursor_version = if (index == 2) gas_version else null,
            });
        }
        const message: wire.SubscribeMessage = .{ .streams = streams.items };
        const expected = try wire.confirmation(self.allocator, message);
        errdefer wire.freeConfirmation(self.allocator, expected);
        const bytes = try wire.serializeSubscribe(self.allocator, message);
        return .{ .domains = domain_list, .expected = expected, .bytes = bytes };
    }

    fn beginConnection(self: *Bridge, generation: u64) !void {
        self.socket_generation = generation;
        self.online = true;
        self.subscribe_sent = false;
        self.subscribed = false;
        self.planned_gas = false;
        self.clearExpected();
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |state| {
            _ = try state.*.controllerGeneration();
            try self.observeReset(state.*);
        }
    }

    fn handleReady(self: *Bridge, ready: wire.Ready) !void {
        const advertised_gas_version: ?u32 = for (ready.stream_cursor_versions) |capability| {
            if (std.mem.eql(u8, capability.event_type, relayer.EventKind.gas_payment.label())) break capability.version;
        } else null;
        const gas_version = if (self.gas_row_unsupported) null else advertised_gas_version;
        self.planned_gas = gas_version == relayer.GAS_PAYMENT_STREAM_CURSOR_VERSION;
        var plan = try self.buildPlan(gas_version);
        errdefer plan.deinit(self.allocator);
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |state| {
            try state.*.controller.markReady(state.*.domain, state.*.generation, gas_version);
            try self.observeStream(state.*, .gas_payment);
        }
        try self.owner.sendText(self.socket_generation, plan.bytes);
        self.expected = plan;
        self.subscribe_sent = true;
    }

    fn handleSubscribed(self: *Bridge, actual: []wire.SubscribedStream) !void {
        const expected = &(self.expected orelse return error.SubscriptionBeforeRequest);
        try wire.validateSubscription(expected.expected, actual);
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |state| try state.*.controller.markSubscribed(state.*.domain, state.*.generation);
        self.subscribed = true;
        self.clearExpected();
        iterator = self.origins.valueIterator();
        while (iterator.next()) |state| try self.observeState(state.*);
    }

    fn handleCaughtUp(self: *Bridge, marker: wire.CaughtUp) !void {
        const state = self.origins.get(marker.domain) orelse return error.UnknownAuthoritySource;
        var kind: relayer.EventKind = undefined;
        if (std.mem.eql(u8, marker.event_type, relayer.EventKind.dispatch.label())) {
            kind = .dispatch;
        } else if (std.mem.eql(u8, marker.event_type, relayer.EventKind.merkle_tree_insertion.label())) {
            kind = .merkle_tree_insertion;
        } else if (std.mem.eql(u8, marker.event_type, relayer.EventKind.gas_payment.label())) {
            kind = .gas_payment;
        } else {
            return error.UnknownEventType;
        }
        const envelope: relayer.CaughtUpEnvelope = .{
            .address = marker.address,
            .domain = marker.domain,
            .event_type = marker.event_type,
            .legacy_max_stream_cursor = marker.legacy_max_stream_cursor,
            .row_id = marker.row_id,
            .stream_cursor = marker.stream_cursor,
            .sequence = marker.sequence,
        };
        if (kind == .gas_payment) {
            const result = try relayer.acceptGasCaughtUpJson(&state.controller, state.domain, state.generation, envelope);
            self.notify(state, .{ .event = .{ .kind = .gas_payment, .result = switch (result) {
                .accepted => .caught_up,
                .dropped => .dropped,
                else => return error.UnexpectedGasCaughtUpResult,
            } } });
            try self.observeStream(state, kind);
        } else {
            try relayer.acceptCaughtUpJson(&state.controller, state.domain, state.generation, kind, envelope);
            try self.observeCursor(state, kind);
            try self.observeSequencedReady(state);
        }
    }

    fn handleEvent(self: *Bridge, event: wire.EventMessage) !void {
        const state = self.origins.get(event.domain) orelse return error.UnknownAuthoritySource;
        const envelope: relayer.Envelope = .{
            .row_id = event.row_id,
            .stream_cursor = event.stream_cursor,
            .legacy_max_stream_cursor = event.legacy_max_stream_cursor,
            .sequence = event.sequence,
        };
        if (std.mem.eql(u8, event.event_type, relayer.EventKind.dispatch.label())) {
            state.parity_ready[0] = false;
            const result = relayer.acceptDispatchJson(&state.controller, state.domain, state.generation, envelope, event.data) catch |err| {
                self.notify(state, .{ .event = .{ .kind = .dispatch, .result = sequencedEventError(err) } });
                try self.observeStream(state, .dispatch);
                return err;
            };
            self.notify(state, .{ .event = .{ .kind = .dispatch, .result = switch (result) {
                .accepted => .accepted,
                .duplicate => .duplicate,
            } } });
            try self.observeStream(state, .dispatch);
            try self.observeSequencedReady(state);
        } else if (std.mem.eql(u8, event.event_type, relayer.EventKind.merkle_tree_insertion.label())) {
            state.parity_ready[1] = false;
            const result = relayer.acceptMerkleJson(&state.controller, state.domain, state.generation, envelope, event.data) catch |err| {
                self.notify(state, .{ .event = .{ .kind = .merkle_tree_insertion, .result = sequencedEventError(err) } });
                try self.observeStream(state, .merkle_tree_insertion);
                return err;
            };
            self.notify(state, .{ .event = .{ .kind = .merkle_tree_insertion, .result = switch (result) {
                .accepted => .accepted,
                .duplicate => .duplicate,
            } } });
            try self.observeStream(state, .merkle_tree_insertion);
            try self.observeSequencedReady(state);
        } else if (std.mem.eql(u8, event.event_type, relayer.EventKind.gas_payment.label())) {
            const result = relayer.acceptGasPaymentJson(&state.controller, state.domain, state.generation, envelope, event.data) catch |err| {
                self.notify(state, .{ .event = .{ .kind = .gas_payment, .result = switch (err) {
                    error.StreamGap => .gap,
                    error.ConflictingDurableGasCursor => .conflict,
                    else => .invalid,
                } } });
                return err;
            };
            self.notify(state, .{ .event = .{ .kind = .gas_payment, .result = switch (result) {
                .accepted => .accepted,
                .duplicate => .duplicate,
                .shadow => .shadow,
                .dropped => .dropped,
                .conflict => .conflict,
            } } });
            try self.observeStream(state, .gas_payment);
        } else {
            self.notify(state, .{ .event = .{ .kind = .unknown, .result = .invalid } });
            return error.UnknownEventType;
        }
    }

    fn disconnect(self: *Bridge, rejected: bool, reason: anyerror) !void {
        self.last_error = reason;
        self.online = false;
        self.subscribed = false;
        self.subscribe_sent = false;
        self.planned_gas = false;
        self.clearExpected();
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |state| {
            const origin = state.*;
            _ = try origin.controllerGeneration();
            _ = origin.slot.authority.request((try origin.controller.command(origin.domain)).generation, .{});
            try self.observeReset(origin);
        }
        const delay_ms = relayer.reconnectDelayMs(rejected, 5000, self.random.random());
        try self.owner.reconnect(self.socket_generation, delay_ms * std.time.ns_per_ms);
    }

    fn consume(self: *Bridge, event: socket_owner.Event) !void {
        if (event.generation < self.socket_generation) return;
        var document = wire.parse(self.allocator, event.kind.text) catch |err| {
            try self.disconnect(false, err);
            return;
        };
        defer document.deinit();
        switch (document.value) {
            .ready => |ready| self.handleReady(ready) catch |err| try self.disconnect(false, err),
            .subscribed => |streams| self.handleSubscribed(streams) catch |err| try self.disconnect(false, err),
            .caught_up => |marker| self.handleCaughtUp(marker) catch |err| try self.disconnect(false, err),
            .event => |message| self.handleEvent(message) catch |err| try self.disconnect(false, err),
            .rollback => try self.disconnect(false, error.StreamRollback),
            .@"error" => |message| if (self.planned_gas and isUnsupportedGasRowCursorError(message)) {
                self.gas_row_unsupported = true;
                var iterator = self.origins.valueIterator();
                while (iterator.next()) |state| try self.observeStream(state.*, .gas_payment);
                try self.disconnect(false, error.UnsupportedGasRowCursor);
            } else {
                try self.disconnect(true, error.RejectedStream);
            },
            .other => {},
        }
    }

    fn processOrigin(self: *Bridge, state: *OriginState, now_ms: u64) !void {
        // Revoked controller history remains available for diagnostics. It must
        // not authorize another cutover while this socket is disconnected or
        // awaiting the new generation's subscription acknowledgement.
        if (!self.online or !self.subscribed) return;
        for ([_]relayer.EventKind{ .dispatch, .merkle_tree_insertion }) |kind| {
            for (0..16) |_| {
                const result = state.controller.processParityNext(state.domain, kind, state.generation, now_ms) catch |err| {
                    state.degraded = true;
                    state.parity_ready[sequencedIndex(kind)] = false;
                    self.notify(state, .{ .parity = .{ .kind = observerSequencedKind(kind), .result = .@"error" } });
                    try state.controller.revoke(state.domain);
                    _ = state.slot.authority.request((try state.controller.command(state.domain)).generation, .{});
                    try self.observeStream(state, kind);
                    try self.observeState(state);
                    self.last_error = err;
                    break;
                };
                switch (result) {
                    .matched => {
                        state.parity_ready[sequencedIndex(kind)] = (try state.controller.streamObservation(state.domain, kind)).parity_ready;
                        self.notify(state, .{ .parity = .{ .kind = observerSequencedKind(kind), .result = .match } });
                        try self.observeCursor(state, kind);
                        try self.observeStream(state, kind);
                        try self.observeSequencedReady(state);
                        continue;
                    },
                    .conflict, .expired => {
                        state.degraded = true;
                        state.parity_ready[sequencedIndex(kind)] = false;
                        self.notify(state, .{ .parity = .{ .kind = observerSequencedKind(kind), .result = if (result == .conflict) .conflict else .expired } });
                        try state.controller.revoke(state.domain);
                        _ = state.slot.authority.request((try state.controller.command(state.domain)).generation, .{});
                        try self.observeStream(state, kind);
                        try self.observeState(state);
                        break;
                    },
                    .pending => {
                        state.parity_ready[sequencedIndex(kind)] = false;
                        try self.observeStream(state, kind);
                        break;
                    },
                    .idle, .stale_generation => break,
                }
                break;
            }
        }

        if (state.probe) |probe| if (probe.plan != null) {
            var timed_out = false;
            const completed = probe.owner.poll(.{ .unix_ms = now_ms, .monotonic_ms = now_ms }, &self.stopping) catch |err| failed: {
                if (err != error.LaneOwnerDeadline) return err;
                timed_out = true;
                break :failed null;
            };
            if (completed != null or timed_out) {
                const plan = probe.plan.?;
                probe.plan = null;
                if (plan.generation == state.generation) {
                    try state.controller.applyProbe(plan, if (probe.failed or timed_out) null else probe.result, now_ms);
                    try self.observeState(state);
                    try self.observeSequencedReady(state);
                    if (!probe.failed and !timed_out) if (probe.result) |counts| self.observeCanonicalCounts(state, counts);
                }
            }
        };

        const command = try state.controller.command(state.domain);
        if (!command.desired) switch (try state.controller.nextAction(state.domain, now_ms)) {
            .cutover => _ = try state.controller.beginCutover(state.domain, state.generation),
            .probe, .none => {},
        };
        const active = !try state.controller.rpcRequired(state.domain);
        const pending_cutover = (try state.controller.command(state.domain)).desired and !active;
        if (!pending_cutover and (state.probe == null or state.probe.?.plan == null)) {
            if (try state.controller.probePlan(state.domain, now_ms)) |plan| {
                if (state.probe == null) state.probe = try ProbeJob.init(self.allocator, state.slot.network.?, &self.stopping, self.options.probe_timeout_ms);
                state.probe.?.plan = plan;
            }
        }

        const updated = try state.controller.command(state.domain);
        const mask: @import("../../runtime/authority_gate.zig").Mask = .{
            .dispatch = updated.desired,
            .insertion = updated.desired,
            .gas = try state.controller.gasAuthority(state.domain),
        };
        _ = state.slot.authority.request(updated.generation, mask);
        const acknowledged = state.slot.authority.snapshot();
        const rpc_required = try state.controller.rpcRequired(state.domain);
        if (updated.desired and rpc_required) {
            if (acknowledged.paused(updated.generation, mask)) {
                try state.controller.markPaused(state.domain, updated.generation);
                try state.controller.completeCutover(state.domain, state.generation, updated.generation);
                try self.observeState(state);
            }
        }
    }

    pub fn poll(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Bridge = @ptrCast(@alignCast(context));
        self.wake.store(false, .release);
        if (self.stopping.load(.acquire) or cancel.load(.acquire)) return error.RequestCancelled;
        try self.start();
        try self.ensureOrigins(self.options.origins);
        try self.updatePlan();
        for (0..self.options.max_events_per_poll) |_| {
            const event = self.owner.take() orelse break;
            defer self.owner.release(event);
            switch (event.kind) {
                .connected => try self.beginConnection(event.generation),
                .text => try self.consume(event),
                .closed => if (event.generation >= self.socket_generation) {
                    self.socket_generation = event.generation;
                    try self.disconnect(false, error.StreamClosed);
                },
                .failed => |err| if (event.generation >= self.socket_generation) {
                    self.socket_generation = event.generation;
                    try self.disconnect(false, err);
                },
            }
        }
        var iterator = self.origins.valueIterator();
        while (iterator.next()) |state| try self.processOrigin(state.*, times.monotonic_ms);
        return .{ .work = 1, .next_delay_ms = 20 };
    }
};

test "unsupported gas row cursor predicate is exact" {
    try std.testing.expect(isUnsupportedGasRowCursorError("cursors are only supported for sequenced streams"));
    try std.testing.expect(isUnsupportedGasRowCursorError("prefix: row ID cursors are not supported: suffix"));
    try std.testing.expect(!isUnsupportedGasRowCursorError("temporary upstream failure"));
    try std.testing.expect(!isUnsupportedGasRowCursorError("row ID cursor is not supported"));
}

fn subscriptionPlanAllocationExercise(allocator: A, database: *@import("../../db/rocks.zig").Database) !void {
    var bridge: Bridge = .{
        .allocator = allocator,
        .options = undefined,
        .owner = undefined,
        .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
        .random = std.Random.DefaultPrng.init(1),
    };
    defer {
        var iterator = bridge.origins.valueIterator();
        while (iterator.next()) |state| {
            state.*.controller.deinit();
            allocator.destroy(state.*);
        }
        bridge.origins.deinit();
    }
    var native_store = @import("../store.zig").Store.init(allocator, database, "fixture");
    for (0..2) |index| {
        const byte: u8 = @intCast(index + 1);
        const domain: u32 = @intCast(100 + index);
        const state = try allocator.create(OriginState);
        errdefer allocator.destroy(state);
        state.* = .{
            .domain = domain,
            .slot = undefined,
            .adapter = store.Adapter.init(&native_store, .{
                .mailbox = @splat(byte),
                .interchain_gas_paymaster = @splat(byte + 10),
                .merkle_tree_hook = @splat(byte + 20),
            }),
            .controller = undefined,
            .generation = 0,
            .probe = null,
        };
        state.controller = try relayer.Controller.init(allocator, &.{.{ .domain = domain, .adapter = &state.adapter }}, .{ .authority_enabled = true });
        errdefer state.controller.deinit();
        try bridge.origins.put(domain, state);
    }
    var plan = try bridge.buildPlan(relayer.GAS_PAYMENT_STREAM_CURSOR_VERSION);
    defer plan.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 3), plan.expected.len);
    var origins_iterator = bridge.origins.valueIterator();
    while (origins_iterator.next()) |state| {
        const address = try wire.formatAddress(allocator, state.*.adapter.contracts.mailbox);
        defer allocator.free(address);
        try std.testing.expect(std.mem.indexOf(u8, plan.bytes, address) != null);
        var found = false;
        for (plan.expected[0].cursors.?) |cursor| {
            if (std.mem.eql(u8, cursor.address, address)) {
                found = true;
                try std.testing.expect(cursor.after_sequence == null);
            }
        }
        try std.testing.expect(found);
    }
    for (plan.expected[2].cursors.?) |cursor| try std.testing.expect(cursor.after_stream_cursor == null);
    try std.testing.expect(std.mem.indexOf(u8, plan.bytes, "afterSequence") == null);
    try std.testing.expect(std.mem.indexOf(u8, plan.bytes, "afterStreamCursor") == null);
}

pub fn runSubscriptionPlanAllocationSweep(allocator: A) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "subscription-plan" });
    defer allocator.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    try std.testing.checkAllAllocationFailures(allocator, subscriptionPlanAllocationExercise, .{&database});
}

test "subscription plans deep own all cursors across allocation failures" {
    try runSubscriptionPlanAllocationSweep(std.testing.allocator);
}

pub fn runCursorJsonRegression(allocator: A) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "cursor-json" });
    defer allocator.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    var bridge: Bridge = .{
        .allocator = allocator,
        .options = undefined,
        .owner = undefined,
        .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
        .random = std.Random.DefaultPrng.init(1),
    };
    defer {
        var iterator = bridge.origins.valueIterator();
        while (iterator.next()) |state| {
            state.*.controller.deinit();
            allocator.destroy(state.*);
        }
        bridge.origins.deinit();
    }
    var native_store = @import("../store.zig").Store.init(allocator, &database, "fixture");
    for (0..2) |index| {
        const byte: u8 = @intCast(index + 1);
        const domain: u32 = @intCast(100 + index);
        const state = try allocator.create(OriginState);
        errdefer allocator.destroy(state);
        state.* = .{
            .domain = domain,
            .slot = undefined,
            .adapter = store.Adapter.init(&native_store, .{
                .mailbox = @splat(byte),
                .interchain_gas_paymaster = @splat(byte + 10),
                .merkle_tree_hook = @splat(byte + 20),
            }),
            .controller = undefined,
            .generation = 0,
            .probe = null,
        };
        state.controller = try relayer.Controller.init(allocator, &.{.{ .domain = domain, .adapter = &state.adapter }}, .{ .authority_enabled = true });
        errdefer state.controller.deinit();
        try bridge.origins.put(domain, state);
        try state.adapter.storeCursor(.dispatch, if (index == 0) 0 else 3);
        try state.adapter.storeCursor(.merkle_tree_insertion, if (index == 0) 2 else 4);
        try state.adapter.storeGasPaymentCursor(.{ .fingerprint = null, .legacy_max_stream_cursor = 0, .stream_cursor = if (index == 0) 0 else 7 });
        _ = try state.controller.beginConnection(domain);
    }
    var plan = try bridge.buildPlan(relayer.GAS_PAYMENT_STREAM_CURSOR_VERSION);
    defer plan.deinit(allocator);
    for (plan.expected[0].cursors.?) |cursor| try std.testing.expectEqualStrings(if (cursor.domain == 100) "-1" else "2", cursor.after_sequence.?);
    for (plan.expected[1].cursors.?) |cursor| try std.testing.expectEqualStrings(if (cursor.domain == 100) "1" else "3", cursor.after_sequence.?);
    for (plan.expected[2].cursors.?) |cursor| try std.testing.expectEqualStrings(if (cursor.domain == 100) "0" else "7", cursor.after_stream_cursor.?);
    try std.testing.expect(std.mem.indexOf(u8, plan.bytes, "afterSequence") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan.bytes, "afterStreamCursor") != null);
}

test "subscription JSON matches Source fresh floor zero and positive cursors" {
    try runCursorJsonRegression(std.testing.allocator);
}

pub fn runReconnectFailureRegression(allocator: A) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "reconnect-failure" });
    defer allocator.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    var wake: std.atomic.Value(bool) = .init(false);
    const owner = try socket_owner.Owner.init(allocator, "ws://127.0.0.1:1", .{ .transport = .{ .library_path = "unused" }, .retry_delay_ns = 1, .wake = &wake });
    defer owner.deinit();
    var bridge: Bridge = .{
        .allocator = allocator,
        .options = .{ .url = "", .origins = undefined, .controller = undefined, .transport = undefined, .observer = null },
        .owner = owner,
        .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
        .planned_domains = try allocator.dupe(u32, &.{100}),
        .online = true,
        .socket_generation = 1,
        .random = std.Random.DefaultPrng.init(1),
    };
    defer {
        var iterator = bridge.origins.valueIterator();
        while (iterator.next()) |state| {
            state.*.controller.deinit();
            allocator.destroy(state.*);
        }
        bridge.origins.deinit();
        allocator.free(bridge.planned_domains);
    }
    var slots: [2]origins.Slot = undefined;
    var native_store = @import("../store.zig").Store.init(allocator, &database, "fixture");
    for (&slots, 0..) |*slot, index| {
        slot.authority = .{};
        const byte: u8 = @intCast(index + 1);
        const domain: u32 = @intCast(100 + index);
        const state = try allocator.create(OriginState);
        errdefer allocator.destroy(state);
        state.* = .{
            .domain = domain,
            .slot = slot,
            .adapter = store.Adapter.init(&native_store, .{
                .mailbox = @splat(byte),
                .interchain_gas_paymaster = @splat(byte + 10),
                .merkle_tree_hook = @splat(byte + 20),
            }),
            .controller = undefined,
            .generation = 0,
            .probe = null,
        };
        state.controller = try relayer.Controller.init(allocator, &.{.{ .domain = domain, .adapter = &state.adapter }}, .{ .authority_enabled = true });
        errdefer state.controller.deinit();
        try bridge.origins.put(domain, state);
    }
    bridge.requestStop();
    try std.testing.expectError(error.SocketOwnerStopped, bridge.updatePlan());
    try std.testing.expectEqualSlices(u32, &.{100}, bridge.planned_domains);
    try std.testing.expect(!bridge.online);
    try bridge.updatePlan();
    try std.testing.expectEqualSlices(u32, &.{ 100, 101 }, bridge.planned_domains);
}

test "changed domain reconnect failure preserves the owned plan through retry and teardown" {
    try runReconnectFailureRegression(std.testing.allocator);
}

fn dispatchTestEvent(bridge: *Bridge, state: *OriginState, nonce: u32) !void {
    const allocator = bridge.allocator;
    const message: @import("../../protocol/root.zig").Message = .{
        .version = 3,
        .nonce = nonce,
        .origin = state.domain,
        .sender = @splat(4),
        .destination = 9,
        .recipient = @splat(5),
        .body = "hello",
    };
    const id = try relayer.formatAddressAlloc(allocator, message.id());
    defer allocator.free(id);
    const mailbox = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.mailbox);
    defer allocator.free(mailbox);
    const sender = try relayer.formatAddressAlloc(allocator, message.sender);
    defer allocator.free(sender);
    const recipient = try relayer.formatAddressAlloc(allocator, message.recipient);
    defer allocator.free(recipient);
    const hash = try relayer.formatAddressAlloc(allocator, @splat(9));
    defer allocator.free(hash);
    const tx = try relayer.formatAddressAlloc(allocator, @splat(8));
    defer allocator.free(tx);
    const sequence = try std.fmt.allocPrint(allocator, "{d}", .{nonce});
    defer allocator.free(sequence);
    const text = try std.fmt.allocPrint(allocator, "{{\"destination_domain\":9,\"id\":\"7\",\"msg_body\":\"0x68656c6c6f\",\"msg_id\":\"{s}\",\"nonce\":\"{d}\",\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"100\",\"origin_domain\":{d},\"origin_mailbox\":\"{s}\",\"origin_tx_hash\":\"{s}\",\"recipient\":\"{s}\",\"sender\":\"{s}\",\"time_created\":\"now\"}}", .{ id, nonce, hash, state.domain, mailbox, tx, recipient, sender });
    defer allocator.free(text);
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, text, .{});
    defer parsed.deinit();
    try bridge.handleEvent(.{ .data = parsed.value, .domain = state.domain, .event_type = "dispatch", .sequence = sequence });
}

fn merkleTestEvent(bridge: *Bridge, state: *OriginState, leaf_index: u32) !void {
    const allocator = bridge.allocator;
    const message: @import("../../protocol/root.zig").Message = .{
        .version = 3,
        .nonce = leaf_index,
        .origin = state.domain,
        .sender = @splat(4),
        .destination = 9,
        .recipient = @splat(5),
        .body = "hello",
    };
    const id = try relayer.formatAddressAlloc(allocator, message.id());
    defer allocator.free(id);
    const hook = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.merkle_tree_hook);
    defer allocator.free(hook);
    const sequence = try std.fmt.allocPrint(allocator, "{d}", .{leaf_index});
    defer allocator.free(sequence);
    const text = try std.fmt.allocPrint(allocator, "{{\"block_number\":100,\"domain\":{d},\"leaf_index\":\"{d}\",\"merkle_tree_hook\":\"{s}\",\"message_id\":\"{s}\"}}", .{ state.domain, leaf_index, hook, id });
    defer allocator.free(text);
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, text, .{});
    defer parsed.deinit();
    try bridge.handleEvent(.{ .data = parsed.value, .domain = state.domain, .event_type = "merkle_tree_insertion", .sequence = sequence });
}

fn gasTestEvent(bridge: *Bridge, state: *OriginState, stream_cursor: u64, payment: u256) !void {
    const allocator = bridge.allocator;
    const id = try relayer.formatAddressAlloc(allocator, @splat(7));
    defer allocator.free(id);
    const paymaster = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.interchain_gas_paymaster);
    defer allocator.free(paymaster);
    const hash = try relayer.formatAddressAlloc(allocator, @splat(9));
    defer allocator.free(hash);
    const tx = try relayer.formatAddressAlloc(allocator, @splat(8));
    defer allocator.free(tx);
    const cursor = try std.fmt.allocPrint(allocator, "{d}", .{stream_cursor});
    defer allocator.free(cursor);
    const text = try std.fmt.allocPrint(allocator, "{{\"destination\":9,\"domain\":{d},\"gas_amount\":\"50\",\"id\":\"{s}\",\"interchain_gas_paymaster\":\"{s}\",\"log_index\":\"0\",\"msg_id\":\"{s}\",\"origin\":{d},\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"100\",\"origin_tx_hash\":\"{s}\",\"payment\":\"{d}\",\"sequence\":\"0\",\"time_created\":\"now\",\"tx_id\":null}}", .{ state.domain, cursor, paymaster, id, state.domain, hash, tx, payment });
    defer allocator.free(text);
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, text, .{});
    defer parsed.deinit();
    try bridge.handleEvent(.{ .data = parsed.value, .domain = state.domain, .event_type = "gas_payment", .legacy_max_stream_cursor = "0", .row_id = cursor, .stream_cursor = cursor });
}

fn callbackMetricSample(rendered: []const u8, name: []const u8, labels: []const []const u8) !i64 {
    var lines = std.mem.splitScalar(u8, rendered, '\n');
    lines: while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{') continue;
        for (labels) |label| if (std.mem.indexOf(u8, line, label) == null) continue :lines;
        const split = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.MissingMetricValue;
        return std.fmt.parseInt(i64, line[split + 1 ..], 10);
    }
    return error.MissingMetricSample;
}

pub fn runCallbackOutcomeRegression(allocator: A) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "callback-outcomes" });
    defer allocator.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(allocator, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try @import("../../ops/stream_metrics.zig").StreamMetrics.init(allocator, registry, .{});
    defer adapter.deinit();

    var chain: settings.Chain = undefined;
    chain.name = "fixture";
    var slot: origins.Slot = undefined;
    slot.chain = &chain;
    slot.authority = .{};
    var native_store = @import("../store.zig").Store.init(allocator, &database, "fixture");
    const state = try allocator.create(OriginState);
    state.* = .{
        .domain = 5,
        .slot = &slot,
        .adapter = store.Adapter.init(&native_store, .{ .mailbox = @splat(1), .interchain_gas_paymaster = @splat(2), .merkle_tree_hook = @splat(3) }),
        .controller = undefined,
        .generation = 0,
        .probe = null,
    };
    state.controller = try relayer.Controller.init(allocator, &.{.{ .domain = 5, .adapter = &state.adapter }}, .{ .authority_enabled = true, .parity_queue_capacity = 1 });
    var bridge: Bridge = .{
        .allocator = allocator,
        .options = .{ .url = "", .origins = undefined, .controller = .{ .authority_enabled = true, .parity_queue_capacity = 1 }, .transport = undefined, .observer = adapter.interface() },
        .owner = undefined,
        .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
        .online = true,
        .subscribed = true,
        .random = std.Random.DefaultPrng.init(1),
    };
    defer {
        state.controller.deinit();
        allocator.destroy(state);
        bridge.origins.deinit();
    }
    try bridge.origins.put(5, state);
    state.generation = try state.controller.beginConnection(5);
    try state.controller.markReady(5, state.generation, 3);
    try state.controller.markSubscribed(5, state.generation);
    try dispatchTestEvent(&bridge, state, 0);
    try std.testing.expectError(error.ParityOverflow, dispatchTestEvent(&bridge, state, 1));

    state.generation = try state.controllerGeneration();
    try state.controller.markReady(5, state.generation, 3);
    try state.controller.markSubscribed(5, state.generation);
    for ([_]u64{ 1, 2 }) |sequence| try state.adapter.storeGasPayment(.{
        .cursor = .{ .fingerprint = null, .legacy_max_stream_cursor = 0, .stream_cursor = sequence },
        .payment = .{ .message_id = @splat(7), .destination = 9, .payment = 100, .gas_amount = 50 },
        .meta = .{ .transaction_id = @splat(8), .log_index = 0 },
        .sequence = 0,
        .block_number = 100,
    });
    const paymaster = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.interchain_gas_paymaster);
    defer allocator.free(paymaster);
    try bridge.handleCaughtUp(.{ .address = paymaster, .domain = 5, .event_type = "gas_payment", .legacy_max_stream_cursor = "0", .stream_cursor = "0" });
    try gasTestEvent(&bridge, state, 1, 100);
    try gasTestEvent(&bridge, state, 2, 999);
    try gasTestEvent(&bridge, state, 3, 100);
    try bridge.handleCaughtUp(.{ .address = paymaster, .domain = 5, .event_type = "gas_payment", .legacy_max_stream_cursor = "0", .stream_cursor = "2" });
    var malformed = try std.json.parseFromSlice(std.json.Value, allocator, "{}", .{});
    defer malformed.deinit();
    try bridge.handleEvent(.{ .data = malformed.value, .domain = 5, .event_type = "gas_payment", .legacy_max_stream_cursor = "0", .row_id = "4", .stream_cursor = "4" });
    try bridge.handleCaughtUp(.{ .address = "not-an-address", .domain = 5, .event_type = "gas_payment" });
    try std.testing.expect(bridge.online and bridge.subscribed);

    const rendered = try registry.render(allocator);
    defer allocator.free(rendered);
    try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"dispatch\"", "result=\"accepted\"" }));
    try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"dispatch\"", "result=\"dropped\"" }));
    try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"accepted\"" }));
    try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"conflict\"" }));
    try std.testing.expectEqual(@as(i64, 4), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"dropped\"" }));
    try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"caught_up\"" }));
    try std.testing.expectError(error.MissingMetricSample, callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_events", &.{ "event_type=\"gas_payment\"", "result=\"invalid\"" }));
    try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(rendered, "hyperlane_relayer_scraper_websocket_parity_ready", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(u64, 0), adapter.failures.load(.acquire));
}

test "real callback outcomes distinguish conflict dropped marker and admission refusal" {
    try runCallbackOutcomeRegression(std.testing.allocator);
}

pub fn runParityPhaseRegression(allocator: A) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "parity-phase" });
    defer allocator.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(allocator, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try @import("../../ops/stream_metrics.zig").StreamMetrics.init(allocator, registry, .{});
    defer adapter.deinit();

    var chain: settings.Chain = undefined;
    chain.name = "fixture";
    var slot: origins.Slot = undefined;
    slot.chain = &chain;
    slot.authority = .{};
    var native_store = @import("../store.zig").Store.init(allocator, &database, "fixture");
    const state = try allocator.create(OriginState);
    state.* = .{
        .domain = 5,
        .slot = &slot,
        .adapter = store.Adapter.init(&native_store, .{ .mailbox = @splat(1), .interchain_gas_paymaster = @splat(2), .merkle_tree_hook = @splat(3) }),
        .controller = undefined,
        .generation = 0,
        .probe = null,
    };
    state.controller = try relayer.Controller.init(allocator, &.{.{ .domain = 5, .adapter = &state.adapter }}, .{ .authority_enabled = false });
    var bridge: Bridge = .{
        .allocator = allocator,
        .options = .{ .url = "", .origins = undefined, .controller = .{ .authority_enabled = false }, .transport = undefined, .observer = adapter.interface() },
        .owner = undefined,
        .origins = std.AutoHashMap(u32, *OriginState).init(allocator),
        .online = true,
        .subscribed = true,
        .random = std.Random.DefaultPrng.init(1),
    };
    defer {
        state.controller.deinit();
        allocator.destroy(state);
        bridge.origins.deinit();
    }
    try bridge.origins.put(5, state);
    bridge.observeInitial(state);
    try state.adapter.storeCursor(.dispatch, 0);
    try state.adapter.storeCursor(.merkle_tree_insertion, 0);
    state.generation = try state.controller.beginConnection(5);
    try state.controller.markReady(5, state.generation, 3);
    try state.controller.markSubscribed(5, state.generation);
    const mailbox = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.mailbox);
    defer allocator.free(mailbox);
    const hook = try relayer.formatAddressAlloc(allocator, state.adapter.contracts.merkle_tree_hook);
    defer allocator.free(hook);

    try bridge.handleCaughtUp(.{ .address = mailbox, .domain = 5, .event_type = "dispatch", .sequence = "1" });
    const one_marker = try registry.render(allocator);
    defer allocator.free(one_marker);
    try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(one_marker, "hyperlane_relayer_scraper_websocket_caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(one_marker, "hyperlane_relayer_scraper_websocket_caught_up", &.{"event_type=\"merkle_tree_insertion\""}));

    try bridge.handleCaughtUp(.{ .address = hook, .domain = 5, .event_type = "merkle_tree_insertion", .sequence = "1" });
    for (0..2) |nonce| {
        try dispatchTestEvent(&bridge, state, @intCast(nonce));
        try merkleTestEvent(&bridge, state, @intCast(nonce));
    }
    const pending = try registry.render(allocator);
    defer allocator.free(pending);
    for ([_][]const u8{ "dispatch", "merkle_tree_insertion" }) |label| {
        const event_type = try std.fmt.allocPrint(allocator, "event_type=\"{s}\"", .{label});
        defer allocator.free(event_type);
        try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(pending, "hyperlane_relayer_scraper_websocket_caught_up", &.{event_type}));
        try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(pending, "hyperlane_relayer_scraper_websocket_parity_ready", &.{event_type}));
        try std.testing.expectEqual(@as(i64, 2), try callbackMetricSample(pending, "hyperlane_relayer_scraper_websocket_parity_pending", &.{event_type}));
    }
    try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(pending, "hyperlane_relayer_scraper_websocket_authority", &.{"chain=\"fixture\""}));

    for (0..2) |nonce| {
        const message: @import("../../protocol/root.zig").Message = .{
            .version = 3,
            .nonce = @intCast(nonce),
            .origin = 5,
            .sender = @splat(4),
            .destination = 9,
            .recipient = @splat(5),
            .body = "hello",
        };
        _ = try native_store.storeMessage(message, 100, [_]u8{0} ** 32 ++ [_]u8{8} ** 32);
        _ = try native_store.storeInsertion(.{ .leaf_index = @intCast(nonce), .message_id = message.id() }, 100);
    }
    try bridge.processOrigin(state, 0);
    const matched = try registry.render(allocator);
    defer allocator.free(matched);
    for ([_][]const u8{ "dispatch", "merkle_tree_insertion" }) |label| {
        const event_type = try std.fmt.allocPrint(allocator, "event_type=\"{s}\"", .{label});
        defer allocator.free(event_type);
        try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(matched, "hyperlane_relayer_scraper_websocket_caught_up", &.{event_type}));
        try std.testing.expectEqual(@as(i64, 1), try callbackMetricSample(matched, "hyperlane_relayer_scraper_websocket_parity_ready", &.{event_type}));
        try std.testing.expectEqual(@as(i64, 0), try callbackMetricSample(matched, "hyperlane_relayer_scraper_websocket_parity_pending", &.{event_type}));
        try std.testing.expectEqual(@as(i64, 2), try callbackMetricSample(matched, "hyperlane_relayer_scraper_websocket_parity", &.{ event_type, "result=\"match\"" }));
    }
    try std.testing.expectEqual(@as(u64, 0), adapter.failures.load(.acquire));
}

test "joint caught-up precedes terminal parity then independently becomes ready" {
    try runParityPhaseRegression(std.testing.allocator);
}
