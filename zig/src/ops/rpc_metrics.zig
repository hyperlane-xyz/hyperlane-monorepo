//! Source RPC counters. Observations describe completed physical calls; logical
//! retries, replay-cache reads and dropped hedge futures are not extra requests.
//! Configured URLs are reduced to host:port before any label enters the registry.
const std = @import("std");
const metrics = @import("metrics.zig");
const pool = @import("../evm/pool.zig");
const curl = @import("../net/curl.zig");
const endpoint = @import("../net/endpoint.zig");
const A = std.mem.Allocator;
pub const Role = enum { primary, quorum };
pub const Operation = enum { unattributed, contract_sync, agent_metrics, validator_checkpoint, relayer_delivery, relayer_recipient, relayer_metadata, relayer_estimate, transaction_lifecycle };
pub const Protocol = enum { json_rpc, ethereum_json_rpc, radix, tron, aleo };
pub const Options = struct { chain: []const u8, protocol: Protocol = .json_rpc, role: Role = .primary, operation: Operation = .unattributed };
pub const Recorder = struct {
    allocator: A,
    references: std.atomic.Value(usize) = .init(1),
    arena: std.heap.ArenaAllocator,
    registry: *metrics.Registry,
    options: Options,
    hosts: std.ArrayList([]const u8) = .empty,
    pool_hosts: []const []const u8 = &.{},
    /// Registry limits/OOM are observable without turning telemetry into an RPC
    /// failure. The first failure emits only the error name, never a request.
    failures: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    pub fn init(a: A, registry: *metrics.Registry, options: Options) !*Recorder {
        const self = try a.create(Recorder);
        self.* = .{ .allocator = a, .arena = std.heap.ArenaAllocator.init(a), .registry = registry, .options = options };
        errdefer self.deinit();
        if (options.chain.len == 0 or options.chain.len > 256) return error.InvalidMetricChain;
        self.options.chain = try self.arena.allocator().dupe(u8, options.chain);
        return self;
    }
    /// Join every producer (including Pool) before deinit. addEndpoints and
    /// configurePool are construction-only; callbacks only read immutable hosts.
    pub fn deinit(self: *Recorder) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        self.arena.deinit();
        self.allocator.destroy(self);
    }
    pub fn addEndpoints(self: *Recorder, urls: []const []const u8) !void {
        const a = self.arena.allocator();
        for (urls) |url| {
            const label = try hostLabel(a, url);
            var found = false;
            for (self.hosts.items) |known| if (std.mem.eql(u8, known, label)) {
                found = true;
                break;
            };
            if (!found) {
                if (self.hosts.items.len >= 1024) return error.MetricEndpointLimit;
                try self.hosts.append(a, label);
            }
        }
    }
    /// Match Pool's sensitive canonical identity deduplication, but retain only
    /// the public host label after construction. Endpoint index stays stable.
    pub fn configurePool(self: *Recorder, urls: []const []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var identities: std.StringHashMapUnmanaged(void) = .empty;
        var labels: std.ArrayList([]const u8) = .empty;
        for (urls) |url| {
            const owned = try endpoint.OwnedEndpoint.parse(a, url);
            if (identities.contains(owned.identity)) continue;
            try identities.put(a, owned.identity, {});
            try labels.append(self.arena.allocator(), try hostLabel(self.arena.allocator(), owned.endpoint.url));
        }
        self.pool_hosts = try labels.toOwnedSlice(self.arena.allocator());
        try self.addEndpoints(urls);
    }
    pub fn record(self: *Recorder, host: []const u8, connection: []const u8, method: []const u8, success: bool, duration_ns: u64) !void {
        const labels = [_][]const u8{ host, connection, self.options.chain, pool.boundedMethod(method), if (success) "success" else "failure", @tagName(self.options.role), @tagName(self.options.operation) };
        try self.registry.update("hyperlane_request_count", &labels, .{ .add_int = 1 });
        try self.registry.update("hyperlane_request_duration_seconds", &labels, .{ .add_real = @as(f64, @floatFromInt(duration_ns)) / std.time.ns_per_s });
    }
    fn failed(self: *Recorder, err: anyerror) void {
        if (self.failures.fetchAdd(1, .monotonic) == 0) std.log.warn("RPC metrics failed: {s}", .{@errorName(err)});
    }
    pub fn poolObserver(self: *Recorder) pool.Observer {
        return .{ .context = self, .event_fn = observePool, .retain_fn = retainObserver, .release_fn = releaseObserver };
    }
    fn retainObserver(context: *anyopaque) void {
        const self: *Recorder = @ptrCast(@alignCast(context));
        const previous = self.references.fetchAdd(1, .monotonic);
        std.debug.assert(previous != 0);
    }
    fn releaseObserver(context: *anyopaque) void {
        const self: *Recorder = @ptrCast(@alignCast(context));
        self.deinit();
    }
    pub const ScopedObserver = struct {
        observer: pool.Observer,
        recorder: ?*Recorder,
        /// Restore any client's borrowed Options.pool_observer before dropping
        /// the scope. Already submitted sessions retain their own observer ref.
        pub fn deinit(self: *ScopedObserver) void {
            if (self.recorder) |recorder| recorder.deinit();
            self.recorder = null;
        }
    };
    /// Independent immutable attribution, public host labels only. Caller owns
    /// one scope reference; native sessions/probes retain until actual drain.
    pub fn poolObserverFor(self: *Recorder, operation: Operation) !ScopedObserver {
        const child = try self.fork(self.options.role, operation);
        return .{ .observer = child.poolObserver(), .recorder = child };
    }
    pub fn fork(self: *Recorder, role: Role, operation: Operation) !*Recorder {
        const child = try Recorder.init(self.allocator, self.registry, .{ .chain = self.options.chain, .protocol = self.options.protocol, .role = role, .operation = operation });
        errdefer child.deinit();
        const a = child.arena.allocator();
        for (self.hosts.items) |host| try child.hosts.append(a, try a.dupe(u8, host));
        const labels = try a.alloc([]const u8, self.pool_hosts.len);
        for (labels, self.pool_hosts) |*label, from| label.* = try a.dupe(u8, from);
        child.pool_hosts = labels;
        return child;
    }
    pub fn providerCreated(self: *Recorder, count: usize) void {
        if (count != 0) self.registry.update("hyperlane_provider_create_count", &.{self.options.chain}, .{ .add_int = count }) catch |err| self.failed(err);
    }
    pub fn providerDropped(self: *Recorder, count: usize) void {
        if (count != 0) self.registry.update("hyperlane_provider_drop_count", &.{self.options.chain}, .{ .add_int = count }) catch |err| self.failed(err);
    }
    pub fn nativeCacheObserver(self: *Recorder) @import("../net/dynamic_tip_cache.zig").Observer {
        return .{ .context = self, .event_fn = nativeCacheEvent };
    }
    fn nativeCacheEvent(context: *anyopaque, url: []const u8, method: []const u8, event: @import("../net/dynamic_tip_cache.zig").Event) void {
        const self: *Recorder = @ptrCast(@alignCast(context));
        var buffer: [512]u8 = undefined;
        var fixed = std.heap.FixedBufferAllocator.init(&buffer);
        const host = hostLabel(fixed.allocator(), url) catch return;
        var known = false;
        for (self.hosts.items) |value| if (std.mem.eql(u8, value, host)) {
            known = true;
            break;
        };
        if (!known) {
            self.failed(error.MetricUnknownEndpoint);
            return;
        }
        self.registry.update("hyperlane_request_cache_count", &.{ host, self.options.chain, pool.boundedMethod(method), @tagName(event), @tagName(self.options.role) }, .{ .add_int = 1 }) catch |err| self.failed(err);
    }
    fn hedgeEvent(self: *Recorder, method: []const u8, event: []const u8) void {
        self.registry.update("hyperlane_fallback_hedge_events_total", &.{ self.options.chain, pool.boundedMethod(method), event }, .{ .add_int = 1 }) catch |err| self.failed(err);
    }
    fn observePool(context: *anyopaque, event: pool.Event) void {
        const self: *Recorder = @ptrCast(@alignCast(context));
        switch (event.kind) {
            .provider_created => self.providerCreated(1),
            .provider_dropped => self.providerDropped(1),
            .hedge_started => if (event.hedged) self.hedgeEvent(event.method, "start"),
            .attempt_timed_out => if (event.hedged) self.hedgeEvent(event.method, "timeout"),
            .hedge_cancelled => if (event.hedged) self.hedgeEvent(event.method, "cancellation"),
            .request_succeeded, .request_failed => {
                if (!event.hedged or event.cancelled) return;
                const winner = if (!event.success) "error" else if (event.speculative) "hedge" else "primary";
                if (event.success) self.hedgeEvent(event.method, if (event.speculative) "hedge_winner" else "primary_winner");
                self.registry.update("hyperlane_fallback_hedge_duration_seconds", &.{ self.options.chain, pool.boundedMethod(event.method), winner }, .{ .observe = @as(f64, @floatFromInt(event.duration_ns)) / std.time.ns_per_s }) catch |err| self.failed(err);
            },
            .cache_logical_read, .cache_hit, .cache_upstream_read, .cache_upstream_error => {
                const index = event.endpoint_index orelse return;
                if (index >= self.pool_hosts.len) {
                    self.failed(error.MetricEndpointIndex);
                    return;
                }
                const result = switch (event.kind) {
                    .cache_logical_read => "logical_read",
                    .cache_hit => "cache_hit",
                    .cache_upstream_read => "upstream_read",
                    .cache_upstream_error => "upstream_error",
                    else => unreachable,
                };
                self.registry.update("hyperlane_request_cache_count", &.{ self.pool_hosts[index], self.options.chain, pool.boundedMethod(event.method), result, @tagName(self.options.role) }, .{ .add_int = 1 }) catch |err| self.failed(err);
            },
            .upstream_completed => {
                if (event.cancelled) return;
                const index = event.endpoint_index orelse return;
                if (index >= self.pool_hosts.len) {
                    self.failed(error.MetricEndpointIndex);
                    return;
                }
                self.record(self.pool_hosts[index], "rpc", event.method, event.success, event.duration_ns) catch |err| self.failed(err);
            },
            else => {},
        }
    }
    const HttpPending = struct {
        allocator: A,
        owner: *Recorder,
        references: std.atomic.Value(usize) = .init(1),
        host: []const u8,
        connection: []const u8,
        json_rpc: bool,
        method: [128]u8 = undefined,
        method_len: usize,
        fn retain(context: *anyopaque) void {
            const self: *HttpPending = @ptrCast(@alignCast(context));
            _ = self.references.fetchAdd(1, .monotonic);
        }
        fn release(context: *anyopaque) void {
            const self: *HttpPending = @ptrCast(@alignCast(context));
            if (self.references.fetchSub(1, .acq_rel) != 1) return;
            self.owner.deinit();
            self.allocator.destroy(self);
        }
        fn complete(context: *anyopaque, result: *const @import("../net/curl_multi.zig").Result, duration_ns: u64) void {
            const self: *HttpPending = @ptrCast(@alignCast(context));
            const description: Description = .{ .host = self.host, .connection = self.connection, .method = self.method[0..self.method_len], .json_rpc = self.json_rpc };
            const success = switch (result.*) {
                .failure => |err| if (err == error.RequestCancelled) return else false,
                .response => |*response| self.owner.responseSuccess(description, response),
            };
            self.owner.record(self.host, self.connection, description.method, success, duration_ns) catch |err| self.owner.failed(err);
        }
    };
    /// Owned public-label completion descriptor. Submit retains it; caller drops
    /// its reference after submit. No URL/header/body or Client pointer survives.
    pub fn httpCompletionObserver(self: *Recorder, request: curl.Request) !?@import("../net/http_runtime.zig").Observer {
        var method: [128]u8 = undefined;
        const description = self.describe(request, &method) orelse return null;
        const pending = try self.allocator.create(HttpPending);
        pending.* = .{ .allocator = self.allocator, .owner = self, .host = description.host, .connection = description.connection, .json_rpc = description.json_rpc, .method_len = description.method.len };
        @memcpy(pending.method[0..pending.method_len], description.method);
        retainObserver(self);
        return .{ .context = pending, .complete_fn = HttpPending.complete, .retain_fn = HttpPending.retain, .release_fn = HttpPending.release };
    }
    pub fn nativeObserver(self: *Recorder) curl.Observer {
        return .{ .context = self, .event_fn = observeNative };
    }
    pub const Description = struct { host: []const u8, connection: []const u8, method: []const u8, json_rpc: bool = false };
    /// Host borrows immutable Recorder storage. Method always borrows the caller's
    /// stable 128-byte buffer, so an async cache never retains URL/body/headers.
    pub fn describe(self: *Recorder, request: curl.Request, method_storage: *[128]u8) ?Description {
        var buffer: [512]u8 = undefined;
        var fixed = std.heap.FixedBufferAllocator.init(&buffer);
        const label = hostLabel(fixed.allocator(), request.url) catch return null;
        var known: ?[]const u8 = null;
        for (self.hosts.items) |host| if (std.mem.eql(u8, label, host)) {
            known = host;
            break;
        };
        const host = known orelse return null;
        const uri = std.Uri.parse(request.url) catch return null;
        const path = component(uri.path);
        const json_method = if (request.body) |body| jsonMethod(body, method_storage) else "unknown";
        const json_rpc = !request.require_http2 and (self.options.protocol == .json_rpc or self.options.protocol == .ethereum_json_rpc or (self.options.protocol == .tron and !std.mem.eql(u8, json_method, "unknown")));
        const method = if (request.require_http2) grpcMethod(path) else if (json_rpc) json_method else switch (self.options.protocol) {
            .json_rpc, .ethereum_json_rpc => unreachable,
            .radix => radixMethod(path),
            .tron => tronMethod(path),
            .aleo => aleoMethod(path),
        };
        // jsonMethod already copied to this buffer; static route names copy here.
        if (method.ptr != method_storage[0..].ptr) @memcpy(method_storage[0..method.len], method);
        return .{ .host = host, .connection = if (request.require_http2) "grpc" else "rpc", .method = method_storage[0..method.len], .json_rpc = json_rpc };
    }
    pub fn responseSuccess(self: *Recorder, description: Description, response: *const curl.Response) bool {
        var success = response.status >= 200 and response.status < 300;
        if (std.mem.eql(u8, description.connection, "grpc")) {
            var grpc_ok = false;
            for (response.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "grpc-status")) {
                grpc_ok = std.mem.eql(u8, header.value, "0");
            };
            success = success and grpc_ok;
        } else if (description.json_rpc) {
            success = if (self.options.protocol == .ethereum_json_rpc) response.status != 429 and (jsonSuccessInner(response.body, true) catch false) else success and jsonSuccess(response.body);
        } else if (self.options.protocol == .aleo and response.status == 404 and std.mem.startsWith(u8, description.method, "transaction")) success = true;
        return success;
    }
    /// Native Multi completion hook for read-only replay. Invoke once per real
    /// transfer; replay-cache hits/PendingReadIo unwinds must never call this.
    pub fn recordNative(self: *Recorder, observation: curl.Observation) void {
        if (observation.failure) |err| if (err == error.RequestCancelled) return;
        var method_storage: [128]u8 = undefined;
        const description = self.describe(observation.request, &method_storage) orelse return;
        const success = if (observation.response) |response| self.responseSuccess(description, response) else false;
        self.record(description.host, description.connection, description.method, success, observation.duration_ns) catch |err| self.failed(err);
    }
    fn observeNative(context: *anyopaque, observation: curl.Observation) void {
        const self: *Recorder = @ptrCast(@alignCast(context));
        self.recordNative(observation);
    }
};
fn component(value: std.Uri.Component) []const u8 {
    return switch (value) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    };
}
pub fn hostLabel(a: A, url: []const u8) ![]const u8 {
    const uri = try std.Uri.parse(url);
    const host = component(uri.host orelse return error.MissingMetricHost);
    if (host.len == 0 or host.len > 253) return error.InvalidMetricHost;
    const port = uri.port orelse if (std.ascii.eqlIgnoreCase(uri.scheme, "https")) @as(u16, 443) else if (std.ascii.eqlIgnoreCase(uri.scheme, "http")) @as(u16, 80) else return error.InvalidMetricScheme;
    const label = try std.fmt.allocPrint(a, "{s}:{d}", .{ host, port });
    for (label) |*c| c.* = std.ascii.toLower(c.*);
    return label;
}
fn tokenString(token: std.json.Token) ?[]const u8 {
    return switch (token) {
        .string, .allocated_string => |s| s,
        else => null,
    };
}
fn jsonMethod(body: []const u8, buffer: *[128]u8) []const u8 {
    return jsonField(body, buffer) catch "unknown";
}
fn jsonField(body: []const u8, buffer: *[128]u8) ![]const u8 {
    var storage: [8192]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    const a = fixed.allocator();
    var scanner = std.json.Scanner.initCompleteInput(a, body);
    defer scanner.deinit();
    if (try scanner.next() != .object_begin) return "unknown";
    var method: []const u8 = "unknown";
    var seen = false;
    while (true) {
        const key = try scanner.nextAllocMax(a, .alloc_if_needed, 128);
        if (key == .object_end) break;
        const name = tokenString(key) orelse return "unknown";
        if (std.mem.eql(u8, name, "method")) {
            if (seen) return "unknown";
            seen = true;
            const value = tokenString(try scanner.nextAllocMax(a, .alloc_if_needed, 128)) orelse return "unknown";
            const sanitized = pool.boundedMethod(value);
            @memcpy(buffer[0..sanitized.len], sanitized);
            method = buffer[0..sanitized.len];
        } else try scanner.skipValue();
    }
    if (try scanner.next() != .end_of_document) return "unknown";
    return method;
}
fn jsonSuccess(body: []const u8) bool {
    return jsonSuccessInner(body, false) catch false;
}
fn jsonSuccessInner(body: []const u8, ethereum_envelope: bool) !bool {
    var storage: [8192]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    const a = fixed.allocator();
    var scanner = std.json.Scanner.initCompleteInput(a, body);
    defer scanner.deinit();
    if (try scanner.next() != .object_begin) return false;
    var result = false;
    var failed = false;
    var version = false;
    var id = false;
    var error_present = false;
    while (true) {
        const key = try scanner.nextAllocMax(a, .alloc_if_needed, 128);
        if (key == .object_end) break;
        const name = tokenString(key) orelse return false;
        if (ethereum_envelope and std.mem.eql(u8, name, "jsonrpc")) {
            if (version) return false;
            const value = tokenString(try scanner.nextAllocMax(a, .alloc_if_needed, 128)) orelse return false;
            if (!std.mem.eql(u8, value, "2.0")) return false;
            version = true;
            continue;
        }
        if (ethereum_envelope and std.mem.eql(u8, name, "id")) {
            if (id) return false;
            const token = try scanner.nextAllocMax(a, .alloc_if_needed, 128);
            const number = switch (token) {
                .number, .allocated_number => |text| text,
                else => return false,
            };
            _ = std.fmt.parseInt(u64, number, 10) catch return false;
            id = true;
            continue;
        }
        if (std.mem.eql(u8, name, "result")) {
            if (ethereum_envelope and result) return false;
            result = true;
        }
        if (std.mem.eql(u8, name, "error")) {
            error_present = true;
            if (try scanner.peekNextTokenType() != .null) failed = true;
        }
        try scanner.skipValue();
    }
    return try scanner.next() == .end_of_document and result and !failed and (!ethereum_envelope or (version and id and !error_present));
}
fn grpcMethod(path: []const u8) []const u8 {
    return if (std.mem.lastIndexOfScalar(u8, path, '/')) |i| pool.boundedMethod(path[i + 1 ..]) else "unknown";
}
fn radixMethod(path: []const u8) []const u8 {
    const paths = [_][]const u8{ "/status/gateway-status", "/transaction/committed-details", "/transaction/submit", "/transaction/preview-v2", "/stream/transactions", "/transaction/status", "/state/entity/details", "/status/network-status", "/transaction/call-preview" };
    const methods = [_][]const u8{ "gateway_status", "transaction_committed", "submit_transaction", "transaction_preview", "stream_txs", "transaction_status", "entity_details", "core_status", "call_preview" };
    for (paths, methods) |suffix, method| if (std.mem.endsWith(u8, path, suffix)) return method;
    return "unknown";
}
fn tronMethod(path: []const u8) []const u8 {
    const name = grpcMethod(path);
    const methods = [_][]const u8{ "getblockbynum", "getnowblock", "triggerconstantcontract", "estimateenergy", "broadcasthex" };
    const labels = [_][]const u8{ "get_block_by_num", "get_now_block", "trigger_constant_contract", "estimate_energy", "broadcast_hex" };
    for (methods, labels) |method, label| if (std.mem.eql(u8, name, method)) return label;
    return "unknown";
}
fn aleoMethod(path: []const u8) []const u8 {
    var pieces = std.mem.tokenizeScalar(u8, path, '/');
    while (pieces.next()) |part| {
        if (!std.mem.eql(u8, part, "mainnet") and !std.mem.eql(u8, part, "testnet") and !std.mem.eql(u8, part, "canary")) continue;
        const first = pieces.next() orelse return "unknown";
        if (std.mem.eql(u8, first, "transaction")) {
            const second = pieces.next() orelse return "transaction";
            inline for (.{ "confirmed", "unconfirmed", "broadcast" }) |suffix| if (std.mem.eql(u8, second, suffix)) return "transaction_" ++ suffix;
            return "transaction";
        }
        inline for (.{ "block", "blocks", "height", "latest", "find", "program", "mapping", "memoryPool", "committee", "stateRoot" }) |known| if (std.mem.eql(u8, first, known)) return known;
        return "unknown";
    }
    return "unknown";
}

test "RPC metric labels sanitize endpoints and bounded methods without retaining credentials" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try Recorder.init(a, registry, .{ .chain = "fixture", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{ "https://name:password@RPC.EXAMPLE/x?secret=hidden", "https://name:password@rpc.example/x?secret=hidden", "http://[::1]:123/path" });
    try std.testing.expectEqual(@as(usize, 2), recorder.pool_hosts.len);
    recorder.poolObserver().event_fn(recorder, .{ .kind = .upstream_completed, .endpoint_index = 0, .method = "eth_call", .success = true, .duration_ns = 125000 });
    recorder.poolObserver().event_fn(recorder, .{ .kind = .upstream_completed, .endpoint_index = 1, .method = "private/token", .success = false, .duration_ns = 1000000 });
    recorder.poolObserver().event_fn(recorder, .{ .kind = .upstream_completed, .endpoint_index = 0, .method = "ignored", .cancelled = true });
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "provider_node=\"rpc.example:443\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "provider_node=\"[::1]:123\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "method=\"unknown\"") != null);
    for ([_][]const u8{ "password", "secret", "hidden", "private", "ignored" }) |value| try std.testing.expect(std.mem.indexOf(u8, text, value) == null);
    try std.testing.expectEqual(@as(u64, 0), recorder.failures.load(.monotonic));
}
test "RPC metric scanner skips large params and results, bounds labels, classifies JSON RPC error" {
    var buffer: [128]u8 = undefined;
    try std.testing.expectEqualStrings("eth_call", jsonMethod("{\"params\":[{\"x\":[1,2]}],\"method\":\"eth_\\u0063all\"}", &buffer));
    try std.testing.expectEqualStrings("unknown", jsonMethod("{\"method\":\"password/secret\"}", &buffer));
    try std.testing.expectEqualStrings("unknown", jsonMethod("{\"method\":\"one\",\"method\":\"two\"}", &buffer));
    try std.testing.expect(jsonSuccess("{\"jsonrpc\":\"2.0\",\"result\":null,\"id\":1}"));
    try std.testing.expect(!jsonSuccess("{\"error\":{\"message\":\"failed\"},\"id\":1}"));
    try std.testing.expect(!jsonSuccess("{\"result\":1,\"error\":{}}"));
    try std.testing.expect(!jsonSuccess("not json"));
    try std.testing.expectEqualStrings("call_preview", radixMethod("/prefix/transaction/call-preview"));
    try std.testing.expectEqualStrings("SmartContractState", grpcMethod("/cosmwasm.wasm.v1.Query/SmartContractState"));
    try std.testing.expectEqualStrings("transaction_confirmed", aleoMethod("/proxy/testnet/transaction/confirmed/secret-id"));
}

test "RPC metric actual native and pooled completions count physical successes and failures once" {
    const fixture = @import("../evm/pool_testing.zig");
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":3,\"message\":\"execution reverted\"}}" } };
    const behaviors = [_]fixture.Behavior{.{ .replies = &replies }};
    var server = try fixture.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try Recorder.init(a, registry, .{ .chain = "native", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{url});
    var client = try curl.Client.init(a, library);
    defer client.deinit();
    client.observer = recorder.nativeObserver();
    var response = try client.send(a, .{ .url = url, .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}" });
    response.deinit();
    const runtime = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} }, .observer = recorder.poolObserver(), .max_response_bytes = 1024, .max_reserved_bytes = 4 * 1024 * 1024 });
    defer runtime.deinit();
    const failed = try runtime.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}", 2000, 1000, null, 1024);
    a.free(failed.bytes);
    // Physical method is copied from owned session while observer runs; failure
    // envelope is returned normally but labels remain status=failure.
    const failed_again = try runtime.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}", 2000, 1000, null, 1024);
    a.free(failed_again.bytes);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "status=\"success\",rpc_role=\"primary\",operation=\"contract_sync\",agent=\"scraper\",hyperlane_baselib_version=\"3.0.0\"} 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "status=\"failure\",rpc_role=\"primary\",operation=\"contract_sync\",agent=\"scraper\",hyperlane_baselib_version=\"3.0.0\"} 2") != null);
    try server.check();
    try std.testing.expectEqual(@as(u64, 0), recorder.failures.load(.monotonic));
}

test "RPC metric descriptions survive request destruction and gRPC status preserves failure" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try Recorder.init(a, registry, .{ .chain = "cosmos", .role = .quorum, .operation = .validator_checkpoint });
    defer recorder.deinit();
    try recorder.addEndpoints(&.{"https://private:credential@node.example/base?api_key=hidden"});
    var method: [128]u8 = undefined;
    const description = blk: {
        const request_url = try a.dupe(u8, "https://node.example/base/cosmwasm.wasm.v1.Query/SmartContractState");
        defer a.free(request_url);
        break :blk recorder.describe(.{ .url = request_url, .method = .post, .require_http2 = true, .body = "sensitive encoded query" }, &method) orelse return error.MissingDescription;
    };
    try std.testing.expectEqualStrings("node.example:443", description.host);
    try std.testing.expectEqualStrings("SmartContractState", description.method);
    var response: curl.Response = .{ .allocator = a, .status = 200, .http_version = 3, .body = &.{}, .headers = &.{.{ .name = "grpc-status", .value = "0" }}, .header_storage = &.{} };
    try std.testing.expect(recorder.responseSuccess(description, &response));
    response.headers = &.{.{ .name = "grpc-status", .value = "5" }};
    try std.testing.expect(!recorder.responseSuccess(description, &response));
    response.headers = &.{};
    try std.testing.expect(!recorder.responseSuccess(description, &response));
    // No callback or series for non-configured hosts, and no cancelled-transfer
    // count. This also keeps endpoint credentials out of metadata/KMS metrics.
    try std.testing.expect(recorder.describe(.{ .url = "https://elsewhere.example/private", .method = .get }, &method) == null);
    recorder.recordNative(.{ .request = .{ .url = "https://node.example", .method = .get }, .failure = error.RequestCancelled, .duration_ns = 100 });
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expectEqualStrings("", text);
}

test "RPC metric actual fallback observes block probes as distinct physical methods" {
    const fixture = @import("../evm/pool_testing.zig");
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const ok = [_]fixture.Reply{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x10\"}" }};
    const temporary = [_]fixture.Reply{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}" }};
    const behaviors = [_]fixture.Behavior{ .{ .replies = &temporary, .probe_replies = &ok }, .{ .replies = &ok, .probe_replies = &ok } };
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const urls = [_][]const u8{ try server.url(a, 0), try server.url(a, 1) };
    defer for (urls) |url| a.free(url);
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try Recorder.init(a, registry, .{ .chain = "fallback", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&urls);
    const runtime = try pool.Pool.start(a, .{ .library_path = library, .urls = &urls, .strategy = .{ .fallback = .{ .max_block_time_ms = 0 } }, .observer = recorder.poolObserver(), .max_response_bytes = 1024, .max_reserved_bytes = 4 * 1024 * 1024 });
    defer runtime.deinit();
    std.Thread.sleep(3 * std.time.ns_per_ms);
    const result = try runtime.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}", 2000, 1000, null, 1024);
    a.free(result.bytes);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "method=\"eth_blockNumber\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "method=\"eth_call\",status=\"failure\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "method=\"eth_call\",status=\"success\"") != null);
    try std.testing.expect(server.probeHits(0) > 0);
    try server.check();
}

test "RPC metric immutable scoped operation replaces default once and survives cancellation retirement" {
    const fixture = @import("../evm/pool_testing.zig");
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}" }, .{ .body = "", .stall = true } };
    const behaviors = [_]fixture.Behavior{.{ .replies = &replies }};
    var server = try fixture.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try Recorder.init(a, registry, .{ .chain = "scoped", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{url});
    const runtime = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .max_response_bytes = 1024, .max_reserved_bytes = 4 * 1024 * 1024 });
    var destroyed = false;
    defer if (!destroyed) runtime.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}";
    var scope = try recorder.poolObserverFor(.relayer_metadata);
    defer scope.deinit();
    const first = try runtime.submitObserved(body, 2000, 1000, 1024, scope.observer);
    // Release scope immediately while native callback context remains retained.
    scope.deinit();
    var timer = try std.time.Timer.start();
    while (true) {
        if (try runtime.poll(first, a)) |response| {
            a.free(response.bytes);
            break;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.ScopeReadTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const normal = try runtime.fetch(a, body, 2000, 1000, null, 1024);
    a.free(normal.bytes);
    var cancelled = try recorder.poolObserverFor(.relayer_delivery);
    defer cancelled.deinit();
    const last = try runtime.submitObserved(body, 2000, 1000, 1024, cancelled.observer);
    while (server.acceptedCount() < 3) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.ScopeReadTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    runtime.cancel(last);
    cancelled.deinit();
    // Drain late native completions before inspecting/finally freeing registry.
    runtime.deinit();
    destroyed = true;
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "operation=\"relayer_metadata\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "operation=\"contract_sync\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "operation=\"relayer_delivery\"") == null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, text, "\nhyperlane_request_count{"));
    try std.testing.expectEqual(@as(usize, 1), recorder.references.load(.acquire));
    try server.check();
}
