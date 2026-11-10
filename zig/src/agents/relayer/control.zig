//! Serialized administrative commands for operational relayer destination lanes.
const std = @import("std");
const commands = @import("../../runtime/commands.zig");
const queue_view = @import("queue_view.zig");
const supervisor = @import("../../runtime/supervisor.zig");
const settings = struct {
    pub const Settings = @import("../../settings/root.zig").Settings;
    pub const Chain = @import("../../settings/types.zig").Chain;
    pub const Relayer = @import("../../settings/types.zig").Relayer;
    pub const GasEnforcement = @import("../../settings/types.zig").GasEnforcement;
    pub const MatchingList = @import("../../settings/types.zig").MatchingList;
    pub const Rule = @import("../../settings/types.zig").Rule;
    pub const Filter = @import("../../settings/types.zig").Filter;
};
const protocol = @import("../../protocol/root.zig");
const api = @import("../../ops/admin/api.zig");
const http = @import("../../ops/http.zig");
const admin_json = @import("../../ops/admin/json.zig");
const matching = @import("../../ops/matching.zig");
const regex = @import("../../ops/regex.zig");
const relay_policy = @import("../relay_policy.zig");
const loader = @import("../loader.zig");
const origins = @import("../origin_tasks.zig");
const signer_tasks = @import("../origin_signer_tasks.zig");
const runtime_denylist = @import("../../ops/runtime_denylist.zig");
const db = @import("../../db/root.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);
const command_timeout_ms: u64 = 10_000;

const OwnedRule = struct {
    policy: admin_json.GasPolicy,
    matching_list: settings.MatchingList,

    fn clone(a: A, source: api.GasRule) !OwnedRule {
        return .{ .policy = source.policy, .matching_list = try cloneMatching(a, source.matching_list) };
    }
    fn fromSettings(a: A, source: settings.GasEnforcement) !OwnedRule {
        return .{ .policy = source.policy, .matching_list = try cloneMatching(a, source.matching_list) };
    }
    fn deinit(self: *OwnedRule, a: A) void {
        freeMatching(a, self.matching_list);
        self.* = undefined;
    }
};

fn cloneMatching(a: A, source: settings.MatchingList) !settings.MatchingList {
    const result = try a.alloc(settings.Rule, source.len);
    var initialized: usize = 0;
    errdefer {
        for (result[0..initialized]) |*rule| freeRule(a, rule);
        a.free(result);
    }
    for (source, result) |input, *output| {
        output.* = try cloneRule(a, input);
        initialized += 1;
    }
    return result;
}

fn cloneRule(a: A, input: settings.Rule) !settings.Rule {
    var result: settings.Rule = .{};
    errdefer freeRule(a, &result);
    result.message_id = try cloneFilter(a, [32]u8, input.message_id);
    result.origin_domain = try cloneFilter(a, u32, input.origin_domain);
    result.sender_address = try cloneFilter(a, [32]u8, input.sender_address);
    result.destination_domain = try cloneFilter(a, u32, input.destination_domain);
    result.recipient_address = try cloneFilter(a, [32]u8, input.recipient_address);
    result.body_regex = if (input.body_regex) |pattern| try a.dupe(u8, pattern) else null;
    return result;
}

fn cloneFilter(a: A, comptime T: type, source: settings.Filter(T)) !settings.Filter(T) {
    return switch (source) {
        .wildcard => .wildcard,
        .values => |values| .{ .values = try a.dupe(T, values) },
    };
}

fn freeRule(a: A, rule: *const settings.Rule) void {
    freeFilter(a, [32]u8, rule.message_id);
    freeFilter(a, u32, rule.origin_domain);
    freeFilter(a, [32]u8, rule.sender_address);
    freeFilter(a, u32, rule.destination_domain);
    freeFilter(a, [32]u8, rule.recipient_address);
    if (rule.body_regex) |pattern| a.free(pattern);
}

fn freeFilter(a: A, comptime T: type, filter: settings.Filter(T)) void {
    switch (filter) {
        .wildcard => {},
        .values => |values| a.free(values),
    }
}

fn freeMatching(a: A, list: settings.MatchingList) void {
    for (list) |*rule| freeRule(a, rule);
    a.free(list);
}

const RetryRequest = struct { uuid: []u8, pattern: settings.MatchingList };
const EnvironmentSet = struct { name: []u8, value: ?[]u8 };
const RelayReserve = struct { id: u64, transaction: [64]u8, messages: []protocol.Message };
const Reservation = struct {
    id: u64,
    transaction: [64]u8,
    storage: []*anyopaque,
    items: []*anyopaque,
    retained_bytes: usize,
    context: *anyopaque,
    drop_fn: *const fn (*anyopaque, []*anyopaque, usize) void,
    snapshot_rows: queue_view.Rows,

    fn deinit(self: *Reservation, a: A) void {
        self.snapshot_rows.deinit();
        self.drop_fn(self.context, self.items, self.retained_bytes);
        a.free(self.storage);
        self.* = undefined;
    }
};
const Request = union(enum) {
    retry: RetryRequest,
    reprocess: protocol.Message,
    gas_add: OwnedRule,
    gas_list,
    gas_remove: usize,
    nonce_overwrite: ?u64,
    environment_get: []u8,
    environment_set: EnvironmentSet,
    relay_reserve: RelayReserve,
    relay_authorize: u64,
    relay_commit: u64,
    relay_abort: u64,
};
const DomainRules = struct { domain: []const u8, rules: []OwnedRule };
const Response = union(enum) {
    empty,
    retry: api.RetryResult,
    reprocess: []u8,
    gas_rules: DomainRules,
    environment: api.EnvironmentValue,
};
const Queue = commands.Queue(Request, Response);

const RulesLedger = struct {
    allocator: A,
    rules: std.ArrayList(OwnedRule) = .empty,

    fn init(a: A, configured: []const settings.GasEnforcement) !RulesLedger {
        var self: RulesLedger = .{ .allocator = a };
        errdefer self.deinit();
        try self.rules.ensureTotalCapacityPrecise(a, configured.len);
        for (configured) |rule| self.rules.appendAssumeCapacity(try OwnedRule.fromSettings(a, rule));
        return self;
    }
    fn deinit(self: *RulesLedger) void {
        for (self.rules.items) |*rule| rule.deinit(self.allocator);
        self.rules.deinit(self.allocator);
        self.* = undefined;
    }
    fn add(self: *RulesLedger, rule: OwnedRule) !void {
        var owned = rule;
        errdefer owned.deinit(self.allocator);
        try self.rules.insert(self.allocator, 0, owned);
    }
    fn remove(self: *RulesLedger, index: usize) !void {
        if (index >= self.rules.items.len) return error.InvalidGasRuleIndex;
        var removed = self.rules.orderedRemove(index);
        removed.deinit(self.allocator);
    }
    fn policyConfig(self: *const RulesLedger, base: settings.Relayer) !relay_policy.Config {
        const rules = try self.allocator.alloc(settings.GasEnforcement, self.rules.items.len);
        for (self.rules.items, rules) |source, *destination| destination.* = .{ .policy = source.policy, .matching_list = source.matching_list };
        var result = relay_policy.Config.fromSettings(base);
        result.gas_payment_enforcement = rules;
        return result;
    }
    fn buildPolicy(self: *const RulesLedger, hub: *const Hub) !relay_policy.Policy {
        const configured = try self.policyConfig(hub.settings.role.relayer);
        defer self.allocator.free(configured.gas_payment_enforcement);
        return relay_policy.Policy.init(self.allocator, configured, hub.regex_engine, hub.denylist);
    }
};

pub const Control = struct {
    pub fn reservedSlots(self: *const Control) usize {
        return if (self.relay_reservation) |reservation| reservation.storage.len else 0;
    }
    pub fn reservedBytes(self: *const Control) usize {
        return if (self.relay_reservation) |reservation| reservation.retained_bytes else 0;
    }
    hub: *Hub,
    chain: *const settings.Chain,
    queue: Queue,
    ledger: RulesLedger,
    wake: *const std.atomic.Value(bool),
    relay_reservation: ?Reservation = null,
    committed_relay_id: ?u64 = null,
    snapshot: queue_view.View,

    pub fn init(hub: *Hub, chain: *const settings.Chain) !*Control {
        if (hub.closed) return error.ControlHubStopped;
        const self = try hub.allocator.create(Control);
        errdefer hub.allocator.destroy(self);
        self.* = .{
            .hub = hub,
            .chain = chain,
            .queue = try Queue.init(hub.allocator, 64, dropRequest, dropResponse),
            .ledger = undefined,
            .wake = undefined,
            .snapshot = .{ .allocator = hub.allocator },
        };
        errdefer self.queue.deinit();
        self.ledger = try RulesLedger.init(hub.allocator, hub.settings.role.relayer.gas_payment_enforcement);
        errdefer self.ledger.deinit();
        self.wake = &self.queue.wake;
        try hub.controls.append(hub.allocator, self);
        return self;
    }

    pub fn deinit(self: *Control) void {
        const hub = self.hub;
        for (hub.controls.items, 0..) |candidate, index| {
            if (candidate == self) {
                _ = hub.controls.swapRemove(index);
                break;
            }
        }
        if (self.relay_reservation) |*reservation| reservation.deinit(hub.allocator);
        self.ledger.deinit();
        self.queue.deinit();
        self.snapshot.deinit();
        const a = hub.allocator;
        a.destroy(self);
    }

    pub fn drain(self: *Control, lane: anytype, times: supervisor.Times, cancel: Cancel) !u64 {
        self.bindSnapshotBudget(lane.owner);
        try self.ensurePolicies(lane);
        if (!self.snapshot.published()) try self.refreshSnapshotContexts(lane);
        try self.snapshot.activate();
        var work: u64 = 0;
        while (self.queue.take()) |entry| {
            work +|= 1;
            if (entry.cancel.load(.acquire)) {
                self.queue.finish(entry, error.RequestCancelled);
                continue;
            }
            const result = self.execute(lane, &entry.request, times, &entry.cancel);
            self.queue.finish(entry, result);
        }
        if (cancel.load(.acquire)) return error.RequestCancelled;
        return work;
    }

    pub fn bindSnapshotBudget(self: *Control, owner: anytype) void {
        const Owner = @TypeOf(owner);
        self.snapshot.bind(.{
            .context = owner,
            .reserve_fn = struct {
                fn reserve(context: *anyopaque, bytes: usize) bool {
                    const value: Owner = @ptrCast(@alignCast(context));
                    return reserveBytes(value, bytes);
                }
            }.reserve,
            .release_fn = struct {
                fn release(context: *anyopaque, bytes: usize) void {
                    const value: Owner = @ptrCast(@alignCast(context));
                    releaseBytes(value, bytes);
                }
            }.release,
        }, owner.options.max_active, .{ .ready = &owner.denylist_ready, .halted = &owner.effects_halted });
    }
    pub fn prepareSnapshotRow(self: *Control, lane: anytype, origin_index: usize, message: protocol.Message) !*queue_view.Row {
        self.bindSnapshotBudget(lane.owner);
        const origin = lane.owner.origins.slots[origin_index].handle() orelse return error.OriginNotReady;
        const context = if (lane.origins[origin_index].policy) |*policy| try policy.appContext(message) else null;
        return self.snapshot.prepare(origin.store, origin_index, message, context);
    }
    fn prepareContexts(self: *Control, lane: anytype, input: []*queue_view.Row, replacements: ?[]?relay_policy.Policy) !queue_view.Rows {
        var result = try self.snapshot.allocateRows(input.len);
        errdefer result.deinit();
        for (input) |row| {
            const policy = if (replacements) |values| &values[row.origin_index] else &lane.origins[row.origin_index].policy;
            const context = if (policy.*) |*value| try value.appContext(row.message.value) else null;
            result.appendAssumeCapacity(try self.snapshot.prepare(row.store, row.origin_index, row.message.value, context));
        }
        return result;
    }
    fn refreshSnapshotContexts(self: *Control, lane: anytype) !void {
        var current = try self.prepareContexts(lane, self.snapshot.rows.items, null);
        defer current.deinit();
        var reserved = if (self.relay_reservation) |*reservation| try self.prepareContexts(lane, reservation.snapshot_rows.items(), null) else try self.snapshot.allocateRows(0);
        defer reserved.deinit();
        self.snapshot.beginPublish();
        self.snapshot.swapLocked(&current);
        if (self.relay_reservation) |*reservation| std.mem.swap(queue_view.Rows, &reservation.snapshot_rows, &reserved);
        self.snapshot.finishPublish();
    }

    fn ensurePolicies(self: *Control, lane: anytype) !void {
        for (lane.origins, 0..) |*origin, index| {
            if (origin.policy != null) continue;
            _ = lane.owner.origins.slots[index].handle() orelse continue;
            try self.ensurePolicy(lane, index);
        }
    }

    pub fn ensurePolicy(self: *Control, lane: anytype, index: usize) !void {
        if (lane.origins[index].policy != null) return;
        // This constructor is pure: allocation failure discards the attempt;
        // only a successful first policy can publish initialization latency.
        const observed = @hasDecl(@TypeOf(lane.*), "observeGasEnforcer");
        var timer: ?std.time.Timer = if (observed) std.time.Timer.start() catch null else null;
        const policy = try self.ledger.buildPolicy(self.hub);
        if (self.snapshot.budget != null) self.snapshot.invalidate();
        lane.origins[index].policy = policy;
        if (observed) if (timer) |*value| lane.observeGasEnforcer(index, value.read());
        if (self.snapshot.budget != null) try self.refreshSnapshotContexts(lane);
    }

    fn execute(self: *Control, lane: anytype, request: *const Request, times: supervisor.Times, cancel: Cancel) anyerror!Response {
        return switch (request.*) {
            .retry => |*value| .{ .retry = try retry(self, lane, value, times, cancel) },
            .reprocess => |message| .{ .reprocess = try reprocess(self, lane, message, times, cancel) },
            .gas_add => |*rule| .{ .empty = try self.addGas(lane, rule.*) },
            .gas_list => .{ .gas_rules = try self.listGas() },
            .gas_remove => |index| .{ .empty = try self.removeGas(lane, index) },
            .nonce_overwrite => |nonce| .{ .empty = try overwriteNonce(lane, nonce) },
            .environment_get => |name| .{ .environment = try environmentGet(self.hub.allocator, name) },
            .environment_set => |value| .{ .environment = try environmentSet(self.hub.allocator, value.name, value.value) },
            .relay_reserve => |*value| .{ .empty = try reserveRelay(self, lane, value) },
            .relay_authorize => |id| .{ .empty = try authorizeRelay(self, lane, id) },
            .relay_commit => |id| .{ .empty = try commitRelay(self, lane, id) },
            .relay_abort => |id| .{ .empty = abortRelay(self, id) },
        };
    }

    fn addGas(self: *Control, lane: anytype, rule: OwnedRule) !void {
        var owned = try OwnedRule.clone(self.hub.allocator, .{ .policy = rule.policy, .matching_list = rule.matching_list });
        var retained = false;
        defer if (!retained) owned.deinit(self.hub.allocator);
        try self.ledger.add(owned);
        retained = true;
        self.rebuildPolicies(lane) catch |err| {
            var removed = self.ledger.rules.orderedRemove(0);
            removed.deinit(self.hub.allocator);
            return err;
        };
    }

    fn removeGas(self: *Control, lane: anytype, index: usize) !void {
        if (index >= self.ledger.rules.items.len) return error.InvalidGasRuleIndex;
        var removed = self.ledger.rules.orderedRemove(index);
        self.rebuildPolicies(lane) catch |err| {
            try self.ledger.rules.insert(self.hub.allocator, index, removed);
            return err;
        };
        removed.deinit(self.hub.allocator);
    }

    fn rebuildPolicies(self: *Control, lane: anytype) !void {
        const a = self.hub.allocator;
        const replacements = try a.alloc(?relay_policy.Policy, lane.origins.len);
        defer a.free(replacements);
        @memset(replacements, null);
        defer for (replacements) |*replacement| if (replacement.*) |*value| value.deinit();
        for (lane.origins, replacements) |origin, *replacement| {
            if (origin.policy != null) replacement.* = try self.ledger.buildPolicy(self.hub);
        }
        var current = try self.prepareContexts(lane, self.snapshot.rows.items, replacements);
        defer current.deinit();
        var reserved = if (self.relay_reservation) |*reservation| try self.prepareContexts(lane, reservation.snapshot_rows.items(), replacements) else try self.snapshot.allocateRows(0);
        defer reserved.deinit();
        self.snapshot.beginPublish();
        for (lane.origins, replacements) |*origin, *replacement| {
            if (replacement.* != null) std.mem.swap(?relay_policy.Policy, &origin.policy, replacement);
        }
        self.snapshot.swapLocked(&current);
        if (self.relay_reservation) |*reservation| std.mem.swap(queue_view.Rows, &reservation.snapshot_rows, &reserved);
        self.snapshot.finishPublish();
    }

    fn listGas(self: *Control) !DomainRules {
        const a = self.hub.allocator;
        const rules = try a.alloc(OwnedRule, self.ledger.rules.items.len);
        var initialized: usize = 0;
        errdefer {
            for (rules[0..initialized]) |*rule| rule.deinit(a);
            a.free(rules);
        }
        for (self.ledger.rules.items, rules) |source, *destination| {
            destination.* = try OwnedRule.clone(a, .{ .policy = source.policy, .matching_list = source.matching_list });
            initialized += 1;
        }
        return .{ .domain = self.chain.name, .rules = rules };
    }
};

fn dropRequest(a: A, request: *Request) void {
    switch (request.*) {
        .gas_list, .gas_remove, .nonce_overwrite, .relay_authorize, .relay_commit, .relay_abort => {},
        .retry => |*value| {
            a.free(value.uuid);
            freeMatching(a, value.pattern);
        },
        .reprocess => |message| a.free(message.body),
        .gas_add => |*rule| rule.deinit(a),
        .environment_get => |name| a.free(name),
        .environment_set => |value| {
            a.free(value.name);
            if (value.value) |text| a.free(text);
        },
        .relay_reserve => |value| {
            for (value.messages) |message| a.free(message.body);
            a.free(value.messages);
        },
    }
    request.* = undefined;
}

fn dropResponse(a: A, response: *Response) void {
    switch (response.*) {
        .empty, .retry => {},
        .reprocess => |bytes| a.free(bytes),
        .gas_rules => |value| {
            for (value.rules) |*rule| rule.deinit(a);
            a.free(value.rules);
        },
        .environment => |value| switch (value) {
            .absent => {},
            .value => |text| a.free(text),
        },
    }
    response.* = undefined;
}

fn cloneRequest(a: A, request: Request) !Request {
    return switch (request) {
        .gas_list, .gas_remove, .nonce_overwrite, .relay_authorize, .relay_commit, .relay_abort => request,
        .retry => |value| blk: {
            const uuid = try a.dupe(u8, value.uuid);
            errdefer a.free(uuid);
            break :blk .{ .retry = .{ .uuid = uuid, .pattern = try cloneMatching(a, value.pattern) } };
        },
        .reprocess => |message| blk: {
            var copy = message;
            copy.body = try a.dupe(u8, message.body);
            break :blk .{ .reprocess = copy };
        },
        .gas_add => |rule| .{ .gas_add = try OwnedRule.clone(a, .{ .policy = rule.policy, .matching_list = rule.matching_list }) },
        .relay_reserve => |value| blk: {
            const messages = try a.alloc(protocol.Message, value.messages.len);
            var initialized: usize = 0;
            errdefer {
                for (messages[0..initialized]) |message| a.free(message.body);
                a.free(messages);
            }
            for (value.messages, messages) |source, *destination| {
                destination.* = source;
                destination.body = try a.dupe(u8, source.body);
                initialized += 1;
            }
            break :blk .{ .relay_reserve = .{ .id = value.id, .transaction = value.transaction, .messages = messages } };
        },
        .environment_get => |name| .{ .environment_get = try a.dupe(u8, name) },
        .environment_set => |value| blk: {
            const name = try a.dupe(u8, value.name);
            errdefer a.free(name);
            break :blk .{ .environment_set = .{ .name = name, .value = if (value.value) |text| try a.dupe(u8, text) else null } };
        },
    };
}

fn renderSnapshot(a: A, rows: []*queue_view.Row, cancel: Cancel) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const Item = struct { retries: u32, position: usize, value: std.json.Value };
    var items = std.array_list.Managed(Item).init(temporary);
    for (rows, 0..) |item, position| {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        const message = item.message.value;
        const state = locked: {
            item.store.mutex.lock();
            defer item.store.mutex.unlock();
            break :locked .{ .retries = try item.store.retryCount(message.id()), .status = (try item.store.status(message.id())) orelse .FirstPrepareAttempt };
        };
        const retries = state.retries;
        const status = state.status;
        const app_context = item.app_context;
        var out = std.Io.Writer.Allocating.init(temporary);
        try out.writer.writeAll("{\"type\":\"PendingMessage\",\"message\":");
        try admin_json.writeMessage(&out.writer, message);
        try out.writer.writeAll(",\"status\":");
        const encoded_status = try status.toJson(temporary);
        try out.writer.writeAll(encoded_status);
        try out.writer.writeAll(",\"app_context\":");
        if (app_context) |name| {
            var debug = std.Io.Writer.Allocating.init(temporary);
            try admin_json.writeString(&debug.writer, name);
            try out.writer.writeAll(debug.written());
        } else try out.writer.writeAll("null");
        try out.writer.print(",\"submitted\":{},\"num_retries\":{d}}}", .{ status == .Confirm, retries });
        const parsed = try std.json.parseFromSlice(std.json.Value, temporary, out.written(), .{});
        var object = std.json.ObjectMap.init(temporary);
        var id = std.Io.Writer.Allocating.init(temporary);
        try admin_json.writePrefixedHash(&id.writer, message.id());
        try object.put("id", .{ .string = id.written() });
        try object.put("operation", parsed.value);
        try items.append(.{ .retries = retries, .position = position, .value = .{ .object = object } });
    }
    std.mem.sort(Item, items.items, {}, struct {
        fn less(_: void, left: Item, right: Item) bool {
            if (left.retries != right.retries) return left.retries < right.retries;
            return left.position < right.position;
        }
    }.less);
    const values = try temporary.alloc(std.json.Value, items.items.len);
    for (items.items, values) |item, *value| value.* = item.value;
    return std.json.Stringify.valueAlloc(a, std.json.Value{ .array = .{ .items = values, .capacity = values.len, .allocator = temporary } }, .{ .whitespace = .indent_2 });
}

fn retry(self: *Control, lane: anytype, request: *const RetryRequest, times: supervisor.Times, cancel: Cancel) !api.RetryResult {
    _ = request.uuid;
    var result: api.RetryResult = .{};
    var matcher = try matching.Matcher.init(self.hub.allocator, request.pattern, self.hub.regex_engine);
    defer matcher.deinit();
    for (lane.active.items) |item| {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        result.evaluated +|= 1;
        if (!try matcher.messageMatches(item.message.value, false)) continue;
        const origin = lane.owner.origins.slots[item.origin_index].handle() orelse {
            result.failed +|= 1;
            continue;
        };
        resetManual(lane.owner.allocator, origin.store, item.message.value) catch {
            result.failed +|= 1;
            continue;
        };
        result.matched +|= 1;
        if (@hasDecl(@TypeOf(lane.*), "releaseGroupSender")) lane.releaseGroupSender(item.message.value.id());
        item.next_ms = times.monotonic_ms;
        if (@hasField(@TypeOf(item.*), "signer_prepare")) item.signer_prepare = .{};
        if (@hasField(@TypeOf(item.*), "sender_state")) item.sender_state = .{};
        if (@hasField(@TypeOf(item.*), "native_submit_queued")) item.native_submit_queued = null;
        if (@hasField(@TypeOf(item.*), "native_needs_preparation")) item.native_needs_preparation = null;
        if (@hasField(@TypeOf(item.*), "native_prepare_admitted")) item.native_prepare_admitted = false;
        if (@hasField(@TypeOf(item.*), "native_pop_checked")) item.native_pop_checked = false;
        if (@hasField(@TypeOf(item.*), "native_submit_inflight")) item.native_submit_inflight = false;
    }
    return result;
}

fn reprocess(self: *Control, lane: anytype, message: protocol.Message, times: supervisor.Times, cancel: Cancel) ![]u8 {
    if (cancel.load(.acquire)) return error.RequestCancelled;
    if (message.destination != lane.chain.domain) return error.QueueNotFound;
    var origin_index: ?usize = null;
    for (lane.owner.origins.slots, 0..) |*slot, index| {
        const origin = slot.handle() orelse continue;
        if (origin.chain.domain == message.origin) {
            origin_index = index;
            break;
        }
    }
    const index = origin_index orelse return error.MessageContextNotFound;
    const origin = lane.owner.origins.slots[index].handle() orelse return error.MessageContextNotFound;
    try self.ensurePolicy(lane, index);
    if (lane.origins[index].loader == null) lane.origins[index].loader = try loader.Loader.init(lane.owner.allocator, origin.store, &.{lane.chain.domain}, .{ .max_loaded = lane.owner.options.max_active });
    _ = try lane.origins[index].loader.?.migrate();
    try resetManual(lane.owner.allocator, origin.store, message);
    if (@hasDecl(@TypeOf(lane.*), "releaseGroupSender")) lane.releaseGroupSender(message.id());
    lane.origins[index].loader.?.rescan();
    for (lane.active.items) |item| {
        if (std.mem.eql(u8, &item.message.value.id(), &message.id())) {
            item.next_ms = times.monotonic_ms;
            if (@hasField(@TypeOf(item.*), "signer_prepare")) item.signer_prepare = .{};
            if (@hasField(@TypeOf(item.*), "sender_state")) item.sender_state = .{};
            if (@hasField(@TypeOf(item.*), "native_submit_queued")) item.native_submit_queued = null;
            if (@hasField(@TypeOf(item.*), "native_needs_preparation")) item.native_needs_preparation = null;
            if (@hasField(@TypeOf(item.*), "native_prepare_admitted")) item.native_prepare_admitted = false;
            if (@hasField(@TypeOf(item.*), "native_pop_checked")) item.native_pop_checked = false;
            if (@hasField(@TypeOf(item.*), "native_submit_inflight")) item.native_submit_inflight = false;
        }
    }
    var out = std.Io.Writer.Allocating.init(self.hub.allocator);
    errdefer out.deinit();
    try out.writer.writeAll("PendingMessage { num_retries: 0, since_last_attempt_s: 0, next_attempt_after_s: 0, message_id: ");
    try admin_json.writePrefixedHash(&out.writer, message.id());
    try out.writer.writeAll(", status: Retry(Manual), app_context: None }");
    return admin_json.finish(&out, self.hub.allocator);
}

fn resetManual(a: A, store: anytype, message: protocol.Message) !void {
    store.mutex.lock();
    defer store.mutex.unlock();
    var canonical = (try store.messageByNonce(message.nonce)) orelse return error.StaleCanonicalMessage;
    defer canonical.deinit();
    if (!std.mem.eql(u8, &canonical.value.id(), &message.id()) or canonical.value.destination != message.destination) return error.StaleCanonicalMessage;
    const retry_state: db.json.RetryState = .{ .retry_count = 0, .next_attempt_at_millis = null, .retry_delay_millis = null, .reason = null };
    const retry_bytes = try retry_state.toJson(a);
    defer a.free(retry_bytes);
    const status: db.json.Status = .{ .Retry = .Manual };
    const status_bytes = try status.toJson(a);
    defer a.free(status_bytes);
    var count: [4]u8 = undefined;
    std.mem.writeInt(u32, &count, 0, .big);
    var batch = try store.typed.batch(a);
    defer batch.deinit();
    const id = message.id();
    try batch.put(db.keys.Table.pending_message_retry_count.prefix(), &id, &count);
    try batch.put(db.keys.Table.pending_message_retry_state.prefix(), &id, retry_bytes);
    try batch.put(db.keys.Table.status_by_message_id.prefix(), &id, status_bytes);
    try batch.commitSync();
}

fn reserveBytes(owner: anytype, bytes: usize) bool {
    owner.memory_mutex.lock();
    defer owner.memory_mutex.unlock();
    if (bytes > owner.options.max_retained_bytes - owner.retained_bytes) return false;
    owner.retained_bytes += bytes;
    return true;
}

fn releaseBytes(owner: anytype, bytes: usize) void {
    owner.memory_mutex.lock();
    defer owner.memory_mutex.unlock();
    std.debug.assert(bytes <= owner.retained_bytes);
    owner.retained_bytes -= bytes;
}

fn reserveRelay(self: *Control, lane: anytype, request: *const RelayReserve) !void {
    if (self.relay_reservation != null) return error.RelayReservationPending;
    if (request.messages.len == 0 or request.messages.len > 10) return error.InvalidRelayBatch;
    if (request.messages.len > lane.owner.options.max_active -| lane.active.items.len) return error.ProcessorCapacityUnavailable;
    const a = lane.owner.allocator;
    const ItemPtr = std.meta.Child(@TypeOf(lane.active.items));
    const Item = std.meta.Child(ItemPtr);
    var retained_bytes: usize = 0;
    for (request.messages) |message| retained_bytes = try std.math.add(usize, retained_bytes, try std.math.add(usize, try std.math.add(usize, protocol.Message.prefix_len, message.body.len), @sizeOf(Item)));
    if (retained_bytes > lane.owner.options.max_active_bytes -| lane.active_bytes) return error.ProcessorCapacityUnavailable;
    if (!reserveBytes(lane.owner, retained_bytes)) return error.ProcessorCapacityUnavailable;
    var memory_retained = true;
    errdefer if (memory_retained) releaseBytes(lane.owner, retained_bytes);
    try lane.active.ensureUnusedCapacity(a, request.messages.len);
    self.bindSnapshotBudget(lane.owner);
    try self.snapshot.ensureCapacity(lane.active.items.len + request.messages.len);
    var snapshot_rows = try self.snapshot.allocateRows(request.messages.len);
    var snapshot_transferred = false;
    defer if (!snapshot_transferred) snapshot_rows.deinit();
    const storage = try a.alloc(*anyopaque, request.messages.len);
    var reservation: Reservation = .{
        .id = request.id,
        .transaction = request.transaction,
        .storage = storage,
        .items = storage[0..0],
        .retained_bytes = retained_bytes,
        .context = lane,
        .snapshot_rows = snapshot_rows,
        .drop_fn = struct {
            fn drop(context: *anyopaque, items: []*anyopaque, bytes: usize) void {
                const owned_lane: @TypeOf(lane) = @ptrCast(@alignCast(context));
                for (items) |raw| {
                    const item: ItemPtr = @ptrCast(@alignCast(raw));
                    item.message.deinit();
                    owned_lane.owner.allocator.destroy(item);
                }
                releaseBytes(owned_lane.owner, bytes);
            }
        }.drop,
    };
    snapshot_transferred = true;
    errdefer reservation.deinit(a);
    memory_retained = false;
    for (request.messages) |message| {
        var origin_index: ?usize = null;
        for (lane.owner.origins.slots, 0..) |*slot, index| {
            const origin = slot.handle() orelse continue;
            if (origin.chain.domain == message.origin) {
                origin_index = index;
                break;
            }
        }
        const index = origin_index orelse return error.MessageContextNotFound;
        const origin = lane.owner.origins.slots[index].handle() orelse return error.MessageContextNotFound;
        if (lane.origins[index].loader == null) lane.origins[index].loader = try loader.Loader.init(a, origin.store, &.{lane.chain.domain}, .{ .max_loaded = lane.owner.options.max_active });
        const encoded = try message.encodeAlloc(a);
        var item_transferred = false;
        errdefer if (!item_transferred) a.free(encoded);
        const item = try a.create(Item);
        errdefer if (!item_transferred) a.destroy(item);
        item.* = .{
            .origin_index = index,
            .message = .{ .allocator = a, .bytes = encoded, .value = try protocol.Message.decode(encoded) },
            .retained_bytes = message.encodedLen() + @sizeOf(Item),
        };
        storage[reservation.items.len] = item;
        reservation.items = storage[0 .. reservation.items.len + 1];
        item_transferred = true;
        reservation.snapshot_rows.appendAssumeCapacity(try self.prepareSnapshotRow(lane, index, message));
    }
    self.relay_reservation = reservation;
    memory_retained = false;
}

fn authorizeRelay(self: *Control, lane: anytype, id: u64) !void {
    const reservation = if (self.relay_reservation) |*value| value else {
        if (self.committed_relay_id == id) return;
        return error.RelayReservationNotFound;
    };
    if (reservation.id != id) return error.RelayReservationNotFound;
    const ItemPtr = std.meta.Child(@TypeOf(lane.active.items));
    for (reservation.items) |raw| {
        const item: ItemPtr = @ptrCast(@alignCast(raw));
        const origin = lane.owner.origins.slots[item.origin_index].handle() orelse return error.MessageContextNotFound;
        try origin.store.admitReceiptMessage(item.message.value, reservation.transaction);
    }
}

fn commitRelay(self: *Control, lane: anytype, id: u64) !void {
    const reservation = if (self.relay_reservation) |*value| value else {
        if (self.committed_relay_id == id) return;
        return error.RelayReservationNotFound;
    };
    if (reservation.id != id) return error.RelayReservationNotFound;
    const ItemPtr = std.meta.Child(@TypeOf(lane.active.items));
    std.debug.assert(reservation.snapshot_rows.count == reservation.items.len);
    self.snapshot.beginPublish();
    for (reservation.items, reservation.snapshot_rows.items()) |raw, row| {
        const item: ItemPtr = @ptrCast(@alignCast(raw));
        lane.active.appendAssumeCapacity(item);
        lane.active_bytes += item.retained_bytes;
        self.snapshot.appendLocked(row);
    }
    self.snapshot.finishPublish();
    // Membership refs transfer non-fallibly; only pointer storage retires.
    reservation.snapshot_rows.count = 0;
    reservation.snapshot_rows.deinit();
    const a = lane.owner.allocator;
    a.free(reservation.storage);
    self.committed_relay_id = id;
    self.relay_reservation = null;
}

fn abortRelay(self: *Control, id: u64) void {
    const reservation = if (self.relay_reservation) |*value| value else return;
    if (reservation.id != id) return;
    const a = self.hub.allocator;
    reservation.deinit(a);
    self.relay_reservation = null;
}

fn overwriteNonce(lane: anytype, desired: ?u64) !void {
    if (lane.chain.protocol != .ethereum) return error.UnsupportedNonceChain;
    const service = if (lane.transactions) |*value| value else return error.LanderNotReady;
    try service.nonces.overwriteUpper(lane.owner.allocator, if (desired) |value| @as(u256, value) else null);
    service.nonces.scan_resume = null;
    service.scan_cursor = try service.store.highestTransactionIndex(lane.owner.allocator);
    service.queued_transactions = 0;
    service.recovery_complete = false;
    service.recovery_blocked = false;
}

fn validEnvironmentText(text: []const u8, name: bool) !void {
    if (std.mem.indexOfScalar(u8, text, 0) != null or (name and (text.len == 0 or std.mem.indexOfScalar(u8, text, '=') != null))) return error.InvalidEnvironmentVariable;
}
extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern "c" fn unsetenv(name: [*:0]const u8) c_int;

fn environmentGet(a: A, name: []const u8) !api.EnvironmentValue {
    try validEnvironmentText(name, true);
    const terminated = try a.dupeZ(u8, name);
    defer a.free(terminated);
    const value = std.c.getenv(terminated.ptr) orelse return .absent;
    return .{ .value = try a.dupe(u8, std.mem.span(value)) };
}

fn environmentSet(a: A, name: []const u8, value: ?[]const u8) !api.EnvironmentValue {
    try validEnvironmentText(name, true);
    if (value) |text| try validEnvironmentText(text, false);
    const terminated_name = try a.dupeZ(u8, name);
    defer a.free(terminated_name);
    if (value) |text| {
        const terminated_value = try a.dupeZ(u8, text);
        defer a.free(terminated_value);
        if (setenv(terminated_name.ptr, terminated_value.ptr, 1) != 0) return error.EnvironmentVariableSetFailed;
        return .{ .value = try a.dupe(u8, text) };
    }
    if (unsetenv(terminated_name.ptr) != 0) return error.EnvironmentVariableUnsetFailed;
    return .absent;
}

pub const Hub = struct {
    allocator: A,
    settings: *const settings.Settings,
    environment: *const std.process.EnvMap,
    origins: *origins.Set,
    signers: *signer_tasks.Owner,
    regex_engine: ?*regex.Engine,
    denylist: *runtime_denylist.RuntimeDenylist,
    gateway_policy: relay_policy.Policy,
    controls: std.ArrayList(*Control) = .empty,
    command_timeout_ms: u64 = command_timeout_ms,
    closed: bool = false,

    pub fn init(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, origin_set: *origins.Set, signer_owner: *signer_tasks.Owner, regex_engine: ?*regex.Engine, denylist: *runtime_denylist.RuntimeDenylist) !Hub {
        if (configured.role != .relayer) return error.InvalidRelayerControl;
        return .{
            .allocator = a,
            .settings = configured,
            .environment = environment,
            .origins = origin_set,
            .signers = signer_owner,
            .regex_engine = regex_engine,
            .denylist = denylist,
            .gateway_policy = try relay_policy.Policy.init(a, .fromSettings(configured.role.relayer), regex_engine, denylist),
        };
    }

    pub fn deinit(self: *Hub) void {
        std.debug.assert(self.controls.items.len == 0);
        self.controls.deinit(self.allocator);
        self.gateway_policy.deinit();
        self.closed = true;
    }

    fn find(self: *Hub, domain: u32) ?*Control {
        for (self.controls.items) |control| if (control.chain.domain == domain) return control;
        return null;
    }

    fn call(self: *Hub, control: *Control, request: Request, cancel: Cancel) !Response {
        return self.callTimeout(control, request, self.command_timeout_ms, cancel);
    }

    fn callTimeout(self: *Hub, control: *Control, request: Request, timeout_ms: u64, cancel: Cancel) !Response {
        const owned = try cloneRequest(self.allocator, request);
        return control.queue.call(owned, timeout_ms, cancel);
    }

    pub fn relayControl(self: *Hub, domain: u32) ?*Control {
        return self.find(domain);
    }

    pub fn relayReserve(self: *Hub, control: *Control, id: u64, transaction: [64]u8, messages: []const protocol.Message, timeout_ms: u64, cancel: Cancel) !void {
        var response = try self.callTimeout(control, .{ .relay_reserve = .{ .id = id, .transaction = transaction, .messages = @constCast(messages) } }, timeout_ms, cancel);
        dropResponse(self.allocator, &response);
    }

    pub fn relayAuthorize(self: *Hub, control: *Control, id: u64, timeout_ms: u64, cancel: Cancel) !void {
        var response = try self.callTimeout(control, .{ .relay_authorize = id }, timeout_ms, cancel);
        dropResponse(self.allocator, &response);
    }

    pub fn relayCommit(self: *Hub, control: *Control, id: u64, timeout_ms: u64, cancel: Cancel) !void {
        var response = try self.callTimeout(control, .{ .relay_commit = id }, timeout_ms, cancel);
        dropResponse(self.allocator, &response);
    }

    pub fn relayAbort(self: *Hub, control: *Control, id: u64, timeout_ms: u64, cancel: Cancel) !void {
        var response = try self.callTimeout(control, .{ .relay_abort = id }, timeout_ms, cancel);
        dropResponse(self.allocator, &response);
    }

    pub fn queueOwner(self: *Hub) api.QueueOwner {
        return .{ .context = self, .render_fn = queueRender };
    }
    pub fn retryOwner(self: *Hub) api.RetryOwner {
        return .{ .context = self, .retry_fn = retryBroadcast };
    }
    pub fn cachedSigners(self: *Hub) api.CachedSigners {
        return .{ .context = self, .lookup_fn = cachedSignerLookup };
    }
    pub fn reprocessOwner(self: *Hub) api.ReprocessOwner {
        return .{ .context = self, .enqueue_fn = reprocessEnqueue };
    }
    pub fn gasOwner(self: *Hub) api.GasOwner {
        return .{ .context = self, .add_fn = gasAdd, .list_fn = gasList, .remove_fn = gasRemove };
    }
    pub fn nonceOwner(self: *Hub) api.NonceOwner {
        return .{ .context = self, .contains_fn = nonceContains, .overwrite_fn = nonceOverwrite };
    }
    pub fn environmentOwner(self: *Hub) api.EnvironmentOwner {
        return .{ .context = self, .get_fn = environmentGetCallback, .set_fn = environmentSetCallback };
    }
};

fn queueRender(context: *anyopaque, a: A, domain: u32, cancel: Cancel) anyerror!http.Response {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = self.find(domain) orelse {
        // Tiny fixed-format u32 response keeps its original request allocator.
        // Do not inspect a View that an owner may still be binding/activating.
        const body = try std.fmt.allocPrint(a, "No queue found for domain {d}", .{domain});
        defer a.free(body);
        return http.Response.init(a, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
    };
    var rows = try control.snapshot.capture(cancel);
    defer rows.deinit();
    const allocator = control.snapshot.renderAllocator();
    const body = try renderSnapshot(allocator, rows.items(), cancel);
    defer allocator.free(body);
    var response = try http.Response.init(allocator, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
    errdefer response.deinit();
    if (cancel.load(.acquire)) return error.RequestCancelled;
    if (!control.snapshot.current(rows.generation)) return error.QueueViewChanged;
    return response;
}

fn retryBroadcast(context: *anyopaque, _: A, uuid: []const u8, pattern: settings.MatchingList, cancel: Cancel) anyerror!api.RetryResult {
    const self: *Hub = @ptrCast(@alignCast(context));
    var aggregate: api.RetryResult = .{};
    for (self.controls.items) |control| {
        var response = try self.call(control, .{ .retry = .{ .uuid = @constCast(uuid), .pattern = pattern } }, cancel);
        defer dropResponse(self.allocator, &response);
        aggregate.evaluated +|= response.retry.evaluated;
        aggregate.matched +|= response.retry.matched;
        aggregate.failed +|= response.retry.failed;
    }
    return aggregate;
}

fn cachedSignerLookup(context: *anyopaque, a: A, id: [32]u8, cancel: Cancel) anyerror![]const [32]u8 {
    const self: *Hub = @ptrCast(@alignCast(context));
    if (cancel.load(.acquire)) return error.RequestCancelled;
    var snapshot = self.signers.cache.cached(id) orelse return &.{};
    defer snapshot.deinit();
    return a.dupe([32]u8, snapshot.signers());
}

fn reprocessEnqueue(context: *anyopaque, a: A, message: protocol.Message, cancel: Cancel) anyerror![]u8 {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = self.find(message.destination) orelse return error.QueueNotFound;
    var response = try self.call(control, .{ .reprocess = message }, cancel);
    defer dropResponse(self.allocator, &response);
    return a.dupe(u8, response.reprocess);
}

fn gasAdd(context: *anyopaque, _: A, rule: api.GasRule, cancel: Cancel) anyerror!void {
    const self: *Hub = @ptrCast(@alignCast(context));
    for (self.controls.items) |control| {
        var response = try self.call(control, .{ .gas_add = .{ .policy = rule.policy, .matching_list = rule.matching_list } }, cancel);
        dropResponse(self.allocator, &response);
    }
}

fn gasList(context: *anyopaque, a: A, cancel: Cancel) anyerror![]api.GasDomainRules {
    const self: *Hub = @ptrCast(@alignCast(context));
    const result = try a.alloc(api.GasDomainRules, self.controls.items.len);
    for (self.controls.items, result) |control, *domain| {
        var response = try self.call(control, .gas_list, cancel);
        defer dropResponse(self.allocator, &response);
        const rules = try a.alloc(api.GasRule, response.gas_rules.rules.len);
        for (response.gas_rules.rules, rules) |source, *destination| destination.* = .{ .policy = source.policy, .matching_list = try cloneMatching(a, source.matching_list) };
        domain.* = .{ .domain = response.gas_rules.domain, .rules = rules };
    }
    return result;
}

fn gasRemove(context: *anyopaque, index: usize, cancel: Cancel) anyerror!void {
    const self: *Hub = @ptrCast(@alignCast(context));
    for (self.controls.items) |control| {
        var response = try self.call(control, .{ .gas_remove = index }, cancel);
        dropResponse(self.allocator, &response);
    }
}

fn nonceContains(context: *anyopaque, domain: u32) bool {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = self.find(domain) orelse return false;
    return control.chain.protocol == .ethereum;
}

fn nonceOverwrite(context: *anyopaque, domain: u32, nonce: ?u64, cancel: Cancel) anyerror!void {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = self.find(domain) orelse return error.UnknownDomain;
    if (control.chain.protocol != .ethereum) return error.UnsupportedNonceChain;
    var response = try self.call(control, .{ .nonce_overwrite = nonce }, cancel);
    dropResponse(self.allocator, &response);
}

fn environmentGetCallback(context: *anyopaque, a: A, name: []const u8, cancel: Cancel) anyerror!api.EnvironmentValue {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = if (self.controls.items.len > 0) self.controls.items[0] else return error.ControlUnavailable;
    var response = try self.call(control, .{ .environment_get = @constCast(name) }, cancel);
    defer dropResponse(self.allocator, &response);
    return switch (response.environment) {
        .absent => .absent,
        .value => |text| .{ .value = try a.dupe(u8, text) },
    };
}

fn environmentSetCallback(context: *anyopaque, a: A, name: []const u8, value: ?[]const u8, cancel: Cancel) anyerror!api.EnvironmentValue {
    const self: *Hub = @ptrCast(@alignCast(context));
    const control = if (self.controls.items.len > 0) self.controls.items[0] else return error.ControlUnavailable;
    var response = try self.call(control, .{ .environment_set = .{ .name = @constCast(name), .value = if (value) |text| @constCast(text) else null } }, cancel);
    defer dropResponse(self.allocator, &response);
    return switch (response.environment) {
        .absent => .absent,
        .value => |text| .{ .value = try a.dupe(u8, text) },
    };
}
