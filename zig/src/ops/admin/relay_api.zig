//! Public `/relay` health/submission handler with source admission semantics.
const std = @import("std");
const http = @import("../http.zig");
const metrics = @import("../metrics.zig");
const settings = @import("../../settings/types.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);

pub const RelayMessage = struct {
    message_id: [32]u8,
    origin: u32,
    destination: u32,
    nonce: u32,
};

pub const Config = struct {
    enabled: bool = false,
    port: u16 = 8900,
    rate_limit_max_requests: usize = 100,
    rate_limit_window_secs: u64 = 60,
    cors_origins: []const []const u8 = &.{},
};

pub fn configFromSettings(source: settings.Relayer) !Config {
    const max_requests = source.relay_api_rate_limit_max_requests orelse 100;
    const window = source.relay_api_rate_limit_window_secs orelse 60;
    if (max_requests == 0 or window == 0) return error.InvalidRelayApiSettings;
    return .{
        .enabled = source.relay_api_enabled,
        .port = source.relay_api_port orelse 8900,
        .rate_limit_max_requests = max_requests,
        .rate_limit_window_secs = window,
        .cors_origins = source.relay_api_cors_origins,
    };
}

pub const FailureKind = enum {
    too_many_requests,
    invalid_request,
    not_found,
    internal,
    service_unavailable,
    request_timeout,

    fn status(self: FailureKind) u16 {
        return switch (self) {
            .too_many_requests => 429,
            .invalid_request => 400,
            .not_found => 404,
            .internal => 500,
            .service_unavailable => 503,
            .request_timeout => 408,
        };
    }
};

pub const FailureMetric = enum {
    none,
    timeout,
    extraction_failed,
    too_many_messages,
    not_cctp_v2,
    message_not_whitelisted,
    message_blacklisted,
    message_blacklisted_address,
    message_runtime_denylisted,
    retries_exhausted,
    send_failed,
    processor_saturated,

    fn label(self: FailureMetric) []const u8 {
        return switch (self) {
            .none => "",
            else => @tagName(self),
        };
    }
};

pub const RelayFailure = struct {
    kind: FailureKind,
    metric: FailureMetric = .none,
    body: []const u8,
    processor_admission_seconds: ?f64 = null,
};

pub const RelayResult = struct {
    failure: ?RelayFailure = null,
    messages: []RelayMessage = &.{},
    processor_admission_seconds: ?f64 = null,
};

pub const SubmissionOwner = struct {
    context: *anyopaque,
    /// Performs extraction, policy validation, IGP persistence, bounded processor
    /// admission, and synchronous batch handoff. Must observe cancel throughout.
    submit_fn: *const fn (context: *anyopaque, allocator: A, origin_chain: []const u8, tx_hash: []const u8, cancel: Cancel) anyerror!RelayResult,
};

pub const Clock = struct {
    context: *anyopaque,
    monotonic_ns: *const fn (context: *anyopaque) u64,
    unix_seconds: *const fn (context: *anyopaque) i64,
};

pub const RateLimiter = struct {
    mutex: std.Thread.Mutex = .{},
    requests: std.array_list.Managed(u64),
    max_requests: usize,
    window_secs: u64,

    pub fn init(a: A, max_requests: usize, window_secs: u64) !RateLimiter {
        if (max_requests == 0 or window_secs == 0) return error.InvalidRateLimit;
        return .{ .requests = .init(a), .max_requests = max_requests, .window_secs = window_secs };
    }
    pub fn deinit(self: *RateLimiter) void {
        self.requests.deinit();
        self.* = undefined;
    }
    pub fn check(self: *RateLimiter, clock: Clock) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const signed_now = clock.unix_seconds(clock.context);
        var now: u64 = 0;
        if (signed_now < 0) {
            self.requests.clearRetainingCapacity();
            now = 0;
            self.requests.append(now) catch return false;
            return true;
        }
        now = @intCast(signed_now);
        while (self.requests.items.len > 0) {
            const age = now -| self.requests.items[0];
            if (age < self.window_secs) break;
            _ = self.requests.orderedRemove(0);
        }
        if (self.requests.items.len >= self.max_requests) return false;
        self.requests.append(now) catch return false;
        return true;
    }
};

const CacheEntry = union(enum) { reserved: u64, committed: u64 };
const CacheMap = std.StringHashMapUnmanaged(CacheEntry);

pub const TxHashReservation = struct {
    cache: ?*TxHashCache = null,
    key: []u8 = &.{},
    token: u64 = 0,

    pub fn commit(self: *TxHashReservation) void {
        if (self.cache) |cache| cache.commitReservation(self.key, self.token);
        self.releaseOwnership();
    }
    pub fn release(self: *TxHashReservation) void {
        if (self.cache) |cache| cache.removeReservation(self.key, self.token);
        self.releaseOwnership();
    }
    fn releaseOwnership(self: *TxHashReservation) void {
        // The cache map owns key bytes until remove/deinit; commit and failed
        // reservations must not invalidate an entry that remains in the map.
        self.* = .{};
    }
};

pub const TxHashCacheError = error{ Duplicate, CacheFull, OutOfMemory, TxHashCacheCorruption };

pub const TxHashCache = struct {
    allocator: A,
    clock: Clock,
    mutex: std.Thread.Mutex = .{},
    entries: CacheMap = .empty,
    max_entries: usize,
    ttl_ns: u64,
    next_token: u64 = 0,

    pub fn init(allocator: A, max_entries: usize, ttl_ns: u64, clock: Clock) !TxHashCache {
        if (max_entries == 0 or ttl_ns == 0) return error.InvalidTxHashCache;
        return .{ .allocator = allocator, .clock = clock, .max_entries = max_entries, .ttl_ns = ttl_ns };
    }
    pub fn deinit(self: *TxHashCache) void {
        var iterator = self.entries.keyIterator();
        while (iterator.next()) |key| {
            self.allocator.free(@constCast(key.*));
        }
        self.entries.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn checkAndInsert(self: *TxHashCache, chain: []const u8, tx_hash: []const u8) TxHashCacheError!TxHashReservation {
        self.mutex.lock();
        defer self.mutex.unlock();
        const now = self.clock.monotonic_ns(self.clock.context);
        if (self.entries.count() > self.max_entries * 3 / 4) self.cleanupLocked(now);
        const owned_chain = self.allocator.dupe(u8, chain) catch return error.OutOfMemory;
        const owned_hash = normalizeTxHash(self.allocator, tx_hash) catch {
            self.allocator.free(owned_chain);
            return error.OutOfMemory;
        };
        const key = makeCacheKey(self.allocator, owned_chain, owned_hash) catch {
            self.allocator.free(owned_chain);
            self.allocator.free(owned_hash);
            return error.OutOfMemory;
        };
        defer self.allocator.free(owned_chain);
        defer self.allocator.free(owned_hash);
        if (self.entries.getPtr(key)) |existing| {
            const active = switch (existing.*) {
                .reserved => true,
                .committed => |at| now -% at < self.ttl_ns,
            };
            if (active) {
                self.allocator.free(key);
                return error.Duplicate;
            }
            const stale_probe = self.entries.getOrPut(self.allocator, key) catch {
                self.allocator.free(key);
                return error.OutOfMemory;
            };
            if (!stale_probe.found_existing) {
                self.allocator.free(key);
                return error.TxHashCacheCorruption;
            }
            const old = stale_probe.key_ptr.*;
            _ = self.entries.remove(old);
            self.allocator.free(@constCast(old));
        }
        if (self.entries.count() >= self.max_entries) {
            self.allocator.free(key);
            return error.CacheFull;
        }
        const probe = self.entries.getOrPut(self.allocator, key) catch {
            self.allocator.free(key);
            return error.OutOfMemory;
        };
        if (probe.found_existing) return error.TxHashCacheCorruption;
        const token = self.next_token;
        self.next_token +%= 1;
        probe.key_ptr.* = key;
        probe.value_ptr.* = .{ .reserved = token };
        return .{ .cache = self, .key = key, .token = token };
    }

    fn commitReservation(self: *TxHashCache, key: []u8, token: u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.entries.getPtr(key)) |entry| {
            if (entry.* == .reserved and entry.reserved == token) entry.* = .{ .committed = self.clock.monotonic_ns(self.clock.context) };
        }
    }

    fn removeReservation(self: *TxHashCache, key: []u8, token: u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.entries.getPtr(key)) |entry| {
            switch (entry.*) {
                .reserved => |current| {
                    if (current == token) {
                        _ = self.entries.remove(key);
                        self.allocator.free(key);
                    }
                },
                .committed => {},
            }
        }
    }

    fn cleanupLocked(self: *TxHashCache, now: u64) void {
        var expired = std.array_list.Managed([]const u8).init(self.allocator);
        defer expired.deinit();
        var iterator = self.entries.iterator();
        while (iterator.next()) |entry| {
            switch (entry.value_ptr.*) {
                .reserved => {},
                .committed => |at| if (now -% at >= self.ttl_ns) expired.append(entry.key_ptr.*) catch return,
            }
        }
        for (expired.items) |key| {
            _ = self.entries.remove(key);
            self.allocator.free(@constCast(key));
        }
    }
};

fn makeCacheKey(a: A, chain: []const u8, tx_hash: []const u8) ![]u8 {
    const key = try a.alloc(u8, 16 + chain.len + tx_hash.len);
    std.mem.writeInt(u64, key[0..8], chain.len, .little);
    std.mem.writeInt(u64, key[8..16], tx_hash.len, .little);
    @memcpy(key[16..][0..chain.len], chain);
    @memcpy(key[16 + chain.len ..], tx_hash);
    return key;
}

fn normalizeTxHash(a: A, raw: []const u8) ![]u8 {
    const digits = if (std.mem.startsWith(u8, raw, "0x") or std.mem.startsWith(u8, raw, "0X")) raw[2..] else raw;
    const out = try a.dupe(u8, digits);
    for (out) |*byte| byte.* = std.ascii.toLower(byte.*);
    return out;
}

pub const RelayApi = struct {
    owner: SubmissionOwner,
    registry: *metrics.Registry,
    rate_limiter: ?*RateLimiter,
    tx_cache: ?*TxHashCache,
    clock: Clock,
    cors_origins: []const []const u8,

    pub fn handler(self: *RelayApi) http.Handler {
        return .{ .context = self, .handle_fn = respond };
    }
};

fn respond(context: *anyopaque, a: A, request: http.Request, cancel: Cancel) anyerror!http.Response {
    if (cancel.load(.acquire)) return error.Cancelled;
    const self: *RelayApi = @ptrCast(@alignCast(context));
    if (!std.mem.eql(u8, request.path, "/relay")) return corsResponse(self, a, request, try http.Response.init(a, 404, &.{}, ""), false);
    const origin = request.header("origin");
    if (std.mem.eql(u8, request.method, "OPTIONS")) return preflight(self, a, request, origin);
    if (std.mem.eql(u8, request.method, "GET")) {
        const response = try http.Response.init(a, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, "up");
        return corsResponse(self, a, request, response, origin != null);
    }
    if (std.mem.eql(u8, request.method, "POST")) return submit(self, a, request, cancel);
    const response = try http.Response.init(a, 405, &.{.{ .name = "allow", .value = "GET,POST" }}, "");
    return corsResponse(self, a, request, response, false);
}

fn submit(self: *RelayApi, a: A, request: http.Request, cancel: Cancel) !http.Response {
    if (self.rate_limiter) |limiter| {
        if (!limiter.check(self.clock)) {
            try recordFailure(self, "rate_limited");
            return corsPlain(self, a, request, 429, "Rate limit exceeded");
        }
    }
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const parsed = std.json.parseFromSlice(std.json.Value, arena.allocator(), request.body, .{}) catch |err| {
        if (err == error.OutOfMemory) return err;
        return corsPlain(self, a, request, 400, "Failed to deserialize the JSON body");
    };
    if (parsed.value != .object) return invalid(self, a, request, "invalid_request", "Invalid request body");
    const object = parsed.value.object;
    const chain_value = object.get("origin_chain") orelse return invalid(self, a, request, "invalid_request", "origin_chain cannot be empty");
    const hash_value = object.get("tx_hash") orelse return invalid(self, a, request, "invalid_request", "tx_hash cannot be empty");
    if (chain_value != .string or hash_value != .string) return invalid(self, a, request, "invalid_request", "Invalid request field type");
    const chain = chain_value.string;
    const tx_hash = hash_value.string;
    if (chain.len == 0) return invalid(self, a, request, "invalid_request", "origin_chain cannot be empty");
    if (chain.len > 128) return invalid(self, a, request, "invalid_request", "origin_chain exceeds maximum length of 128 characters");
    if (tx_hash.len > 512) return invalid(self, a, request, "invalid_request", "tx_hash exceeds maximum length of 512 characters");
    if (tx_hash.len == 0) return invalid(self, a, request, "invalid_request", "tx_hash cannot be empty");

    var reservation: TxHashReservation = .{};
    defer reservation.release();
    if (self.tx_cache) |cache| {
        reservation = cache.checkAndInsert(chain, tx_hash) catch |err| switch (err) {
            error.Duplicate => {
                try recordFailure(self, "duplicate_tx");
                return corsPlain(self, a, request, 429, "Transaction already submitted recently");
            },
            error.CacheFull => {
                try recordFailure(self, "cache_full");
                return corsPlain(self, a, request, 503, "Service temporarily unavailable");
            },
            error.OutOfMemory => return err,
            else => return err,
        };
    }
    const result = try self.owner.submit_fn(self.owner.context, arena.allocator(), chain, tx_hash, cancel);
    if (result.failure) |failure| {
        const duration = failure.processor_admission_seconds orelse result.processor_admission_seconds;
        if (duration) |seconds| try observeProcessorAdmission(self, seconds);
        if (failure.metric != .none) try recordFailure(self, failure.metric.label());
        return corsPlain(self, a, request, failure.kind.status(), failure.body);
    }
    if (result.processor_admission_seconds) |duration| try observeProcessorAdmission(self, duration);
    reservation.commit();
    try recordSuccess(self);
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"messages\":[") catch |err| return err;
    for (result.messages, 0..) |message, index| {
        if (index != 0) out.writer.writeByte(',') catch |err| return err;
        out.writer.writeAll("{\"message_id\":\"") catch |err| return err;
        writeHash(&out.writer, message.message_id) catch |err| return err;
        out.writer.print("\",\"origin\":{d},\"destination\":{d},\"nonce\":{d}}}", .{ message.origin, message.destination, message.nonce }) catch |err| return err;
    }
    out.writer.writeAll("]}") catch |err| return err;
    const body = out.written();
    defer out.deinit();
    const response = try http.Response.init(a, 200, &.{.{ .name = "content-type", .value = "application/json" }}, body);
    return corsResponse(self, a, request, response, false);
}

fn invalid(self: *RelayApi, a: A, request: http.Request, metric: []const u8, body: []const u8) !http.Response {
    try recordFailure(self, metric);
    return corsPlain(self, a, request, 400, body);
}

fn preflight(self: *RelayApi, a: A, request: http.Request, origin: ?[]const u8) !http.Response {
    const allowed_origin = origin orelse return http.Response.init(a, 400, &.{}, "Bad Request");
    if (!originAllowed(self.cors_origins, allowed_origin)) return http.Response.init(a, 400, &.{}, "Bad Request");
    const method = request.header("access-control-request-method") orelse return http.Response.init(a, 400, &.{}, "Bad Request");
    if (!std.mem.eql(u8, method, "GET") and !std.mem.eql(u8, method, "POST")) return http.Response.init(a, 400, &.{}, "Bad Request");
    if (request.header("access-control-request-headers")) |fields| {
        var iterator = std.mem.splitScalar(u8, fields, ',');
        while (iterator.next()) |field| {
            const trimmed = std.mem.trim(u8, field, " \t");
            if (trimmed.len != 0 and !std.ascii.eqlIgnoreCase(trimmed, "content-type")) return http.Response.init(a, 400, &.{}, "Bad Request");
        }
    }
    return http.Response.init(a, 204, &.{
        .{ .name = "access-control-allow-origin", .value = allowed_origin },
        .{ .name = "access-control-allow-methods", .value = "GET,POST" },
        .{ .name = "access-control-allow-headers", .value = "content-type" },
        .{ .name = "vary", .value = "Origin" },
    }, "");
}

fn corsPlain(self: *RelayApi, a: A, request: http.Request, status: u16, body: []const u8) !http.Response {
    const response = try http.Response.init(a, status, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
    return corsResponse(self, a, request, response, false);
}

fn corsResponse(self: *RelayApi, a: A, request: http.Request, response: http.Response, force_vary: bool) !http.Response {
    var owned = response;
    const origin = request.header("origin");
    const allowed = if (origin) |value| originAllowed(self.cors_origins, value) else false;
    if (!allowed and !force_vary and self.cors_origins.len == 0) return owned;
    errdefer owned.deinit();
    var headers = std.array_list.Managed(http.Header).init(a);
    defer headers.deinit();
    try headers.appendSlice(owned.headers);
    try headers.append(.{ .name = "vary", .value = "Origin" });
    if (allowed) {
        const value = origin.?;
        try headers.append(.{ .name = "access-control-allow-origin", .value = value });
    }
    const body = try a.dupe(u8, owned.body);
    errdefer a.free(body);
    var replacement = try http.Response.init(a, owned.status, headers.items, body);
    a.free(body);
    replacement.close = owned.close;
    owned.deinit();
    return replacement;
}

fn originAllowed(origins: []const []const u8, origin: []const u8) bool {
    if (!validHeaderValue(origin)) return false;
    for (origins) |candidate| if (std.mem.eql(u8, candidate, origin)) return true;
    return false;
}

fn validHeaderValue(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |byte| {
        if (byte <= 0x20 or byte == 0x7f or byte >= 0x80) return false;
    }
    return true;
}

fn writeHash(w: *std.Io.Writer, hash: [32]u8) !void {
    const hex = "0123456789abcdef";
    for (hash) |byte| {
        try w.writeByte(hex[byte >> 4]);
        try w.writeByte(hex[byte & 15]);
    }
}

fn recordSuccess(self: *RelayApi) !void {
    try self.registry.update("hyperlane_relay_api_requests_total", &.{ "success", "" }, .{ .add_int = 1 });
}

fn recordFailure(self: *RelayApi, error_type: []const u8) !void {
    try self.registry.update("hyperlane_relay_api_requests_total", &.{ "failure", error_type }, .{ .add_int = 1 });
}

fn observeProcessorAdmission(self: *RelayApi, duration: f64) !void {
    try self.registry.update("hyperlane_relay_api_processor_admission_duration_seconds", &.{}, .{ .observe = duration });
}
