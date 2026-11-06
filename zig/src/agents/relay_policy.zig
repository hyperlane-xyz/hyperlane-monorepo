//! Resolved relayer policy gates shared by loading and final submission.
//! Denials retain canonical messages; callers reconsider them after policy
//! changes. First matching gas policy wins, including an empty catch-all list.
const std = @import("std");
const settings = @import("../settings/types.zig");
const protocol = @import("../protocol/root.zig");
const matching = @import("../ops/matching.zig");
const blacklist = @import("../ops/address_blacklist.zig");
const regex = @import("../ops/regex.zig");
const denylist = @import("../ops/runtime_denylist.zig");
const gas = @import("../relayer/policies.zig");
const A = std.mem.Allocator;
const GasRule = struct { matcher: matching.Matcher, policy: gas.Policy };
const Context = struct { matcher: matching.Matcher, name: []const u8 };
pub const Denial = enum { not_whitelisted, message_blacklisted, address_blacklisted, runtime_denylisted };
pub const Config = struct {
    whitelist: settings.MatchingList = &.{},
    blacklist: settings.MatchingList = &.{},
    address_blacklist: []const []const u8 = &.{},
    gas_payment_enforcement: []const settings.GasEnforcement = &.{},
    metric_app_contexts: []const settings.MetricContext = &.{},
    pub fn fromSettings(value: settings.Relayer) Config {
        return .{ .whitelist = value.whitelist, .blacklist = value.blacklist, .address_blacklist = value.address_blacklist, .gas_payment_enforcement = value.gas_payment_enforcement, .metric_app_contexts = value.metric_app_contexts };
    }
};
pub const Decision = struct {
    allocator: A,
    denial: ?Denial = null,
    reason: ?[]u8 = null,
    pub fn deinit(self: *Decision) void {
        if (self.reason) |value| self.allocator.free(value);
        self.* = undefined;
    }
};
pub const Policy = struct {
    allocator: A,
    whitelist: matching.HotMatcher,
    blacklist: matching.HotMatcher,
    addresses: blacklist.AddressBlacklist,
    gas_rules: []GasRule,
    contexts: []Context,
    runtime: ?*denylist.RuntimeDenylist,
    /// Shared administrative matching policy. Gas rules remain origin-owned.
    gateway: ?*Policy = null,

    pub fn init(a: A, configured: Config, engine: ?*regex.Engine, runtime: ?*denylist.RuntimeDenylist) !Policy {
        var whitelist = try matching.HotMatcher.init(a, configured.whitelist, engine);
        errdefer whitelist.deinit();
        var blacklist_ = try matching.HotMatcher.init(a, configured.blacklist, engine);
        errdefer blacklist_.deinit();
        var addresses = try blacklist.AddressBlacklist.init(a, configured.address_blacklist);
        errdefer addresses.deinit();
        const rules = try a.alloc(GasRule, configured.gas_payment_enforcement.len);
        var initialized: usize = 0;
        errdefer {
            for (rules[0..initialized]) |*rule| rule.matcher.deinit();
            a.free(rules);
        }
        for (configured.gas_payment_enforcement, rules) |source, *rule| {
            rule.* = .{ .matcher = try matching.Matcher.init(a, source.matching_list, engine), .policy = switch (source.policy) {
                .none => .none,
                .minimum => |minimum| .{ .minimum = minimum },
                .on_chain_fee_quoting => |fraction| .{ .on_chain_fee_quoting = .{ .numerator = fraction.numerator, .denominator = fraction.denominator } },
            } };
            initialized += 1;
        }
        const contexts = try a.alloc(Context, configured.metric_app_contexts.len);
        var context_count: usize = 0;
        errdefer {
            for (contexts[0..context_count]) |*context| {
                context.matcher.deinit();
                a.free(context.name);
            }
            a.free(contexts);
        }
        for (configured.metric_app_contexts, contexts) |source, *context| {
            const name = try a.dupe(u8, source.name);
            errdefer a.free(name);
            context.* = .{ .name = name, .matcher = try matching.Matcher.init(a, source.matching_list, engine) };
            context_count += 1;
        }
        return .{ .allocator = a, .whitelist = whitelist, .blacklist = blacklist_, .addresses = addresses, .gas_rules = rules, .contexts = contexts, .runtime = runtime };
    }
    /// Stop/join all callers and release hot-matcher snapshots first.
    pub fn deinit(self: *Policy) void {
        self.whitelist.deinit();
        self.blacklist.deinit();
        self.addresses.deinit();
        for (self.gas_rules) |*rule| rule.matcher.deinit();
        for (self.contexts) |*context| {
            context.matcher.deinit();
            self.allocator.free(context.name);
        }
        self.allocator.free(self.gas_rules);
        self.allocator.free(self.contexts);
        self.* = undefined;
    }
    pub fn check(self: *Policy, message: protocol.Message) !Decision {
        if (self.gateway) |gateway| return gateway.check(message);
        var whitelist = self.whitelist.snapshot();
        defer whitelist.deinit();
        if (!try whitelist.matcher.messageMatches(message, true)) return .{ .allocator = self.allocator, .denial = .not_whitelisted };
        var blacklist_ = self.blacklist.snapshot();
        defer blacklist_.deinit();
        if (try blacklist_.matcher.messageMatches(message, false)) return .{ .allocator = self.allocator, .denial = .message_blacklisted };
        if (self.addresses.find(&message.sender, &message.recipient, message.body) != null) return .{ .allocator = self.allocator, .denial = .address_blacklisted };
        if (self.runtime) |runtime| if (try runtime.denyReasonForMessage(message)) |reason|
            return .{ .allocator = runtime.allocator, .denial = .runtime_denylisted, .reason = reason };
        return .{ .allocator = self.allocator };
    }
    /// Check actual origin transaction signers again immediately before submit;
    /// refreshes apply to already queued operations without another lookup.
    pub fn checkOriginSigners(self: *Policy, signers: []const [32]u8) !Decision {
        if (self.runtime) |runtime| {
            var snapshot = runtime.snapshot();
            defer snapshot.deinit();
            for (signers) |signer| for (snapshot.rules.addresses) |rule| if (std.mem.eql(u8, &signer, &rule.address))
                return .{ .allocator = self.allocator, .denial = .runtime_denylisted, .reason = try self.allocator.dupe(u8, rule.reason) };
        }
        return .{ .allocator = self.allocator };
    }
    pub fn evaluateGas(self: *const Policy, message: protocol.Message, payment: ?gas.Payment, spent: gas.Expenditure, estimate: gas.Estimate) !gas.Status {
        for (self.gas_rules) |*rule| if (try rule.matcher.messageMatches(message, true)) return rule.policy.evaluate(payment, spent, estimate);
        return .not_met;
    }
    /// Borrowed immutable name; valid until Policy.deinit.
    pub fn appContext(self: *const Policy, message: protocol.Message) !?[]const u8 {
        for (self.contexts) |*context| if (try context.matcher.messageMatches(message, false)) return context.name;
        return null;
    }
};

test "relayer policy preserves loader defaults first gas match and explicit context match" {
    const a = std.testing.allocator;
    var policy = try Policy.init(a, .{
        .gas_payment_enforcement = &.{
            .{ .matching_list = &.{.{ .origin_domain = .{ .values = &.{7} } }}, .policy = .{ .minimum = 10 } },
            .{ .matching_list = &.{}, .policy = .none },
        },
        .metric_app_contexts = &.{
            .{ .name = "empty", .matching_list = &.{} },
            .{ .name = "selected", .matching_list = &.{.{ .origin_domain = .{ .values = &.{7} } }} },
        },
    }, null, null);
    defer policy.deinit();
    var message: protocol.Message = .{ .origin = 7, .destination = 8, .sender = @splat(1), .recipient = @splat(2), .body = "payload" };
    var allowed = try policy.check(message);
    defer allowed.deinit();
    try std.testing.expect(allowed.denial == null);
    try std.testing.expectEqual(gas.Status.no_payment_found, try policy.evaluateGas(message, null, .{}, .{ .gas_limit = 100 }));
    try std.testing.expectEqual(gas.Status.not_met, try policy.evaluateGas(message, .{ .payment = 9, .gas_amount = 500 }, .{}, .{ .gas_limit = 100 }));
    try std.testing.expectEqual(gas.Status{ .met = 400 }, try policy.evaluateGas(message, .{ .payment = 10, .gas_amount = 500 }, .{ .gas_used = 100 }, .{ .gas_limit = 100 }));
    try std.testing.expectEqualStrings("selected", (try policy.appContext(message)).?);
    message.origin = 9;
    try std.testing.expectEqual(gas.Status{ .met = 100 }, try policy.evaluateGas(message, null, .{}, .{ .gas_limit = 100 }));
    try std.testing.expect((try policy.appContext(message)) == null);
    var closed = try Policy.init(a, .{}, null, null);
    defer closed.deinit();
    try std.testing.expectEqual(gas.Status.not_met, try closed.evaluateGas(message, null, .{}, .{ .gas_limit = 100 }));
}

test "relayer policy denies whitelist blacklist and address while hot snapshots can update" {
    const a = std.testing.allocator;
    var policy = try Policy.init(a, .{
        .whitelist = &.{.{ .origin_domain = .{ .values = &.{7} } }},
        .blacklist = &.{.{ .destination_domain = .{ .values = &.{9} } }},
        .address_blacklist = &.{"blocked"},
    }, null, null);
    defer policy.deinit();
    var message: protocol.Message = .{ .origin = 6, .destination = 9, .sender = @splat(1), .recipient = @splat(2), .body = "blocked" };
    var decision = try policy.check(message);
    try std.testing.expectEqual(Denial.not_whitelisted, decision.denial.?);
    decision.deinit();
    message.origin = 7;
    decision = try policy.check(message);
    try std.testing.expectEqual(Denial.message_blacklisted, decision.denial.?);
    decision.deinit();
    message.destination = 8;
    decision = try policy.check(message);
    try std.testing.expectEqual(Denial.address_blacklisted, decision.denial.?);
    decision.deinit();
    message.body = "allowed";
    decision = try policy.check(message);
    try std.testing.expect(decision.denial == null);
    decision.deinit();
    const next = try a.create(matching.Matcher);
    errdefer a.destroy(next);
    next.* = try matching.Matcher.init(a, &.{.{}}, null);
    errdefer next.deinit();
    try policy.blacklist.update(next);
    decision = try policy.check(message);
    defer decision.deinit();
    try std.testing.expectEqual(Denial.message_blacklisted, decision.denial.?);
}

fn allocationSweep(a: A) !void {
    var policy = try Policy.init(a, .{
        .whitelist = &.{.{}},
        .blacklist = &.{.{}},
        .address_blacklist = &.{ "one", "two" },
        .gas_payment_enforcement = &.{ .{ .matching_list = &.{.{}}, .policy = .none }, .{ .matching_list = &.{.{}}, .policy = .{ .minimum = 5 } } },
        .metric_app_contexts = &.{ .{ .name = "one", .matching_list = &.{.{}} }, .{ .name = "two", .matching_list = &.{.{}} } },
    }, null, null);
    defer policy.deinit();
}
test "relayer policy cleans partially constructed rule context and matcher ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

test "relayer queued signer gate applies new runtime address rules and owns denial reason across refresh" {
    const Feed = struct {
        body: []const u8,
        fn fetch(context: *anyopaque, a: A, _: []const u8, _: usize) !denylist.Fetched {
            const self: *@This() = @ptrCast(@alignCast(context));
            return .{ .allocator = a, .status = 200, .bytes = try a.dupe(u8, self.body) };
        }
        fn now(_: *anyopaque) i64 {
            return 0;
        }
    };
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const path = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(path);
    const cache = try std.fs.path.join(a, &.{ path, "denylist-cache" });
    defer a.free(cache);
    var feed: Feed = .{ .body = "{\"rules\":[{\"address\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\",\"reason\":\"blocked signer\",\"addedBy\":\"fixture\"}]}" };
    var runtime = try denylist.RuntimeDenylist.init(a, null);
    defer runtime.deinit();
    runtime.config = .{ .url = "https://example.test/feed", .cache_path = cache, .poll_interval_ms = 60000 };
    runtime.transport = .{ .context = &feed, .fetch = Feed.fetch };
    var policy = try Policy.init(a, .{}, null, &runtime);
    defer policy.deinit();
    const signers = [_][32]u8{@splat(0x11)};
    var before = try policy.checkOriginSigners(&signers);
    defer before.deinit();
    try std.testing.expect(before.denial == null);
    _ = try runtime.refresh(.{ .context = &feed, .now_unix = Feed.now });
    var blocked = try policy.checkOriginSigners(&signers);
    defer blocked.deinit();
    try std.testing.expectEqual(Denial.runtime_denylisted, blocked.denial.?);
    feed.body = "{\"rules\":[]}";
    _ = try runtime.refresh(.{ .context = &feed, .now_unix = Feed.now });
    try std.testing.expectEqualStrings("blocked signer (added by fixture)", blocked.reason.?);
    var after = try policy.checkOriginSigners(&signers);
    defer after.deinit();
    try std.testing.expect(after.denial == null);
}

test "lane gas policy observes shared administrative matching updates" {
    const a = std.testing.allocator;
    var gateway = try Policy.init(a, .{}, null, null);
    defer gateway.deinit();
    var lane = try Policy.init(a, .{ .whitelist = &.{.{ .origin_domain = .{ .values = &.{999} } }} }, null, null);
    defer lane.deinit();
    lane.gateway = &gateway;
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "" };
    var initial = try lane.check(message);
    defer initial.deinit();
    try std.testing.expect(initial.denial == null);
    {
        const changed = try a.create(matching.Matcher);
        errdefer a.destroy(changed);
        changed.* = try matching.Matcher.init(a, &.{.{ .origin_domain = .{ .values = &.{3} } }}, null);
        errdefer changed.deinit();
        try gateway.whitelist.update(changed);
    }
    var denied = try lane.check(message);
    defer denied.deinit();
    try std.testing.expectEqual(Denial.not_whitelisted, denied.denial.?);
}
