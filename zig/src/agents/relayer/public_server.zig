//! Separate public relay listener. HTTP callers retire before admission owners.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const api = @import("../../ops/admin/relay_api.zig");
const http = @import("../../ops/http.zig");
const metrics = @import("../../ops/metrics.zig");
const origins = @import("../origin_tasks.zig");
const resources = @import("../chain_source.zig");
const control = @import("control.zig");
const submission = @import("public_relay.zig");
const A = std.mem.Allocator;

pub const Listener = struct {
    allocator: A,
    timer: std.time.Timer,
    clock_mutex: std.Thread.Mutex = .{},
    owner: *submission.PublicRelay,
    limiter: api.RateLimiter,
    cache: api.TxHashCache,
    handler: api.RelayApi,
    server: *http.Server,

    pub fn start(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, origin_set: *origins.Set, hub: *control.Hub, options: resources.Options, registry: *metrics.Registry) !?*Listener {
        const config = try api.configFromSettings(configured.role.relayer);
        if (!config.enabled) return null;
        const self = try a.create(Listener);
        errdefer a.destroy(self);
        const owner = try submission.PublicRelay.init(a, configured, environment, origin_set, hub, options);
        errdefer owner.deinit();
        self.* = .{
            .allocator = a,
            .timer = try std.time.Timer.start(),
            .owner = owner,
            .limiter = try api.RateLimiter.init(a, config.rate_limit_max_requests, config.rate_limit_window_secs),
            .cache = undefined,
            .handler = undefined,
            .server = undefined,
        };
        errdefer self.limiter.deinit();
        const clock: api.Clock = .{ .context = self, .monotonic_ns = monotonic, .unix_seconds = seconds };
        // Source has 10,000 hashes with a five-minute TTL; reservations do not
        // expire while their submission is still in flight.
        self.cache = try api.TxHashCache.init(a, 10000, 300 * std.time.ns_per_s, clock);
        errdefer self.cache.deinit();
        self.handler = .{ .owner = owner.submissionOwner(), .registry = registry, .rate_limiter = &self.limiter, .tx_cache = &self.cache, .clock = clock, .cors_origins = config.cors_origins };
        self.server = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("0.0.0.0", config.port) }, self.handler.handler());
        return self;
    }
    fn monotonic(context: *anyopaque) u64 {
        const self: *Listener = @ptrCast(@alignCast(context));
        self.clock_mutex.lock();
        defer self.clock_mutex.unlock();
        return self.timer.read();
    }
    fn seconds(_: *anyopaque) i64 {
        return std.time.timestamp();
    }
    pub fn deinit(self: *Listener) void {
        self.server.deinit();
        self.owner.deinit();
        self.cache.deinit();
        self.limiter.deinit();
        self.allocator.destroy(self);
    }
};
