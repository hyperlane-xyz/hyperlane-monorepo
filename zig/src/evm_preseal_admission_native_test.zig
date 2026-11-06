const std = @import("std");
const fixture = @import("agents/relayer/evm_driver_test.zig");
const driver = @import("agents/relayer/evm_driver.zig");
const protocol = @import("protocol/root.zig");
const provider = @import("evm/provider.zig");
const abi = @import("evm/codecs.zig");
const rules = @import("ops/runtime_denylist.zig");
const signers = @import("agents/origin_signers.zig");
const links = @import("agents/payload_links.zig");
const a = std.testing.allocator;

const Flip = struct {
    runtime: *fixture.Runtime,
    denylist: *rules.RuntimeDenylist,
    cache: *signers.Cache,
    document: []const u8,
    blocked_document: []const u8,
    enabled: bool = true,
    flips: usize = 0,
    checks: usize = 0,
    lookup_calls: usize = 0,
    fn fetchDocument(ctx: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: usize) !rules.Fetched {
        const self: *Flip = @ptrCast(@alignCast(ctx));
        return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.document) };
    }
    fn time(_: *anyopaque) i64 {
        return 1000;
    }
    fn refresh(self: *Flip, document: []const u8) !void {
        self.document = document;
        _ = try self.denylist.refresh(.{ .context = self, .now_unix = time });
    }
    fn exchange(ctx: *anyopaque, allocator: std.mem.Allocator, body: []const u8, options: provider.Options) !provider.WireResponse {
        const self: *Flip = @ptrCast(@alignCast(ctx));
        const original = self.runtime.rpc.exchange();
        const response = try original.fetch_fn(original.context, allocator, body, options);
        errdefer allocator.free(response.bytes);
        var request = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer request.deinit();
        if (self.enabled and std.mem.eql(u8, request.value.object.get("method").?.string, "eth_estimateGas")) {
            try self.refresh(self.blocked_document);
            self.flips += 1;
        }
        return response;
    }
    fn lookup(ctx: *anyopaque, allocator: std.mem.Allocator, _: protocol.Message, _: u64, _: ?*const std.atomic.Value(bool)) ![][32]u8 {
        const self: *Flip = @ptrCast(@alignCast(ctx));
        self.lookup_calls += 1;
        return allocator.dupe([32]u8, &.{@as([32]u8, @splat(45))});
    }
    fn allowed(ctx: *anyopaque, message: protocol.Message) !bool {
        const self: *Flip = @ptrCast(@alignCast(ctx));
        self.checks += 1;
        if (self.cache.cached(message.id())) |entry| {
            var snapshot = entry;
            defer snapshot.deinit();
            var decision = try self.runtime.policy.checkOriginSigners(snapshot.signers());
            defer decision.deinit();
            return decision.denial == null;
        }
        return true;
    }
    fn step(self: *Flip) !driver.Report {
        return self.runtime.value.step(a, &self.runtime.destination, &self.runtime.actor, &self.runtime.origin, &self.runtime.policy, self.runtime.fixture.message, &self.runtime.client, self.runtime.config(), .{ .unix_ms = 1000, .monotonic_ms = 0 }, .{
            .cancel = &self.runtime.cancel,
            .local_admission = .{ .context = self, .allowed_fn = allowed },
        });
    }
};
fn exercise(cached_signer: bool) !void {
    var disk = try fixture.Fixture.init(a);
    defer disk.deinit();
    const ready = fixture.readySteps();
    const steps = ready ++ ready;
    const runtime = try fixture.Runtime.init(a, &disk, &steps, fixture.allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    var denylist = try rules.RuntimeDenylist.init(a, null);
    defer denylist.deinit();
    runtime.policy.runtime = &denylist;
    var cache = try signers.Cache.init(a, 8, 4096);
    defer cache.deinit();
    const id = try abi.hexAlloc(a, &disk.message.id());
    defer a.free(id);
    const signer = try abi.hexAlloc(a, &@as([32]u8, @splat(45)));
    defer a.free(signer);
    const blocked = if (cached_signer)
        try std.json.Stringify.valueAlloc(a, .{ .rules = .{.{ .address = signer, .reason = "last estimate cached signer", .addedBy = "fixture" }} }, .{})
    else
        try std.json.Stringify.valueAlloc(a, .{ .rules = .{.{ .match = .{ .messageId = .{id} }, .reason = "last estimate message", .addedBy = "fixture" }} }, .{});
    defer a.free(blocked);
    const cache_path = try std.fs.path.join(a, &.{ disk.path, "runtime-rules.json" });
    defer a.free(cache_path);
    var flip: Flip = .{ .runtime = runtime, .denylist = &denylist, .cache = &cache, .document = "{\"rules\":[]}", .blocked_document = blocked };
    denylist.config = .{ .url = "https://fixture/rules", .poll_interval_ms = 1000, .cache_path = cache_path };
    denylist.transport = .{ .context = &flip, .fetch = Flip.fetchDocument };
    runtime.client.options.exchange = .{ .context = &flip, .fetch_fn = Flip.exchange };
    if (cached_signer) {
        var snapshot = (try cache.lookup(a, disk.message, true, false, .{ .context = &flip, .fetch_fn = Flip.lookup }, std.math.maxInt(u64), null)).?;
        snapshot.deinit();
    }
    const denied = try flip.step();
    try std.testing.expectEqual(driver.State.denied, denied.state);
    try std.testing.expectEqual(@as(usize, 1), flip.flips);
    try std.testing.expectEqual(@as(usize, ready.len), runtime.rpc.index);
    try std.testing.expect((try links.load(a, &runtime.store, disk.message.id(), @splat(8))) == null);
    const inherited = try links.inheritedUuids(a, &runtime.store, disk.message.id());
    defer a.free(inherited);
    try std.testing.expectEqual(@as(usize, 0), inherited.len);
    try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestPayloadIndex(a));
    try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestTransactionIndex(a));
    try std.testing.expectEqual(@as(usize, 0), runtime.signer.calls);
    try std.testing.expectEqual(@as(u256, 0), try runtime.destination.store.upperNonce(a, runtime.signer.address));
    try std.testing.expect(!try runtime.store.processed(disk.message.nonce));
    var pending = (try runtime.store.pendingAtOrAfter(disk.message.destination, disk.message.nonce)).?;
    defer pending.deinit();
    try std.testing.expectEqual(disk.message.id(), pending.value.id());

    flip.enabled = false;
    try flip.refresh("{\"rules\":[]}");
    const allowed = try flip.step();
    try std.testing.expectEqual(driver.State.prepared, allowed.state);
    const payload = allowed.payload.?;
    var sealed = (try links.load(a, &runtime.store, disk.message.id(), @splat(8))).?;
    defer sealed.deinit();
    try std.testing.expectEqual(payload, sealed.record().payload.uuid);
    try std.testing.expectEqual(@as(u32, 1), try runtime.destination.store.highestPayloadIndex(a));
    try std.testing.expectEqual(@as(usize, if (cached_signer) 1 else 0), flip.lookup_calls);
    try runtime.rpc.expectDone();

    // Already sealed ownership drains without a new admission callback, source
    // estimate, UUID or signing even if the same rule becomes active again.
    const checks = flip.checks;
    try flip.refresh(blocked);
    const recovered = try flip.step();
    try std.testing.expectEqual(driver.State.existing_payload, recovered.state);
    try std.testing.expectEqual(payload, recovered.payload.?);
    try std.testing.expectEqual(checks, flip.checks);
    try std.testing.expectEqual(@as(u32, 1), try runtime.destination.store.highestPayloadIndex(a));
    try std.testing.expectEqual(@as(usize, 0), runtime.signer.calls);
    try runtime.rpc.expectDone();
}
test "EVM preseal admission blocks a message rule installed by the actual gas estimate and reallow succeeds" {
    try exercise(false);
}
test "EVM preseal admission checks current rules for cached origin signers without a second lookup" {
    try exercise(true);
}
