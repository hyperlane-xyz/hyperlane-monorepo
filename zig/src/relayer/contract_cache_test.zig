const std = @import("std");
const cache_module = @import("contract_cache.zig");
const protocol = @import("../protocol/root.zig");
const metadata = @import("metadata.zig");
const ccip = @import("ccip.zig");
const settings = @import("../settings/types.zig");
const A = std.mem.Allocator;
const Address = [20]u8;
const Hash = [32]u8;

fn context(domain: []const u8, marker: u8) cache_module.Context {
    return .{ .domain_name = domain, .context_hash = @splat(marker) };
}

fn message(nonce: u32) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = nonce % 3, .destination = 2000, .sender = @splat(1), .recipient = @splat(2), .body = &.{@truncate(nonce)} };
}

fn options() cache_module.Options {
    return .{ .max_entries = 8, .max_bytes = 1024 * 1024 };
}

fn put(cache: *cache_module.Cache, query: cache_module.Query, value: cache_module.Value) !void {
    try std.testing.expect(try cache.put(context("ethereum", 1), query, &value, 1000));
}

fn word(out: *std.ArrayList(u8), allocator: A, value: usize) !void {
    var bytes: [32]u8 = @splat(0);
    std.mem.writeInt(u256, &bytes, value, .big);
    try out.appendSlice(allocator, &bytes);
}

fn lookup(allocator: A) !ccip.Lookup {
    var encoded: std.ArrayList(u8) = .empty;
    defer encoded.deinit(allocator);
    try encoded.appendSlice(allocator, &ccip_selector());
    var sender: [32]u8 = @splat(0);
    sender[31] = 0x33;
    try encoded.appendSlice(allocator, &sender);
    try word(&encoded, allocator, 160);
    try word(&encoded, allocator, 288);
    try encoded.appendSlice(allocator, &.{ 1, 2, 3, 4 });
    try encoded.appendSlice(allocator, &([_]u8{0} ** 28));
    try word(&encoded, allocator, 352);
    try word(&encoded, allocator, 1);
    try word(&encoded, allocator, 32);
    try word(&encoded, allocator, 3);
    try encoded.appendSlice(allocator, "foo");
    try encoded.appendSlice(allocator, &([_]u8{0} ** 29));
    try word(&encoded, allocator, 2);
    try encoded.appendSlice(allocator, &.{ 0xab, 0xcd });
    try encoded.appendSlice(allocator, &([_]u8{0} ** 30));
    try word(&encoded, allocator, 1);
    try encoded.append(allocator, 0x55);
    try encoded.appendSlice(allocator, &([_]u8{0} ** 31));
    return ccip.decode(allocator, encoded.items);
}

fn ccip_selector() [4]u8 {
    return @import("../evm/codecs.zig").selector("OffchainLookup(address,string[],bytes,bytes4,bytes)");
}

fn freeValue(allocator: A, value: *cache_module.Value) void {
    value.deinit(allocator);
}

test "Rust moduleType and route keys preserve origin message domain and context isolation" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, options());
    defer cache.deinit();
    const ism: Address = @splat(0x11);
    try put(&cache, .moduleType(ism), .{ .module_type = .routing });
    try std.testing.expectEqual(metadata.ModuleType.routing, (try cache.get(context("ethereum", 1), .moduleType(ism), 1000)).?.module_type);
    const msg = message(4);
    const route_address: Address = @splat(42);
    try put(&cache, .route(ism, msg, .ism_specific), .{ .address = route_address });
    try std.testing.expectEqual(route_address, (try cache.get(context("ethereum", 1), .route(ism, msg, .ism_specific), 1000)).?.address);
    var other_origin = msg;
    other_origin.origin += 1;
    try std.testing.expect((try cache.get(context("ethereum", 1), .route(ism, other_origin, .ism_specific), 1000)) == null);
    try put(&cache, .route(ism, msg, .message_specific), .{ .address = route_address });
    try std.testing.expect((try cache.get(context("ethereum", 1), .route(ism, other_origin, .message_specific), 1000)) == null);
    try std.testing.expect((try cache.get(context("arbitrum", 1), .route(ism, msg, .ism_specific), 1000)) == null);
    try std.testing.expect((try cache.get(context("ethereum", 2), .route(ism, msg, .ism_specific), 1000)) == null);
    try std.testing.expect((try cache.get(context("ethereum", 1), .moduleType(@splat(0x12)), 1000)) == null);
}

test "Rust members recipient and CCIP keys preserve function recipient and message isolation" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, options());
    defer cache.deinit();
    const ism: Address = @splat(0x22);
    const msg = message(7);
    const addresses = try a.dupe(Address, &.{ @splat(1), @splat(2) });
    var members: cache_module.Value = .{ .members = .{ .addresses = addresses, .threshold = 1 } };
    defer members.deinit(a);
    try put(&cache, .members(ism, msg, false, .ism_specific), members);
    var changed = message(8);
    var hit = (try cache.get(context("ethereum", 1), .members(ism, changed, false, .ism_specific), 1000)).?;
    defer hit.deinit(a);
    try std.testing.expectEqual(@as(usize, 2), hit.members.addresses.len);
    try std.testing.expect(hit.members.addresses.ptr != members.members.addresses.ptr);
    try std.testing.expect((try cache.get(context("ethereum", 1), .members(ism, msg, true, .ism_specific), 1000)) == null);
    const recipient: Hash = @splat(0x44);
    try put(&cache, .recipientIsm(recipient), .{ .address = ism });
    var leading_changed = recipient;
    leading_changed[0] ^= 1;
    try std.testing.expect((try cache.get(context("ethereum", 1), .recipientIsm(leading_changed), 1000)) == null);
    var source_lookup = try lookup(a);
    defer source_lookup.deinit();
    const lookup_value: cache_module.Value = .{ .offchain_lookup = source_lookup };
    try put(&cache, .offchainLookup(ism, msg), lookup_value);
    var cached_lookup = (try cache.get(context("ethereum", 1), .offchainLookup(ism, msg), 1000)).?;
    defer cached_lookup.deinit(a);
    try std.testing.expect(cached_lookup.offchain_lookup.encoded.ptr != source_lookup.encoded.ptr);
    try std.testing.expectEqualStrings("foo", cached_lookup.offchain_lookup.urls[0]);
    try std.testing.expect((try cache.get(context("ethereum", 1), .offchainLookup(ism, changed), 1000)) == null);
    changed.nonce += 1;
}

test "malformed CCIP slices fail cloning without pointer overflow or leaks" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, options());
    defer cache.deinit();
    var source = try lookup(a);
    defer source.deinit();
    source.urls[0] = "foo";
    try std.testing.expectError(error.InvalidOffchainLookup, cache.put(context("ethereum", 1), .offchainLookup(@splat(0x22), message(7)), &.{ .offchain_lookup = source }, 1000));
    try std.testing.expectEqual(@as(usize, 0), cache.snapshot().entries);
}

test "generic TTL environment override and distinct default ISM TTL match source" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, .{ .max_entries = 4, .max_bytes = 4096, .default_ttl_ms = 50 });
    defer cache.deinit();
    const ism: Address = @splat(0x11);
    try put(&cache, .moduleType(ism), .{ .module_type = .null_ism });
    try std.testing.expect((try cache.get(context("ethereum", 1), .moduleType(ism), 1049)) != null);
    try std.testing.expect((try cache.get(context("ethereum", 1), .moduleType(ism), 1050)) == null);

    const Fetch = struct {
        calls: usize = 0,
        fn get(ctx: *anyopaque, _: u64) !Address {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return @splat(0x66);
        }
    };
    var fetch: Fetch = .{};
    const callback: cache_module.DefaultIsmFetch = .{ .context = &fetch, .get_fn = Fetch.get };
    _ = try cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 0);
    _ = try cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 599_999);
    try std.testing.expectEqual(@as(usize, 1), fetch.calls);
    _ = try cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 600_000);
    try std.testing.expectEqual(@as(usize, 2), fetch.calls);

    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put(cache_module.expiration_env, "17");
    var overridden = try cache_module.Cache.init(a, .{ .max_entries = 2, .max_bytes = 4096, .environment = &environment });
    defer overridden.deinit();
    try environment.put(cache_module.expiration_env, "99");
    try std.testing.expect(try overridden.put(context("ethereum", 1), .moduleType(ism), &.{ .module_type = .routing }, 0));
    try std.testing.expect((try overridden.get(context("ethereum", 1), .moduleType(ism), 16_999)) != null);
    try std.testing.expect((try overridden.get(context("ethereum", 1), .moduleType(ism), 17_000)) == null);
}

test "disabled oversized and LRU behavior stays bounded without caching failures" {
    const a = std.testing.allocator;
    var disabled = try cache_module.Cache.init(a, .{ .enabled = false, .max_entries = 2, .max_bytes = 100 });
    defer disabled.deinit();
    const ism: Address = @splat(0x11);
    try std.testing.expect(!(try disabled.put(context("ethereum", 1), .moduleType(ism), &.{ .module_type = .routing }, 0)));
    try std.testing.expect((try disabled.get(context("ethereum", 1), .moduleType(ism), 0)) == null);
    try std.testing.expectEqual(@as(usize, 0), disabled.snapshot().entries);

    var cache = try cache_module.Cache.init(a, .{ .max_entries = 2, .max_bytes = 300 });
    defer cache.deinit();
    const first: Address = @splat(1);
    const second: Address = @splat(2);
    const third: Address = @splat(3);
    try std.testing.expect(try cache.put(context("ethereum", 1), .moduleType(first), &.{ .module_type = .routing }, 0));
    try std.testing.expect(try cache.put(context("ethereum", 1), .moduleType(second), &.{ .module_type = .null_ism }, 0));
    _ = try cache.get(context("ethereum", 1), .moduleType(first), 1);
    try std.testing.expect(try cache.put(context("ethereum", 1), .moduleType(third), &.{ .module_type = .aggregation }, 1));
    try std.testing.expect((try cache.get(context("ethereum", 1), .moduleType(second), 1)) == null);
    try std.testing.expect(cache.snapshot().bytes <= 300);
    try std.testing.expectEqual(@as(usize, 1), cache.snapshot().evictions);

    var small = try cache_module.Cache.init(a, .{ .max_entries = 2, .max_bytes = 20 });
    defer small.deinit();
    try std.testing.expect(!(try small.put(context("ethereum", 1), .moduleType(ism), &.{ .module_type = .routing }, 0)));
    try std.testing.expectEqual(@as(usize, 1), small.snapshot().rejected);
    try std.testing.expect((try small.get(context("ethereum", 1), .moduleType(ism), 0)) == null);
}

test "growing replacement evicts other entries and preserves aggregate byte bound" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, .{ .max_entries = 3, .max_bytes = 230 });
    defer cache.deinit();
    const ism: Address = @splat(0x11);
    const msg = message(2);
    const small_addresses = try a.dupe(Address, &.{@splat(1)});
    var small_members: cache_module.Value = .{ .members = .{ .addresses = small_addresses, .threshold = 1 } };
    defer small_members.deinit(a);
    const large_addresses = try a.dupe(Address, &.{ @splat(1), @splat(2), @splat(3) });
    var large_members: cache_module.Value = .{ .members = .{ .addresses = large_addresses, .threshold = 2 } };
    defer large_members.deinit(a);
    try std.testing.expect(try cache.put(context("ethereum", 1), .members(ism, msg, false, .ism_specific), &small_members, 0));
    const other: Address = @splat(0x22);
    try std.testing.expect(try cache.put(context("ethereum", 1), .moduleType(other), &.{ .module_type = .routing }, 0));
    try std.testing.expect(try cache.put(context("ethereum", 1), .members(ism, msg, false, .ism_specific), &large_members, 1));
    try std.testing.expect((try cache.get(context("ethereum", 1), .moduleType(other), 1)) == null);
    var retained = (try cache.get(context("ethereum", 1), .members(ism, msg, false, .ism_specific), 1)).?;
    defer retained.deinit(a);
    try std.testing.expectEqual(@as(usize, 3), retained.members.addresses.len);
    const stats = cache.snapshot();
    try std.testing.expect(stats.bytes <= 230);
    try std.testing.expectEqual(@as(usize, 1), stats.evictions);
    try std.testing.expectEqual(@as(usize, 1), stats.entries);
}

fn configs() [3]settings.IsmCache {
    return .{
        .{ .selector = .{ .app_context = "foo" }, .module_types = &.{2}, .chains = &.{"foochain"}, .cache_policy = .ism_specific },
        .{ .selector = .default_ism, .module_types = &.{1}, .chains = &.{"foochain"}, .cache_policy = .ism_specific },
        .{ .selector = .default_ism, .module_types = &.{ 1, 2 }, .chains = &.{"nomatch"}, .cache_policy = .ism_specific },
    };
}

const ClassifierFetch = struct {
    value: Address = @splat(0x55),
    failure: ?anyerror = null,
    calls: usize = 0,
    fn get(ctx: *anyopaque, _: u64) !Address {
        const self: *ClassifierFetch = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (self.failure) |failure| return failure;
        return self.value;
    }
};

test "classifier preserves first match app context module chain and failure controls" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, options());
    defer cache.deinit();
    const configured = configs();
    var fetch: ClassifierFetch = .{};
    var classifier: cache_module.Classifier = .{ .cache = &cache, .context = context("foochain", 1), .default_ism = .{ .context = &fetch, .get_fn = ClassifierFetch.get }, .configs = &configured };
    const default_address: Address = @splat(0x55);
    try std.testing.expectEqual(cache_module.CachePolicy.ism_specific, try classifier.classify(@splat(0x66), "foochain", .aggregation, "foo", 0));
    try std.testing.expectEqual(cache_module.CachePolicy.ism_specific, try classifier.classify(default_address, "foochain", .routing, null, 0));
    try std.testing.expectEqual(cache_module.CachePolicy.message_specific, try classifier.classify(default_address, "foochain", .null_ism, null, 0));
    try std.testing.expectEqual(cache_module.CachePolicy.message_specific, try classifier.classify(default_address, "otherchain", .routing, null, 0));

    fetch.failure = error.RpcError;
    classifier.context = context("foochain", 2);
    try std.testing.expectEqual(cache_module.CachePolicy.message_specific, try classifier.classify(default_address, "foochain", .routing, null, 0));
    fetch.failure = error.ValidatorReorg;
    classifier.context = context("foochain", 3);
    try std.testing.expectError(error.ValidatorReorg, classifier.classify(default_address, "foochain", .routing, null, 0));
}

test "default ISM fetch errors are not cached and control errors propagate" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, options());
    defer cache.deinit();
    var fetch: ClassifierFetch = .{ .failure = error.RpcError };
    const callback: cache_module.DefaultIsmFetch = .{ .context = &fetch, .get_fn = ClassifierFetch.get };
    try std.testing.expectError(error.RpcError, cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 0));
    try std.testing.expectEqual(@as(usize, 0), cache.snapshot().entries);
    fetch.failure = null;
    _ = try cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 0);
    try std.testing.expectEqual(@as(usize, 2), fetch.calls);
    fetch.failure = error.RequestCancelled;
    try std.testing.expectError(error.RequestCancelled, cache_module.defaultIsm(&cache, context("ethereum", 2), callback, 0));
}

fn allocationSweep(a: A) !void {
    var cache = try cache_module.Cache.init(a, .{ .max_entries = 4, .max_bytes = 4096 });
    defer cache.deinit();
    const ism: Address = @splat(0x11);
    const msg = message(9);
    try std.testing.expect(try cache.put(context("ethereum", 1), .moduleType(ism), &.{ .module_type = .routing }, 0));
    var module_hit = (try cache.get(context("ethereum", 1), .moduleType(ism), 0)).?;
    defer module_hit.deinit(a);
    const addresses = try a.dupe(Address, &.{@splat(1)});
    var members: cache_module.Value = .{ .members = .{ .addresses = addresses, .threshold = 1 } };
    defer members.deinit(a);
    try std.testing.expect(try cache.put(context("ethereum", 1), .members(ism, msg, false, .message_specific), &members, 0));
    var members_hit = (try cache.get(context("ethereum", 1), .members(ism, msg, false, .message_specific), 0)).?;
    defer members_hit.deinit(a);
    var source = try lookup(a);
    defer source.deinit();
    try std.testing.expect(try cache.put(context("ethereum", 1), .offchainLookup(ism, msg), &.{ .offchain_lookup = source }, 0));
    var lookup_hit = (try cache.get(context("ethereum", 1), .offchainLookup(ism, msg), 0)).?;
    defer lookup_hit.deinit(a);
    var fetch: ClassifierFetch = .{};
    const callback: cache_module.DefaultIsmFetch = .{ .context = &fetch, .get_fn = ClassifierFetch.get };
    _ = try cache_module.defaultIsm(&cache, context("ethereum", 1), callback, 0);
    const configured = configs();
    const classifier: cache_module.Classifier = .{ .cache = &cache, .context = context("foochain", 1), .default_ism = callback, .configs = &configured };
    _ = try classifier.classify(@splat(0x66), "foochain", .aggregation, "foo", 0);
}

test "cache and classifier clean every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

const ParallelWorker = struct {
    cache: *cache_module.Cache,
    marker: u8,
    failure: ?anyerror = null,
    fn run(self: *ParallelWorker) void {
        for (0..80) |index| {
            const ism: Address = @splat(self.marker);
            _ = self.cache.put(context("ethereum", self.marker), .moduleType(ism), &.{ .module_type = .routing }, index) catch |err| {
                self.failure = err;
                return;
            };
            const value = self.cache.get(context("ethereum", self.marker), .moduleType(ism), index) catch |err| {
                self.failure = err;
                return;
            };
            if (value) |owned| {
                var mutable = owned;
                mutable.deinit(self.cache.allocator);
            }
        }
    }
};

test "parallel workers retire values within global count and byte bounds" {
    const a = std.testing.allocator;
    var cache = try cache_module.Cache.init(a, .{ .max_entries = 4, .max_bytes = 512 });
    defer cache.deinit();
    var workers = [_]ParallelWorker{
        .{ .cache = &cache, .marker = 1 },
        .{ .cache = &cache, .marker = 2 },
        .{ .cache = &cache, .marker = 3 },
        .{ .cache = &cache, .marker = 4 },
    };
    var threads: [4]std.Thread = undefined;
    for (&workers, &threads) |*worker, *thread| thread.* = try std.Thread.spawn(.{}, ParallelWorker.run, .{worker});
    for (threads) |thread| thread.join();
    for (workers) |worker| if (worker.failure) |failure| return failure;
    try std.testing.expect(cache.snapshot().entries <= 4);
    try std.testing.expect(cache.snapshot().bytes <= 512);
}
