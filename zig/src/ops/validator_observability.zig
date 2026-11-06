//! Bounded validator latest-index observation. Source I/O never runs under the
//! manager lock; complete sets are written before stale absent members expire.
const std = @import("std");
const metrics = @import("metrics.zig");
const A = std.mem.Allocator;
pub const metric_name = "hyperlane_observed_validator_latest_index";
pub const ism_metric_name = "hyperlane_ism_build_count";
pub const mismatch_metric_name = "hyperlane_merkle_root_mismatch";
pub const grace_ms: u64 = 180000;
pub const Address = [20]u8;
pub const Observation = struct {
    context: *anyopaque,
    latest_fn: *const fn (*anyopaque, u32, u32, []const u8, []const Address, []const ?u32) anyerror!void,
    leaf_complete_fn: ?*const fn (*anyopaque, u32, u32, []const u8, []const u8, bool) anyerror!void = null,
    merkle_mismatch_fn: ?*const fn (*anyopaque, u32) anyerror!void = null,
};
pub const Resolver = struct {
    context: *anyopaque,
    name_fn: *const fn (*anyopaque, u32) anyerror![]const u8,
};
pub const Clock = struct {
    context: *anyopaque,
    now_ms_fn: *const fn (*anyopaque) u64,
};
const Context = struct {
    origin: []u8,
    destination: []u8,
    app_context: []u8,
    validators: std.AutoArrayHashMapUnmanaged(Address, u64) = .empty,
    fn deinit(self: *Context, allocator: A) void {
        self.validators.deinit(allocator);
        allocator.free(self.origin);
        allocator.free(self.destination);
        allocator.free(self.app_context);
    }
};
pub const Manager = struct {
    allocator: A,
    registry: *metrics.Registry,
    clock: Clock,
    contexts: std.ArrayList(Context) = .empty,
    max_contexts: usize = 256,
    max_validators: usize = 256,
    max_label_bytes: usize = 2 * 1024 * 1024,
    label_bytes: usize = 0,
    failures: std.atomic.Value(u64) = .init(0),
    reported_failure: std.atomic.Value(bool) = .init(false),
    mutex: std.Thread.Mutex = .{},

    pub fn init(allocator: A, registry: *metrics.Registry, clock: Clock) Manager {
        return .{ .allocator = allocator, .registry = registry, .clock = clock };
    }

    /// Join every observation writer before destroying the manager or registry.
    pub fn deinit(self: *Manager) void {
        for (self.contexts.items) |*context| context.deinit(self.allocator);
        self.contexts.deinit(self.allocator);
        self.* = undefined;
    }

    fn find(self: *Manager, origin: []const u8, destination: []const u8, app_context: []const u8) ?usize {
        for (self.contexts.items, 0..) |context, index| {
            if (std.mem.eql(u8, context.origin, origin) and std.mem.eql(u8, context.destination, destination) and std.mem.eql(u8, context.app_context, app_context)) return index;
        }
        return null;
    }

    fn createContext(self: *Manager, origin: []const u8, destination: []const u8, app_context: []const u8) !usize {
        if (self.contexts.items.len >= self.max_contexts) return error.ObservationContextLimit;
        const extra = origin.len + destination.len + app_context.len;
        if (extra > self.max_label_bytes -| self.label_bytes) return error.ObservationLabelLimit;
        const owned_origin = try self.allocator.dupe(u8, origin);
        errdefer self.allocator.free(owned_origin);
        const owned_destination = try self.allocator.dupe(u8, destination);
        errdefer self.allocator.free(owned_destination);
        const owned_context = try self.allocator.dupe(u8, app_context);
        errdefer self.allocator.free(owned_context);
        try self.contexts.append(self.allocator, .{ .origin = owned_origin, .destination = owned_destination, .app_context = owned_context });
        self.label_bytes += extra;
        return self.contexts.items.len - 1;
    }

    fn update(self: *Manager, origin: []const u8, destination: []const u8, app_context: []const u8, validator: Address, latest: ?u32) !void {
        const text = try @import("../evm/codecs.zig").hexAlloc(self.allocator, &validator);
        defer self.allocator.free(text);
        try self.registry.update(metric_name, &.{ origin, destination, text, app_context }, .{ .set_int = if (latest) |index| @intCast(index) else -1 });
    }

    fn remove(self: *Manager, origin: []const u8, destination: []const u8, app_context: []const u8, validator: Address) !void {
        const text = try @import("../evm/codecs.zig").hexAlloc(self.allocator, &validator);
        defer self.allocator.free(text);
        _ = try self.registry.remove(metric_name, &.{ origin, destination, text, app_context });
    }

    pub fn set(self: *Manager, origin: []const u8, destination: []const u8, app_context: []const u8, validators: []const Address, latest: []const ?u32) !void {
        if (validators.len != latest.len or validators.len > self.max_validators) return error.InvalidObservationSet;
        for (validators, 0..) |validator, index| for (validators[0..index]) |previous| {
            if (std.mem.eql(u8, &validator, &previous)) return error.DuplicateObservationValidator;
        };
        const now_ms = self.clock.now_ms_fn(self.clock.context);
        self.mutex.lock();
        defer self.mutex.unlock();
        const context_index = self.find(origin, destination, app_context) orelse try self.createContext(origin, destination, app_context);
        const context = &self.contexts.items[context_index];
        var next: std.AutoArrayHashMapUnmanaged(Address, u64) = .empty;
        errdefer next.deinit(self.allocator);
        var iterator = context.validators.iterator();
        while (iterator.next()) |entry| {
            if (now_ms -| entry.value_ptr.* < grace_ms) try next.put(self.allocator, entry.key_ptr.*, entry.value_ptr.*);
        }
        for (validators) |validator| try next.put(self.allocator, validator, now_ms);
        if (next.count() > self.max_validators) return error.ObservationValidatorLimit;
        for (validators, latest) |validator, index| try self.update(origin, destination, app_context, validator, index);
        iterator = context.validators.iterator();
        while (iterator.next()) |entry| {
            if (now_ms -| entry.value_ptr.* < grace_ms) continue;
            if (next.contains(entry.key_ptr.*)) continue;
            try self.remove(origin, destination, app_context, entry.key_ptr.*);
        }
        context.validators.deinit(self.allocator);
        context.validators = next;
    }
};

pub const Active = struct {
    manager: *Manager,
    resolver: Resolver,

    pub fn observation(self: *Active) Observation {
        return .{ .context = self, .latest_fn = observe, .leaf_complete_fn = leafComplete, .merkle_mismatch_fn = merkleMismatch };
    }

    fn leafComplete(context: *anyopaque, origin: u32, destination: u32, app_context: []const u8, ism_type: []const u8, success: bool) anyerror!void {
        const self: *Active = @ptrCast(@alignCast(context));
        const origin_name = self.resolver.name_fn(self.resolver.context, origin) catch {
            self.noteFailure();
            return;
        };
        const destination_name = self.resolver.name_fn(self.resolver.context, destination) catch {
            self.noteFailure();
            return;
        };
        self.registryFor(ism_metric_name).update(ism_metric_name, &.{ app_context, origin_name, destination_name, ism_type, if (success) "success" else "failure" }, .{ .add_int = 1 }) catch {
            self.noteFailure();
        };
    }

    fn merkleMismatch(context: *anyopaque, origin: u32) anyerror!void {
        const self: *Active = @ptrCast(@alignCast(context));
        const origin_name = self.resolver.name_fn(self.resolver.context, origin) catch {
            self.noteFailure();
            return;
        };
        self.registryFor(mismatch_metric_name).update(mismatch_metric_name, &.{origin_name}, .{ .set_int = 1 }) catch {
            self.noteFailure();
        };
    }

    fn registryFor(self: *Active, _: []const u8) *metrics.Registry {
        return self.manager.registry;
    }

    fn noteFailure(self: *Active) void {
        _ = self.manager.failures.fetchAdd(1, .acq_rel);
        if (!self.manager.reported_failure.swap(true, .acq_rel)) std.log.warn("validator observation metric update failed", .{});
    }

    fn observe(context: *anyopaque, origin: u32, destination: u32, app_context: []const u8, validators: []const Address, latest: []const ?u32) anyerror!void {
        const self: *Active = @ptrCast(@alignCast(context));
        const origin_name = self.resolver.name_fn(self.resolver.context, origin) catch {
            self.noteFailure();
            return;
        };
        const destination_name = self.resolver.name_fn(self.resolver.context, destination) catch {
            self.noteFailure();
            return;
        };
        self.manager.set(origin_name, destination_name, app_context, validators, latest) catch {
            self.noteFailure();
        };
    }
};

const TestClock = struct {
    value: u64 = 0,
    fn clock(self: *TestClock) Clock {
        return .{ .context = self, .now_ms_fn = now };
    }
    fn now(context: *anyopaque) u64 {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return self.value;
    }
};

fn render(registry: *metrics.Registry, a: A) ![]u8 {
    return registry.render(a);
}

test "production Registry publishes full set with missing indices and 180 second membership grace" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var clock: TestClock = .{};
    var manager = Manager.init(a, registry, clock.clock());
    defer manager.deinit();
    const first: Address = @splat(0xaa);
    const second: Address = @splat(0xbb);
    const third: Address = @splat(0xcc);
    try manager.set("origin", "destination", "app", &.{ first, second, third }, &.{ 7, null, 9 });
    const first_text = try render(registry, a);
    defer a.free(first_text);
    try std.testing.expect(std.mem.indexOf(u8, first_text, "0xaa") != null);
    try std.testing.expect(std.mem.indexOf(u8, first_text, "0xbb") != null);
    try std.testing.expect(std.mem.indexOf(u8, first_text, "0xcc") != null);
    try std.testing.expect(std.mem.indexOf(u8, first_text, "} -1\n") != null);
    clock.value = 179999;
    try manager.set("origin", "destination", "app", &.{second}, &.{11});
    clock.value = 180000;
    try manager.set("origin", "destination", "app", &.{third}, &.{12});
    const second_text = try render(registry, a);
    defer a.free(second_text);
    try std.testing.expect(std.mem.indexOf(u8, second_text, "0xaa") == null);
    try std.testing.expect(std.mem.indexOf(u8, second_text, "0xbb") != null);
    try std.testing.expect(std.mem.indexOf(u8, second_text, "0xcc") != null);
    try std.testing.expect(std.mem.indexOf(u8, second_text, "} 11\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, second_text, "} 12\n") != null);
    clock.value = 359999;
    try manager.set("origin", "destination", "app", &.{third}, &.{13});
    const third_text = try render(registry, a);
    defer a.free(third_text);
    try std.testing.expect(std.mem.indexOf(u8, third_text, "0xbb") == null);
    try std.testing.expect(std.mem.indexOf(u8, third_text, "0xcc") != null);
    try std.testing.expect(std.mem.indexOf(u8, third_text, "} 13\n") != null);
}

const ConcurrentSet = struct {
    manager: *Manager,
    validator: Address,
    failure: ?anyerror = null,
    fn run(self: *ConcurrentSet) void {
        self.manager.set("origin", "destination", "concurrent", &.{self.validator}, &.{4}) catch |err| {
            self.failure = err;
        };
    }
};

test "concurrent observation sets retain every validator and OOM does not remove existing series" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var clock: TestClock = .{};
    var manager = Manager.init(a, registry, clock.clock());
    defer manager.deinit();
    var workers: [4]ConcurrentSet = undefined;
    var threads: [4]std.Thread = undefined;
    var started: usize = 0;
    var joined = false;
    defer if (!joined) for (threads[0..started]) |thread| thread.join();
    for (&workers, &threads, 0..) |*worker, *thread, index| {
        worker.* = .{ .manager = &manager, .validator = @splat(@as(u8, @intCast(index + 1))) };
        thread.* = try std.Thread.spawn(.{}, ConcurrentSet.run, .{worker});
        started += 1;
    }
    for (&threads) |thread| thread.join();
    joined = true;
    for (&workers) |*worker| if (worker.failure) |err| return err;
    const text = try render(registry, a);
    defer a.free(text);
    for (1..5) |index| {
        const label = try @import("../evm/codecs.zig").hexAlloc(a, &workers[index - 1].validator);
        defer a.free(label);
        try std.testing.expect(std.mem.indexOf(u8, text, label) != null);
    }
}

fn allocationCase(a: A) !void {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var clock: TestClock = .{};
    var manager = Manager.init(a, registry, clock.clock());
    defer manager.deinit();
    const first: Address = @splat(0xaa);
    const second: Address = @splat(0xbb);
    try manager.set("origin", "destination", "app", &.{first}, &.{7});
    try manager.set("origin", "destination", "app", &.{ first, second }, &.{ 8, 9 });
    const text = try render(registry, a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "0xaa") != null);
}

test "observation allocation failures preserve existing production series" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCase, .{});
}

test "Active observation is best effort when metric storage is exhausted" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_series = 1, .max_render_bytes = 65536 });
    defer registry.deinit();
    var clock: TestClock = .{};
    var manager = Manager.init(a, registry, clock.clock());
    defer manager.deinit();
    var active: Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    const observation = active.observation();
    const validator: Address = @splat(0xaa);
    try observation.latest_fn(observation.context, 1, 2, "first", &.{validator}, &.{7});
    try observation.latest_fn(observation.context, 1, 2, "second", &.{validator}, &.{8});
    try std.testing.expectEqual(@as(u64, 1), manager.failures.load(.acquire));
    const text = try render(registry, a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "first") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "} 7\n") != null);
}

test "Active emits terminal ISM status and latches only real Merkle mismatch" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var clock: TestClock = .{};
    var manager = Manager.init(a, registry, clock.clock());
    defer manager.deinit();
    var active: Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    const observation = active.observation();
    try observation.leaf_complete_fn.?(observation.context, 1, 2, "app", "message_id_multisig", true);
    try observation.leaf_complete_fn.?(observation.context, 1, 2, "app", "ccip_read", false);
    try observation.merkle_mismatch_fn.?(observation.context, 1);
    try observation.merkle_mismatch_fn.?(observation.context, 1);
    const text = try render(registry, a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_ism_build_count") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "ism_type=\"message_id_multisig\",status=\"success\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "ism_type=\"ccip_read\",status=\"failure\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_merkle_root_mismatch{origin=\"origin\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "} 2\n") == null);
}
