//! True concurrent native multi polling of the actual per-VM checkpoint readers.
//! No blocking request workers and no per-chain pools. Concrete synchronous
//! codecs are replayed only within one bounded read-only generation.
const std = @import("std");
const source = @import("../chain_source.zig");
const reader = @import("chain_checkpoint.zig");
const replay = @import("replay.zig");
const multi = @import("../../net/curl_multi.zig");
const grpc = @import("../../cosmos/grpc.zig");
const objects = @import("../../storage/objects.zig");
const A = std.mem.Allocator;
pub const Slot = struct { resources: *source.Resources, reader: reader.Reader };
pub const Result = struct { value: ?reader.TreeAt = null, ready: bool = false, failure: ?anyerror = null };
pub const Config = struct { library_path: []const u8, period: objects.ReorgPeriod, timeout_ms: u32 = 20000, max_cache_bytes: usize = 128 * 1024 * 1024, max_requests_per_slot: usize = 64, cancel: ?*const std.atomic.Value(bool) = null };
/// Results own no resources; each frontier/height is copied. Endpoint resources
/// are borrowed exclusively, detached from replay before returning. Cancellation
/// closes all outstanding transfers before those resources can be reused.
pub fn collect(a: A, slots: []const Slot, config: Config, context: *anyopaque, ready: *const fn (*anyopaque, []const Result) bool) ![]Result {
    if (slots.len == 0 or slots.len > 256 or config.timeout_ms == 0) return error.InvalidCheckpointVoteRound;
    const n: u16 = @intCast(slots.len);
    var engine_config: multi.Config = .{ .library_path = config.library_path, .max_concurrent = n, .max_pending = n, .max_response_bytes = grpc.max_message_bytes + 5 };
    // Explicit full fanout reservation: the default64MiB would queue/fail large
    // endpoint sets before healthy peers even started. N and message caps bound
    // this worst case; actual cached response bytes have a separate global cap.
    engine_config.max_reserved_bytes = try std.math.mul(usize, slots.len, try engine_config.maxReservationPerRequest());
    const engine = try multi.Multi.init(a, engine_config);
    defer engine.deinit();
    const caches = try a.alloc(replay.Cache, slots.len);
    defer a.free(caches);
    var budget: replay.Budget = .{ .maximum = config.max_cache_bytes };
    var initialized: usize = 0;
    defer for (slots[0..initialized], caches[0..initialized]) |slot, *cache| {
        slot.resources.setReadOnlyOverride(null);
        slot.resources.setCancellation(null);
        cache.deinit();
    };
    for (slots, caches) |slot, *cache| {
        if (!slot.resources.options.direct_native_transport) return error.DirectReadTransportRequired;
        cache.* = try replay.Cache.init(a, engine, &budget, config.timeout_ms, .{ .max_requests = config.max_requests_per_slot, .recorder = slot.resources.rpc_metrics });
        slot.resources.setCancellation(config.cancel);
        slot.resources.setReadOnlyOverride(cache.override());
        initialized += 1;
    }
    const results = try a.alloc(Result, slots.len);
    errdefer a.free(results);
    @memset(results, .{});
    var timer = try std.time.Timer.start();
    while (true) {
        if (config.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const now = timer.read() / std.time.ns_per_ms;
        var completed: usize = 0;
        // Every slot gets its first native request before the first socket wait.
        for (slots, caches, results) |slot, *cache, *result| {
            if (result.ready or result.failure != null) {
                completed += 1;
                continue;
            }
            if (now >= config.timeout_ms) {
                cache.expire();
                result.failure = error.RequestDeadlineExceeded;
                completed += 1;
                continue;
            }
            if (cache.pending != null) continue;
            cache.beginAttempt(now);
            const value = slot.reader.latest(config.period) catch |err| {
                if (err != error.PendingReadIo) {
                    result.failure = err;
                    completed += 1;
                }
                continue;
            };
            result.* = .{ .ready = true, .value = value };
            completed += 1;
        }
        if (ready(context, results) or completed == slots.len) return results;
        var progressed = false;
        while (try engine.poll(timer.read() / std.time.ns_per_ms)) |value| {
            var completion = value;
            defer completion.deinit();
            var consumed = false;
            for (caches) |*cache| if (try cache.consume(&completion)) {
                consumed = true;
                break;
            };
            if (!consumed) return error.UnknownCheckpointVoteCompletion;
            progressed = true;
        }
        if (!progressed) std.Thread.sleep(std.time.ns_per_ms);
    }
}
