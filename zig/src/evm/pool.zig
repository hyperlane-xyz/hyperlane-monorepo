//! Persistent owner-thread EVM JSON-RPC pool over bounded native curl multi.
//! Endpoint URLs and headers are never logged. Exact request bytes are multicast
//! for raw transactions; every response is bound to JSON-RPC 2.0 and request ID.
const std = @import("std");
const multi = @import("../net/curl_multi.zig");
const curl = @import("../net/curl.zig");
const endpoint = @import("../net/endpoint.zig");
const A = std.mem.Allocator;
const Value = std.json.Value;
const tip_cache = @import("../net/dynamic_tip_cache.zig");
const json_bounds = @import("../net/json_bounds.zig");

pub const WireResponse = struct { bytes: []u8, len: usize };
/// One caller owns a handle. Terminal poll or cancel consumes it. The pool owns
/// the cancellation token and all request bytes through native completion drain.
pub const Handle = struct { id: u64 };
pub const HedgeConfig = struct { delay_ms: u32, attempt_timeout_ms: u32 };
pub const SingleConfig = struct { max_attempts: u8 = 6, retry_delay_ms: u32 = 50 };
pub const FallbackConfig = struct {
    hedge: ?HedgeConfig = null,
    /// Optional physical bound for each endpoint, independent of the caller's
    /// aggregate session deadline. Null retains the original request budget.
    attempt_timeout_ms: ?u32 = null,
    consider_null_transaction_receipt: bool = false,
    retry_delay_ms: u32 = 100,
    max_block_time_ms: u32 = 120_000,
    probe_timeout_ms: u32 = 30_000,
    failed_request_threshold: u32 = 10,
};
pub const Clock = struct {
    context: *anyopaque,
    now_ms_fn: *const fn (*anyopaque) u64,
};
pub const Entropy = struct {
    context: *anyopaque,
    between_fn: *const fn (*anyopaque, u32, u32) u32,
};
pub const Operation = enum { read, raw_transaction, block_number_probe };
pub const EventKind = enum {
    upstream_completed,
    provider_created,
    provider_dropped,
    cache_logical_read,
    cache_hit,
    cache_upstream_read,
    cache_upstream_error,
    request_started,
    request_succeeded,
    request_failed,
    hedge_started,
    hedge_cancelled,
    attempt_timed_out,
    provider_failed,
    provider_deprioritized,
    probe_started,
    probe_succeeded,
    probe_timed_out,
    rate_limited,
    cooldown_wait,
    cooldown_jitter,
};
pub const Event = struct {
    kind: EventKind,
    /// Bounded sanitized method, borrowed only until observer callback returns.
    method: []const u8 = "",
    success: bool = false,
    hedged: bool = false,
    cancelled: bool = false,
    operation: Operation = .read,
    session_id: u64 = 0,
    endpoint_index: ?u16 = null,
    speculative: bool = false,
    failed_count: u32 = 0,
    previous_block_height: u64 = 0,
    block_height: u64 = 0,
    deadline_ms: u64 = 0,
    duration_ms: u64 = 0,
    duration_ns: u64 = 0,
};
/// Fixed-size events emitted only on the owner thread. The callback must return
/// promptly and must not call back into Pool. No secret-bearing slices are exposed.
pub const Observer = struct {
    context: *anyopaque,
    event_fn: *const fn (*anyopaque, Event) void,
    retain_fn: ?*const fn (*anyopaque) void = null,
    release_fn: ?*const fn (*anyopaque) void = null,
    pub fn retain(self: Observer) void {
        if (self.retain_fn) |call| call(self.context);
    }
    pub fn release(self: Observer) void {
        if (self.release_fn) |call| call(self.context);
    }
    fn valid(self: Observer) bool {
        return (self.retain_fn == null) == (self.release_fn == null);
    }
};
pub const QuorumConfig = struct {
    /// Zero selects ethers' ceiling majority. Explicit values are provider counts.
    threshold: usize = 0,
    max_attempts: u8 = 5,
    retry_delay_ms: u32 = 1000,
    dynamic_tag_grace_floor_ms: u32 = 1000,
};
pub const Strategy = union(enum) { single: SingleConfig, fallback: FallbackConfig, quorum: QuorumConfig };
pub const HeightProtocol = enum { ethereum, sealevel, tendermint };
pub const Config = struct {
    library_path: []const u8,
    urls: []const []const u8,
    strategy: Strategy = .{ .fallback = .{} },
    max_sessions: u16 = 32,
    max_concurrent: u16 = 256,
    max_pending: u16 = 1024,
    max_response_bytes: usize = 8 * 1024 * 1024,
    max_request_bytes: usize = 1024 * 1024,
    max_reserved_bytes: usize = 64 * 1024 * 1024,
    clock: ?Clock = null,
    entropy: ?Entropy = null,
    observer: ?Observer = null,
    height_protocol: HeightProtocol = .ethereum,
    dynamic_tip_cache: ?*tip_cache.Cache = null,
};
pub fn boundedMethod(method: []const u8) []const u8 {
    if (method.len == 0 or method.len > 128) return "unknown";
    for (method) |c| if (!std.ascii.isAlphanumeric(c) and c != '_' and c != '.') return "unknown";
    return method;
}

/// Ethereum Source categorizes HttpClientError::SerdeJson as retryable. Mark
/// errors only where an upstream wire response is decoded, rather than treating
/// arbitrary parser errors from config/storage/business logic as retryable.
/// Control, allocation, bounds and strict response-ID refusals stay distinct.
pub fn responseDecodeError(protocol: HeightProtocol, err: anyerror) anyerror {
    if (protocol != .ethereum) return err;
    return switch (err) {
        error.SyntaxError,
        error.UnexpectedEndOfInput,
        error.UnexpectedToken,
        error.DuplicateField,
        error.InvalidRpcEnvelope,
        => error.RpcResponseDecode,
        else => err,
    };
}

pub const Classification = enum { success, retryable, rate_limited, non_retryable, cooldown };

const Endpoint = struct {
    owned: endpoint.OwnedEndpoint,
    headers: []curl.Header,
    failed_count: u32 = 0,
    last_block_height: u64 = 0,
    last_block_time_ms: u64 = 0,
    cooldown_until_ms: u64 = 0,
    fn deinit(self: *Endpoint, allocator: A) void {
        allocator.free(self.headers);
        self.owned.deinit();
    }
};

const Request = struct {
    body: []u8,
    parsed: std.json.Parsed(Value),
    method: []const u8,
    id: i64,
    params: Value,

    fn parse(allocator: A, body: []const u8, max_bytes: usize) !Request {
        if (body.len == 0 or body.len > max_bytes) return error.InvalidRpcRequest;
        try json_bounds.validate(body);
        const owned = try allocator.dupe(u8, body);
        errdefer allocator.free(owned);
        var parsed = try std.json.parseFromSlice(Value, allocator, owned, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = max_bytes });
        errdefer parsed.deinit();
        if (parsed.value != .object) return error.InvalidRpcRequest;
        const object = parsed.value.object;
        const version = object.get("jsonrpc") orelse return error.InvalidRpcRequest;
        if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return error.InvalidRpcRequest;
        const id_value = object.get("id") orelse return error.InvalidRpcRequest;
        if (id_value != .number_string) return error.InvalidRpcRequest;
        const id = std.fmt.parseInt(i64, id_value.number_string, 10) catch return error.InvalidRpcRequest;
        const method = object.get("method") orelse return error.InvalidRpcRequest;
        if (method != .string or method.string.len == 0) return error.InvalidRpcRequest;
        const params = object.get("params") orelse Value{ .array = std.json.Array.init(allocator) };
        return .{ .body = owned, .parsed = parsed, .method = method.string, .id = id, .params = params };
    }

    fn fromParts(allocator: A, id: i64, method: []const u8, params: Value, max_bytes: usize) !Request {
        const body = try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = params }, .{});
        defer allocator.free(body);
        return parse(allocator, body, max_bytes);
    }

    fn deinit(self: *Request, allocator: A) void {
        self.parsed.deinit();
        allocator.free(self.body);
        self.* = undefined;
    }
};

const ParsedResponse = struct {
    bytes: []u8,
    parsed: std.json.Parsed(Value),
    result: ?Value,
    rpc_error: ?Value,
    reserved_bytes: usize,
    charged: bool = false,

    fn parse(allocator: A, body: []const u8, expected_id: i64, max_bytes: usize) !ParsedResponse {
        if (body.len > max_bytes) return error.ResponseTooLarge;
        try json_bounds.validate(body);
        const bytes = try allocator.dupe(u8, body);
        errdefer allocator.free(bytes);
        var parsed = try std.json.parseFromSlice(Value, allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = max_bytes });
        errdefer parsed.deinit();
        if (parsed.value != .object) return error.InvalidRpcEnvelope;
        const object = parsed.value.object;
        const version = object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
        if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return error.InvalidRpcEnvelope;
        const id = object.get("id") orelse return error.InvalidRpcEnvelope;
        if (id != .number_string) return error.RpcIdMismatch;
        const actual_id = std.fmt.parseInt(i64, id.number_string, 10) catch return error.RpcIdMismatch;
        if (actual_id != expected_id) return error.RpcIdMismatch;
        const has_result = object.contains("result");
        const has_error = object.contains("error");
        if (has_result == has_error) return error.InvalidRpcEnvelope;
        if (has_error) {
            const rpc_error = object.get("error").?;
            if (rpc_error != .object) return error.InvalidRpcEnvelope;
            const code = rpc_error.object.get("code") orelse return error.InvalidRpcEnvelope;
            const message = rpc_error.object.get("message") orelse return error.InvalidRpcEnvelope;
            if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
            _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
        }
        return .{ .bytes = bytes, .parsed = parsed, .result = if (has_result) object.get("result").? else null, .rpc_error = if (has_error) object.get("error").? else null, .reserved_bytes = bytes.len + parsed.arena.queryCapacity() };
    }

    fn deinit(self: *ParsedResponse, allocator: A) void {
        self.parsed.deinit();
        allocator.free(self.bytes);
        self.* = undefined;
    }

    fn takeBytes(self: *ParsedResponse, allocator: A) []u8 {
        self.parsed.deinit();
        const bytes = self.bytes;
        self.* = undefined;
        _ = allocator;
        return bytes;
    }
};

const Outcome = struct {
    // An expected business error remains an RPC-error diagnostic, but cannot
    // penalize a reachable provider or trip its transport circuit.
    expected_absence: bool = false,
    svm_unresolvable: bool = false,
    classification: Classification,
    failure: ?anyerror = null,
    response: ?ParsedResponse = null,

    fn deinit(self: *Outcome, allocator: A) void {
        if (self.response) |*response| response.deinit(allocator);
        self.* = undefined;
    }
};

const Probe = struct {
    cache_owner: ?*tip_cache.Cache = null,
    cache_ticket: ?tip_cache.Ticket = null,
    cache_follower: bool = false,
    cache_checked: bool = false,
    cache_result: ?[]u8 = null,
    observer: ?Observer = null,
    endpoint_index: usize,
    native_id: ?multi.Id = null,
    deadline_ms: u64,
    started_ms: u64 = 0,
    started_at: ?std.time.Instant = null,
    submitted: bool = false,
    cancelled: bool = false,
    session: ?*Session = null,
    outcome: ?Outcome = null,

    fn deinit(self: *Probe, allocator: A) void {
        if (!self.cache_follower) if (self.cache_ticket) |ticket| if (self.cache_owner) |cache| cache.finish(ticket, null);
        if (self.cache_result) |result| allocator.free(result);
        if (self.outcome) |*outcome| outcome.deinit(allocator);
        if (self.observer) |observer| observer.release();
        allocator.destroy(self);
    }
};

const Phase = enum { actual, latest, dynamic };
const Peer = struct {
    cache_checked: bool = false,
    cache_eligible: bool = false,
    cache_follower: bool = false,
    cache_upstream_reported: bool = false,
    cache_ticket: ?tip_cache.Ticket = null,
    native_id: ?multi.Id = null,
    done: bool = false,
    failed: bool = false,
    skip: bool = false,
    attempts: u8 = 0,
    next_attempt_ms: u64 = 0,
    started_ms: u64 = 0,
    started_at: ?std.time.Instant = null,
    failed_count_snapshot: u32 = 0,
    block_time_snapshot: u64 = 0,
    cooldown_waited: bool = false,
    speculative: bool = false,
    response: ?ParsedResponse = null,
    votes: usize = 0,
    number: ?u256 = null,
};

const Session = struct {
    indexer_tip_cache: bool = false,
    observer: ?Observer = null,
    allocator: A,
    id: u64,
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    closed: std.atomic.Value(bool) = .init(false),
    original: Request,
    current: ?Request = null,
    phase: Phase = .actual,
    block_parameter_index: usize = 0,
    pinned_tag: ?[]u8 = null,
    peers: []Peer,
    order: []usize,
    strategy: Strategy,
    started_ms: u64,
    started_at: ?std.time.Instant = null,
    terminal_rpc_error: bool = false,
    // One quota-charged original error, never a synthetic skipped-slot result.
    // Sticky false after any unknown/transport/health failure in this session.
    all_svm_failures_unresolvable: bool = true,
    svm_unresolvable_response: ?ParsedResponse = null,
    phase_started_ms: u64,
    deadline_ms: u64,
    connect_timeout_ms: u32,
    max_response_bytes: usize,
    max_request_bytes: usize,
    next_peer: usize = 0,
    retry_errors: usize = 0,
    round: usize = 0,
    round_wait_ms: u64 = 0,
    grace_deadline_ms: u64 = 0,
    refill_hedge: bool = false,
    numeric_quorum_ms: ?u64 = null,
    numeric_grace_deadline_ms: u64 = 0,
    restart_number: ?u256 = null,
    saw_non_retryable: bool = false,
    deferred_winner: ?[]u8 = null,
    winner: ?[]u8 = null,
    winner_speculative: bool = false,
    waiting_probe: bool = false,
    reported_start: bool = false,
    failure: ?anyerror = null,
    finished: bool = false,
    taken: std.atomic.Value(bool) = .init(false),

    fn wire(self: *Session) *Request {
        return if (self.current) |*current| current else &self.original;
    }

    fn deinit(self: *Session) void {
        const allocator = self.allocator;
        for (self.peers) |*peer| if (peer.response) |*response| response.deinit(allocator);
        if (self.svm_unresolvable_response) |*response| response.deinit(allocator);
        if (self.current) |*current| current.deinit(allocator);
        self.original.deinit(allocator);
        if (self.pinned_tag) |tag| allocator.free(tag);
        if (self.deferred_winner) |bytes| allocator.free(bytes);
        if (self.winner) |bytes| allocator.free(bytes);
        allocator.free(self.order);
        allocator.free(self.peers);
        if (self.observer) |observer| observer.release();
        allocator.destroy(self);
    }
};

pub const Pool = struct {
    allocator: A,
    config: Config,
    endpoints: []Endpoint,
    threshold: usize,
    native: *multi.Multi,
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    sessions: []?*Session,
    priorities: []usize,
    probes: []?*Probe,
    next_session_id: std.atomic.Value(u64) = .init(1),
    retained_bytes: usize = 0,
    stopping: std.atomic.Value(bool) = .init(false),
    thread: std.Thread,
    started: std.time.Instant,

    /// Allocator must be thread-safe. All endpoint identities are parsed and
    /// deduplicated before the fixed quorum denominator is selected.
    pub fn start(allocator: A, config: Config) !*Pool {
        if (config.observer) |observer| if (!observer.valid()) return error.InvalidRpcObserver;
        if (config.urls.len == 0 or config.urls.len > 256 or config.max_sessions == 0 or config.max_sessions > 128 or config.max_response_bytes == 0 or config.max_request_bytes == 0) return error.InvalidRpcPoolConfig;
        const self = try allocator.create(Pool);
        errdefer allocator.destroy(self);
        var endpoints: std.ArrayList(Endpoint) = .empty;
        errdefer {
            for (endpoints.items) |*item| item.deinit(allocator);
            endpoints.deinit(allocator);
        }
        for (config.urls) |url| {
            var owned = endpoint.OwnedEndpoint.parse(allocator, url) catch |err| {
                if (err == error.OutOfMemory) return err;
                return error.InvalidRpcEndpoint;
            };
            var duplicate = false;
            for (endpoints.items) |existing| if (std.mem.eql(u8, existing.owned.identity, owned.identity)) {
                duplicate = true;
                break;
            };
            if (duplicate) {
                owned.deinit();
                continue;
            }
            errdefer owned.deinit();
            var headers: std.ArrayList(curl.Header) = .empty;
            errdefer headers.deinit(allocator);
            try headers.appendSlice(allocator, &.{
                .{ .name = "content-type", .value = "application/json" },
                .{ .name = "accept-encoding", .value = "identity" },
                .{ .name = "user-agent", .value = "hyperlane-zig/0.1.0" },
            });
            for (owned.endpoint.headers) |header| {
                var replaced = false;
                for (headers.items) |*existing| if (std.ascii.eqlIgnoreCase(existing.name, header.name)) {
                    existing.* = .{ .name = header.name, .value = header.value };
                    replaced = true;
                    break;
                };
                if (!replaced) try headers.append(allocator, .{ .name = header.name, .value = header.value });
            }
            const native_headers = try headers.toOwnedSlice(allocator);
            errdefer allocator.free(native_headers);
            try endpoints.append(allocator, .{ .owned = owned, .headers = native_headers });
        }
        if (endpoints.items.len == 0) return error.EmptyRpcEndpointPool;
        const threshold = switch (config.strategy) {
            .single => blk: {
                if (endpoints.items.len != 1) return error.SingleRpcEndpointRequired;
                break :blk 1;
            },
            .fallback => 1,
            .quorum => |quorum| blk: {
                const selected = if (quorum.threshold == 0) endpoints.items.len / 2 + endpoints.items.len % 2 else quorum.threshold;
                if (selected == 0 or selected > endpoints.items.len) return error.ImpossibleRpcQuorum;
                if (quorum.max_attempts == 0) return error.InvalidRpcPoolConfig;
                break :blk selected;
            },
        };
        switch (config.strategy) {
            .single => |single| if (single.max_attempts == 0) return error.InvalidRpcPoolConfig,
            .fallback => |fallback| {
                if (fallback.failed_request_threshold == 0 or fallback.probe_timeout_ms == 0) return error.InvalidRpcPoolConfig;
                if (fallback.attempt_timeout_ms) |timeout| if (timeout == 0 or timeout > 300000) return error.InvalidRpcPoolConfig;
                if (fallback.hedge) |hedge| if (hedge.delay_ms == 0 or hedge.attempt_timeout_ms == 0) return error.InvalidRpcPoolConfig;
            },
            .quorum => {},
        }
        const native = try multi.Multi.init(allocator, .{
            .library_path = config.library_path,
            .max_concurrent = config.max_concurrent,
            .max_pending = config.max_pending,
            .max_response_bytes = config.max_response_bytes,
            .max_request_bytes = config.max_request_bytes,
            .max_reserved_bytes = config.max_reserved_bytes,
        });
        errdefer native.deinit();
        const sessions = try allocator.alloc(?*Session, config.max_sessions);
        errdefer allocator.free(sessions);
        @memset(sessions, null);
        const priorities = try allocator.alloc(usize, endpoints.items.len);
        errdefer allocator.free(priorities);
        const probes = try allocator.alloc(?*Probe, endpoints.items.len);
        errdefer allocator.free(probes);
        @memset(probes, null);
        const started = try std.time.Instant.now();
        self.* = .{
            .allocator = allocator,
            .config = config,
            .endpoints = try endpoints.toOwnedSlice(allocator),
            .threshold = threshold,
            .native = native,
            .sessions = sessions,
            .priorities = priorities,
            .probes = probes,
            .thread = undefined,
            .started = started,
        };
        errdefer {
            for (self.endpoints) |*item| item.deinit(allocator);
            allocator.free(self.endpoints);
            allocator.free(self.priorities);
            allocator.free(self.probes);
        }
        for (self.priorities, 0..) |*priority, index| priority.* = index;
        for (self.endpoints) |*item| item.last_block_time_ms = self.now();
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        for (self.endpoints, 0..) |_, index| self.emit(.{ .kind = .provider_created, .endpoint_index = @intCast(index) });
        return self;
    }

    /// Call after every fetch/async handle caller has returned. Stops new work, cancels all
    /// native transfers, drains completions, then retires the sole owner thread.
    pub fn deinit(self: *Pool) void {
        self.stopping.store(true, .release);
        self.mutex.lock();
        for (self.sessions) |entry| if (entry) |session| session.closed.store(true, .release);
        self.wake.broadcast();
        self.mutex.unlock();
        self.thread.join();
        for (self.sessions) |entry| if (entry) |session| self.destroySession(session);
        std.debug.assert(self.retained_bytes == 0);
        for (self.probes) |entry| if (entry) |probe| probe.deinit(self.allocator);
        self.native.deinit();
        for (self.endpoints, 0..) |*item, index| {
            self.emit(.{ .kind = .provider_dropped, .endpoint_index = @intCast(index) });
            item.deinit(self.allocator);
        }
        self.allocator.free(self.endpoints);
        self.allocator.free(self.sessions);
        self.allocator.free(self.priorities);
        self.allocator.free(self.probes);
        const allocator = self.allocator;
        allocator.destroy(self);
    }

    fn now(self: *Pool) u64 {
        if (self.config.clock) |clock| return clock.now_ms_fn(clock.context);
        return (std.time.Instant.now() catch self.started).since(self.started) / std.time.ns_per_ms;
    }

    fn randomBetween(self: *Pool, minimum: u32, maximum: u32) u32 {
        if (self.config.entropy) |entropy| return entropy.between_fn(entropy.context, minimum, maximum);
        if (minimum == maximum) return minimum;
        return minimum + std.crypto.random.uintLessThan(u32, maximum - minimum + 1);
    }

    fn emit(self: *Pool, original: Event) void {
        if (self.config.observer) |observer| emitObserved(observer, original);
    }
    fn emitSession(_: *Pool, session: *Session, original: Event) void {
        if (session.observer) |observer| emitObserved(observer, original);
    }
    fn isHedged(session: *const Session) bool {
        return session.strategy == .fallback and session.strategy.fallback.hedge != null and hedgeable(session.original.method, session.original.params);
    }
    fn emitObserved(observer: Observer, original: Event) void {
        var event = original;
        if (event.method.len != 0) event.method = boundedMethod(event.method);
        observer.event_fn(observer.context, event);
    }
    fn reportUpstream(self: *Pool, session: *Session, index: usize, success: bool, cancelled: bool) void {
        const observer = session.observer orelse return;
        emitObserved(observer, .{ .kind = .upstream_completed, .method = session.wire().method, .success = success, .cancelled = cancelled, .operation = if (isRawSend(session.wire().method)) .raw_transaction else .read, .session_id = session.id, .endpoint_index = @intCast(index), .speculative = session.peers[index].speculative, .duration_ms = self.now() -| session.peers[index].started_ms, .duration_ns = elapsedNs(session.peers[index].started_at, self.now() -| session.peers[index].started_ms) });
    }

    fn retainResponse(self: *Pool, response: *ParsedResponse) !void {
        std.debug.assert(!response.charged);
        const used = self.native.reserved_bytes +| self.retained_bytes;
        if (response.reserved_bytes > self.config.max_reserved_bytes -| used) return error.RpcPoolByteBudgetExceeded;
        self.retained_bytes += response.reserved_bytes;
        response.charged = true;
    }

    fn releaseResponse(self: *Pool, response: *ParsedResponse) void {
        if (!response.charged) return;
        self.retained_bytes -= response.reserved_bytes;
        response.charged = false;
    }

    fn destroyResponse(self: *Pool, response: *ParsedResponse) void {
        self.releaseResponse(response);
        response.deinit(self.allocator);
    }

    fn destroySession(self: *Pool, session: *Session) void {
        for (session.peers) |*peer| if (peer.response) |*response| self.releaseResponse(response);
        if (session.svm_unresolvable_response) |*response| self.releaseResponse(response);
        session.deinit();
    }

    /// Immutable sensitive endpoint identity comparison; no URL is emitted.
    pub fn matchesEndpoints(self: *const Pool, allocator: A, urls: []const []const u8) !bool {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var identities: std.StringHashMapUnmanaged(void) = .empty;
        var count: usize = 0;
        for (urls) |url| {
            const owned = try endpoint.OwnedEndpoint.parse(a, url);
            if (identities.contains(owned.identity)) continue;
            try identities.put(a, owned.identity, {});
            if (count >= self.endpoints.len or !std.mem.eql(u8, self.endpoints[count].owned.identity, owned.identity)) return false;
            count += 1;
        }
        return count == self.endpoints.len;
    }

    pub fn endpointCount(self: *Pool) usize {
        return self.endpoints.len;
    }

    /// Returned bytes belong to the caller's allocator. No worker thread is
    /// created per request or peer. Cancellation closes native transfers without
    /// waiting on a blocking DNS/connect/read worker.
    pub fn submit(self: *Pool, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize) !Handle {
        return self.submitObserved(body, timeout_ms, connect_timeout_ms, max_response_bytes, null);
    }
    /// Overrides only physical observations; it replaces, never duplicates, the
    /// Config observer. Retained until all native sessions/probes really drain.
    pub fn submitObserved(self: *Pool, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer) !Handle {
        return self.submitObservedCached(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, false);
    }
    pub fn submitObservedCached(self: *Pool, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool) !Handle {
        if (observer_override) |observer| if (!observer.valid()) return error.InvalidRpcObserver;
        if (timeout_ms == 0 or connect_timeout_ms == 0 or max_response_bytes == 0 or max_response_bytes > self.config.max_response_bytes) return error.InvalidRpcLimit;
        const session = blk: {
            var original = try Request.parse(self.allocator, body, self.config.max_request_bytes);
            errdefer original.deinit(self.allocator);
            const session = try self.allocator.create(Session);
            errdefer self.allocator.destroy(session);
            const peers = try self.allocator.alloc(Peer, self.endpoints.len);
            errdefer self.allocator.free(peers);
            @memset(peers, .{});
            const order = try self.allocator.alloc(usize, self.endpoints.len);
            errdefer self.allocator.free(order);
            const started = self.now();
            session.* = .{
                .allocator = self.allocator,
                .indexer_tip_cache = use_tip_cache and self.config.height_protocol == .ethereum,
                .id = self.next_session_id.fetchAdd(1, .acq_rel),
                .original = original,
                .peers = peers,
                .order = order,
                .strategy = self.config.strategy,
                .started_ms = started,
                .started_at = if ((observer_override != null or self.config.observer != null) and self.config.clock == null) std.time.Instant.now() catch null else null,
                .phase_started_ms = started,
                .deadline_ms = started +| timeout_ms,
                .connect_timeout_ms = connect_timeout_ms,
                .max_response_bytes = max_response_bytes,
                .max_request_bytes = self.config.max_request_bytes,
            };
            if (self.config.strategy == .quorum) self.preparePreflight(session) catch |err| {
                if (session.current) |*current| current.deinit(self.allocator);
                return err;
            };
            session.observer = observer_override orelse self.config.observer;
            if (session.observer) |observer| observer.retain();
            break :blk session;
        };
        self.mutex.lock();
        if (self.stopping.load(.acquire)) {
            self.mutex.unlock();
            session.deinit();
            return error.RpcPoolStopped;
        }
        const slot = for (self.sessions, 0..) |entry, index| {
            if (entry == null) break index;
        } else {
            self.mutex.unlock();
            session.deinit();
            return error.RpcPoolSessionsFull;
        };
        self.sessions[slot] = session;
        self.wake.signal();
        self.mutex.unlock();

        return .{ .id = session.id };
    }
    /// Nonblocking with respect to network I/O. A terminal result (including
    /// allocation failure while copying) consumes the handle exactly once.
    pub fn poll(self: *Pool, handle: Handle, allocator: A) !?WireResponse {
        self.mutex.lock();
        const session = self.findSession(handle) orelse {
            self.mutex.unlock();
            return error.InvalidRpcHandle;
        };
        session.mutex.lock();
        if (!session.finished) {
            session.mutex.unlock();
            self.mutex.unlock();
            return null;
        }
        const failure = session.failure;
        const winner = session.winner;
        session.winner = null;
        session.taken.store(true, .release);
        session.mutex.unlock();
        self.wake.signal();
        self.mutex.unlock();
        if (failure) |err| return err;
        const bytes = winner orelse return error.MissingRpcPoolResult;
        defer self.allocator.free(bytes);
        const copied = try allocator.dupe(u8, bytes);
        return .{ .bytes = copied, .len = copied.len };
    }
    /// No borrowed caller token survives cancellation. This consumes the handle;
    /// cancel is idempotent, including after terminal poll or slot retirement.
    pub fn cancel(self: *Pool, handle: Handle) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.findSession(handle) orelse return;
        session.closed.store(true, .release);
        session.taken.store(true, .release);
        self.wake.signal();
    }
    /// Caller holds Pool.mutex; consumed handles are never handed back.
    fn findSession(self: *Pool, handle: Handle) ?*Session {
        for (self.sessions) |entry| if (entry) |session| {
            if (session.id == handle.id and !session.taken.load(.acquire)) return session;
        };
        return null;
    }
    pub fn fetch(self: *Pool, allocator: A, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, cancel_flag: ?*const std.atomic.Value(bool), max_response_bytes: usize) !WireResponse {
        return self.fetchObserved(allocator, body, timeout_ms, connect_timeout_ms, cancel_flag, max_response_bytes, null);
    }
    pub fn fetchObserved(self: *Pool, allocator: A, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, cancel_flag: ?*const std.atomic.Value(bool), max_response_bytes: usize, observer_override: ?Observer) !WireResponse {
        return self.fetchObservedCached(allocator, body, timeout_ms, connect_timeout_ms, cancel_flag, max_response_bytes, observer_override, false);
    }
    pub fn fetchObservedCached(self: *Pool, allocator: A, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, cancel_flag: ?*const std.atomic.Value(bool), max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool) !WireResponse {
        if (cancel_flag) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const handle = try self.submitObservedCached(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache);
        defer self.cancel(handle);
        const deadline_ms = self.now() +| timeout_ms;
        while (true) {
            if (try self.poll(handle, allocator)) |response| return response;
            if (cancel_flag) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            if (self.now() >= deadline_ms) return error.RequestDeadlineExceeded;
            self.mutex.lock();
            const session = self.findSession(handle) orelse {
                self.mutex.unlock();
                return error.InvalidRpcHandle;
            };
            session.mutex.lock();
            self.mutex.unlock();
            // This handle has one caller, so taken remains false until it polls
            // or cancels. Owner cannot retire this session while waiting.
            if (!session.finished) session.wake.timedWait(&session.mutex, 5 * std.time.ns_per_ms) catch {};
            session.mutex.unlock();
        }
    }

    fn preparePreflight(self: *Pool, session: *Session) !void {
        const request = &session.original;
        const index = blockParameterIndex(request.method, request.params) orelse return;
        if (request.params != .array or index >= request.params.array.items.len) return;
        const tag = request.params.array.items[index];
        if (tag != .string) return;
        const kind: ?Phase = if (std.mem.eql(u8, tag.string, "latest")) .latest else if (std.mem.eql(u8, tag.string, "safe") or std.mem.eql(u8, tag.string, "finalized")) .dynamic else null;
        const phase = kind orelse return;
        session.phase = phase;
        session.block_parameter_index = index;
        if (phase == .latest) {
            session.current = try Request.fromParts(self.allocator, request.id, "eth_blockNumber", .{ .array = std.json.Array.init(self.allocator) }, session.max_request_bytes);
        } else {
            var params = std.json.Array.init(self.allocator);
            defer params.deinit();
            try params.append(tag);
            try params.append(.{ .bool = false });
            session.current = try Request.fromParts(self.allocator, request.id, "eth_getBlockByNumber", .{ .array = params }, session.max_request_bytes);
        }
        session.phase_started_ms = session.started_ms;
    }

    fn run(self: *Pool) void {
        while (true) {
            var snapshot: [128]?*Session = @splat(null);
            self.mutex.lock();
            for (self.sessions, snapshot[0..self.sessions.len]) |entry, *out| out.* = entry;
            self.mutex.unlock();
            const now_ms = self.now();
            _ = self.progressProbes(now_ms);
            for (snapshot[0..self.sessions.len]) |entry| if (entry) |session| {
                if (self.stopping.load(.acquire) and !session.finished) self.finish(session, error.RpcPoolStopped);
                if (session.closed.load(.acquire) and !session.finished) self.finish(session, if (self.stopping.load(.acquire)) error.RpcPoolStopped else error.RequestCancelled);
                if (!session.finished and now_ms >= session.deadline_ms) self.finish(session, error.RequestDeadlineExceeded);
                if (!session.finished) self.progress(session, now_ms) catch |err| self.finish(session, err);
            };
            while (self.native.poll(now_ms) catch |err| blk: {
                for (snapshot[0..self.sessions.len]) |entry| if (entry) |session| if (!session.finished) self.finish(session, err);
                break :blk null;
            }) |value| {
                var completion = value;
                defer completion.deinit();
                self.complete(snapshot[0..self.sessions.len], completion, now_ms);
            }
            self.mutex.lock();
            for (self.sessions) |*entry| if (entry.*) |session| {
                const drained = for (session.peers) |peer| {
                    if (peer.native_id != null) break false;
                } else true;
                if (drained and !session.waiting_probe and (session.taken.load(.acquire) or self.stopping.load(.acquire))) {
                    entry.* = null;
                    self.destroySession(session);
                }
            };
            const stopped = self.stopping.load(.acquire);
            const empty_sessions = for (self.sessions) |entry| {
                if (entry != null) break false;
            } else true;
            const empty_probes = for (self.probes) |entry| {
                if (entry != null) break false;
            } else true;
            const empty = empty_sessions and empty_probes;
            // Submit/cancel/shutdown signal this condition under the same
            // mutex. Recheck the live queue, not the earlier owner snapshot:
            // a submission between snapshot and wait must not lose its wake.
            if (empty and !stopped) self.wake.wait(&self.mutex) else if (!empty) self.wake.timedWait(&self.mutex, 2 * std.time.ns_per_ms) catch {};
            self.mutex.unlock();
            if (stopped and empty) return;
        }
    }

    fn complete(self: *Pool, sessions: []?*Session, completion: multi.Completion, now_ms: u64) void {
        for (self.probes, 0..) |entry, index| {
            const probe = entry orelse continue;
            const id = probe.native_id orelse continue;
            if (!std.meta.eql(id, completion.id)) continue;
            probe.native_id = null;
            self.finishProbe(index, completion.result, now_ms);
            return;
        }
        for (sessions) |entry| if (entry) |session| {
            for (session.peers, 0..) |*peer, index| {
                const id = peer.native_id orelse continue;
                if (!std.meta.eql(id, completion.id)) continue;
                peer.native_id = null;
                peer.done = true;
                if (session.finished or session.restart_number != null) {
                    self.cacheRelease(peer);
                    self.reportUpstream(session, index, false, true);
                    return;
                }
                switch (completion.result) {
                    .failure => |err| {
                        self.reportUpstream(session, index, false, err == error.RequestCancelled);
                        var outcome: Outcome = .{ .classification = .retryable, .failure = err };
                        self.dispatchOutcome(session, index, &outcome, now_ms);
                    },
                    .response => |response| {
                        if (response.status == 429) {
                            self.reportUpstream(session, index, false, false);
                            var outcome: Outcome = .{ .classification = .rate_limited, .failure = error.RpcRateLimited };
                            self.dispatchOutcome(session, index, &outcome, now_ms);
                            return;
                        }
                        if (self.config.height_protocol != .ethereum and (response.status < 200 or response.status >= 300)) {
                            self.reportUpstream(session, index, false, false);
                            var outcome: Outcome = .{ .classification = .retryable, .failure = error.RpcHttpStatus };
                            self.dispatchOutcome(session, index, &outcome, now_ms);
                            return;
                        }
                        var parsed = ParsedResponse.parse(self.allocator, response.body, session.wire().id, session.max_response_bytes) catch |err| {
                            self.reportUpstream(session, index, false, false);
                            if (err == error.OutOfMemory) {
                                self.finish(session, err);
                            } else {
                                var outcome: Outcome = .{ .classification = .retryable, .failure = responseDecodeError(self.config.height_protocol, err) };
                                self.dispatchOutcome(session, index, &outcome, now_ms);
                            }
                            return;
                        };
                        // A configured CometBFT destination must inspect this
                        // exact business absence before its first broadcast.
                        // Quorum keeps its existing error/vote behavior.
                        const expected_absence = self.config.height_protocol == .tendermint and session.strategy != .quorum and std.mem.eql(u8, session.wire().method, "tx") and if (parsed.rpc_error) |remote| @import("../cosmos/tx_absence.zig").matchesRequest(session.wire().params, remote) else false;
                        const classification = if (expected_absence) Classification.non_retryable else classify(session.wire().method, &parsed);
                        if (classification == .success and self.config.height_protocol == .ethereum) @import("header.zig").validateResult(session.wire().method, session.wire().params, parsed.result.?) catch |err| {
                            self.reportUpstream(session, index, false, false);
                            parsed.deinit(self.allocator);
                            var invalid: Outcome = .{ .classification = .retryable, .failure = err };
                            self.dispatchOutcome(session, index, &invalid, now_ms);
                            return;
                        };
                        const known_tip = std.mem.eql(u8, session.wire().method, "eth_blockNumber") or (self.config.height_protocol != .ethereum and std.mem.eql(u8, session.wire().method, "eth_getBlockByNumber"));
                        if (classification == .success and known_tip and !validTipResult(session.wire().method, parsed.result.?)) {
                            self.reportUpstream(session, index, false, false);
                            parsed.deinit(self.allocator);
                            var invalid: Outcome = .{ .classification = .retryable, .failure = error.InvalidRpcTipResult };
                            self.dispatchOutcome(session, index, &invalid, now_ms);
                            return;
                        }
                        self.reportUpstream(session, index, parsed.rpc_error == null, false);
                        const svm_unresolvable = classification == .retryable and self.config.height_protocol == .sealevel and session.strategy != .quorum and std.mem.eql(u8, session.wire().method, "getBlock") and if (parsed.rpc_error) |remote| svmUnresolvable(remote) else false;
                        var outcome: Outcome = .{ .classification = classification, .expected_absence = expected_absence, .svm_unresolvable = svm_unresolvable };
                        if (classification == .success or classification == .non_retryable) {
                            outcome.response = parsed;
                        } else {
                            outcome.failure = if (classification == .rate_limited) error.RpcRateLimited else error.RpcRemoteError;
                            if (svm_unresolvable and session.all_svm_failures_unresolvable and session.svm_unresolvable_response == null) {
                                self.retainResponse(&parsed) catch |err| {
                                    parsed.deinit(self.allocator);
                                    self.finish(session, err);
                                    return;
                                };
                                session.svm_unresolvable_response = parsed;
                            } else parsed.deinit(self.allocator);
                        }
                        self.dispatchOutcome(session, index, &outcome, now_ms);
                    },
                }
                return;
            }
        };
    }

    fn dispatchOutcome(self: *Pool, session: *Session, index: usize, outcome: *Outcome, now_ms: u64) void {
        const peer = &session.peers[index];
        if (peer.cache_eligible and peer.cache_upstream_reported) {
            var stored = false;
            if (outcome.classification == .success) if (outcome.response) |*response| if (response.result) |value| {
                if (validTipResult(session.wire().method, value)) {
                    if (peer.cache_ticket) |ticket| if (self.config.dynamic_tip_cache) |cache| {
                        const encoded = std.json.Stringify.valueAlloc(self.allocator, value, .{}) catch null;
                        if (encoded) |bytes| {
                            cache.finish(ticket, bytes);
                            self.allocator.free(bytes);
                            peer.cache_ticket = null;
                            stored = true;
                        }
                    };
                }
            };
            if (outcome.classification != .success) self.cacheEvent(session, index, .cache_upstream_error);
            if (!stored) self.cacheRelease(peer);
            peer.cache_checked = false;
            peer.cache_eligible = false;
            peer.cache_upstream_reported = false;
        }

        if (outcome.failure) |err| if (err == error.RequestDeadlineExceeded and session.strategy == .fallback and session.strategy.fallback.hedge != null) {
            self.emitSession(session, .{ .kind = .attempt_timed_out, .method = session.original.method, .hedged = isHedged(session), .session_id = session.id, .endpoint_index = @intCast(index), .speculative = session.peers[index].speculative });
        };
        if (outcome.classification == .rate_limited) self.penalize(index, session.id, now_ms);
        if (session.strategy == .fallback and !isRawSend(session.wire().method) and outcome.classification != .rate_limited and outcome.classification != .cooldown and self.endpoints[index].cooldown_until_ms <= now_ms) {
            const hedged = session.strategy.fallback.hedge != null and hedgeable(session.original.method, session.original.params);
            self.maybeStartProbe(session, index, if (hedged) null else outcome, now_ms) catch |err| {
                outcome.deinit(self.allocator);
                self.finish(session, err);
                return;
            };
            if (session.waiting_probe) return;
        }
        self.handleOutcome(session, index, outcome, now_ms);
    }

    fn handleOutcome(self: *Pool, session: *Session, index: usize, outcome: *Outcome, now_ms: u64) void {
        if (outcome.classification != .success and !outcome.svm_unresolvable) session.all_svm_failures_unresolvable = false;
        if (!outcome.expected_absence) self.recordOutcomeFailure(session, index, outcome.classification, now_ms);
        switch (outcome.classification) {
            .success => {
                var response = outcome.response orelse {
                    self.finish(session, error.MissingRpcPoolResult);
                    return;
                };
                outcome.response = null;
                self.peerSuccess(session, index, &response, now_ms) catch |err| {
                    response.deinit(self.allocator);
                    if (err == error.OutOfMemory or err == error.RpcPoolByteBudgetExceeded) self.finish(session, err) else self.peerFailure(session, index, err, .retryable, now_ms);
                };
            },
            .non_retryable => {
                var response = outcome.response orelse {
                    self.finish(session, error.MissingRpcPoolResult);
                    return;
                };
                outcome.response = null;
                self.peerNonRetryable(session, index, &response, now_ms);
            },
            .retryable, .rate_limited, .cooldown => self.peerFailure(session, index, outcome.failure orelse error.RpcRemoteError, outcome.classification, now_ms),
        }
    }

    fn refreshFallbackOrder(self: *Pool, session: *Session) void {
        if (session.strategy != .fallback) return;
        @memcpy(session.order, self.priorities);
        for (session.peers, 0..) |*peer, index| {
            peer.failed_count_snapshot = self.endpoints[index].failed_count;
            peer.block_time_snapshot = self.endpoints[index].last_block_time_ms;
        }
    }

    fn recordOutcomeFailure(self: *Pool, session: *Session, index: usize, classification: Classification, now_ms: u64) void {
        if (session.strategy != .fallback or classification == .success or classification == .cooldown) return;
        if (isRawSend(session.wire().method) and classification != .rate_limited) return;
        if (classification != .rate_limited and self.endpoints[index].cooldown_until_ms > now_ms) return;
        const snapshot = if (classification == .rate_limited) self.endpoints[index].failed_count else session.peers[index].failed_count_snapshot;
        self.recordFailedProvider(session.id, index, snapshot);
    }

    fn recordFailedProvider(self: *Pool, session_id: u64, index: usize, snapshot: u32) void {
        const endpoint_ = &self.endpoints[index];
        endpoint_.failed_count +|= 1;
        self.emit(.{ .kind = .provider_failed, .session_id = session_id, .endpoint_index = @intCast(index), .failed_count = endpoint_.failed_count });
        if (snapshot +| 1 >= self.config.strategy.fallback.failed_request_threshold) {
            endpoint_.failed_count = 0;
            self.deprioritize(session_id, index);
        }
    }

    fn deprioritize(self: *Pool, session_id: u64, index: usize) void {
        const endpoint_ = &self.endpoints[index];
        self.emit(.{
            .kind = .provider_deprioritized,
            .session_id = session_id,
            .endpoint_index = @intCast(index),
            .failed_count = endpoint_.failed_count,
            .previous_block_height = endpoint_.last_block_height,
            .block_height = endpoint_.last_block_height,
        });
        var position: usize = 0;
        while (position < self.priorities.len and self.priorities[position] != index) position += 1;
        if (position == self.priorities.len) return;
        for (position + 1..self.priorities.len) |next| self.priorities[next - 1] = self.priorities[next];
        self.priorities[self.priorities.len - 1] = index;
    }

    fn penalize(self: *Pool, index: usize, session_id: u64, now_ms: u64) void {
        const endpoint_ = &self.endpoints[index];
        const delay = self.randomBetween(20_000, 25_000);
        endpoint_.cooldown_until_ms = @max(endpoint_.cooldown_until_ms, now_ms +| delay);
        self.emit(.{ .kind = .rate_limited, .session_id = session_id, .endpoint_index = @intCast(index), .deadline_ms = endpoint_.cooldown_until_ms });
    }

    fn maybeStartProbe(self: *Pool, session: *Session, index: usize, outcome: ?*Outcome, now_ms: u64) !void {
        if (self.endpoints.len == 1 or self.probes[index] != null) return;
        const config = session.strategy.fallback;
        if (now_ms -| session.peers[index].block_time_snapshot <= config.max_block_time_ms) return;
        if (now_ms -| self.endpoints[index].last_block_time_ms <= config.max_block_time_ms) return;
        const probe = try self.allocator.create(Probe);
        probe.* = .{
            .cache_owner = if (session.indexer_tip_cache and self.config.height_protocol == .ethereum) self.config.dynamic_tip_cache else null,
            .observer = session.observer,
            .endpoint_index = index,
            .deadline_ms = if (outcome == null) now_ms +| config.probe_timeout_ms else @min(session.deadline_ms, now_ms +| config.probe_timeout_ms),
        };
        if (probe.observer) |observer| observer.retain();
        self.probes[index] = probe;
        if (outcome) |value| {
            probe.session = session;
            probe.outcome = value.*;
            value.* = .{ .classification = value.classification, .failure = value.failure };
            session.waiting_probe = true;
        }
        self.emit(.{ .kind = .probe_started, .operation = .block_number_probe, .session_id = session.id, .endpoint_index = @intCast(index), .deadline_ms = probe.deadline_ms });
        self.submitProbe(probe, now_ms) catch |err| {
            self.probes[index] = null;
            if (probe.session) |attached| attached.waiting_probe = false;
            probe.deinit(self.allocator);
            return err;
        };
    }

    fn probeCacheEvent(_: *Pool, probe: *Probe, kind: EventKind) void {
        if (probe.observer) |observer| emitObserved(observer, .{ .kind = kind, .method = "eth_blockNumber", .operation = .block_number_probe, .endpoint_index = @intCast(probe.endpoint_index) });
    }
    fn submitProbe(self: *Pool, probe: *Probe, now_ms: u64) !void {
        if (probe.native_id != null or now_ms >= probe.deadline_ms) return;
        const endpoint_ = &self.endpoints[probe.endpoint_index];
        if (probe.cache_owner) |cache| {
            if (probe.cache_follower) switch (try cache.follow(self.allocator, probe.cache_ticket.?)) {
                .pending => return,
                .released => {
                    probe.cache_follower = false;
                    probe.cache_ticket = null;
                },
                .hit => |result| {
                    probe.cache_result = result;
                    probe.cache_follower = false;
                    probe.cache_ticket = null;
                    self.probeCacheEvent(probe, .cache_hit);
                    return;
                },
            } else if (!probe.cache_checked) {
                probe.cache_checked = true;
                const key = (try tip_cache.key(self.allocator, endpoint_.owned.identity, "eth_blockNumber", .null)).?;
                self.probeCacheEvent(probe, .cache_logical_read);
                switch (try cache.claim(self.allocator, key)) {
                    .hit => |result| {
                        probe.cache_result = result;
                        self.probeCacheEvent(probe, .cache_hit);
                        return;
                    },
                    .leader => |ticket| probe.cache_ticket = ticket,
                    .follower => |ticket| {
                        probe.cache_ticket = ticket;
                        probe.cache_follower = true;
                        return;
                    },
                    .bypass => {},
                }
            }
        }
        const remaining: u32 = @intCast(@min(probe.deadline_ms - now_ms, std.math.maxInt(u32)));
        const request: curl.Request = .{
            .url = endpoint_.owned.endpoint.url,
            .method = .post,
            .headers = endpoint_.headers,
            .body = switch (self.config.height_protocol) {
                .ethereum => "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}",
                .sealevel => "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBlockHeight\",\"params\":[{\"commitment\":\"processed\"}]}",
                .tendermint => "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"block\",\"params\":{}}",
            },
            .timeout_ms = remaining,
            .connect_timeout_ms = @min(remaining, 5000),
            .max_response_bytes = self.config.max_response_bytes,
            .stop_after_http429_head = self.config.height_protocol == .ethereum,
        };
        const reservation = try multi.reservationBound(request);
        if (reservation > self.config.max_reserved_bytes -| (self.native.reserved_bytes +| self.retained_bytes)) return;
        probe.native_id = self.native.submit(request, now_ms) catch |err| switch (err) {
            error.CurlMultiQueueFull, error.CurlMultiByteBudgetExceeded => return,
            else => return err,
        };
        if (probe.cache_owner != null) self.probeCacheEvent(probe, .cache_upstream_read);
        probe.started_ms = now_ms;
        probe.started_at = if (probe.observer != null and self.config.clock == null) std.time.Instant.now() catch null else null;
        probe.submitted = true;
    }

    fn progressProbes(self: *Pool, now_ms: u64) bool {
        var any = false;
        for (self.probes, 0..) |entry, index| {
            const probe = entry orelse continue;
            any = true;
            if (self.stopping.load(.acquire) or now_ms >= probe.deadline_ms) {
                if (self.stopping.load(.acquire)) probe.cancelled = true;
                if (probe.native_id) |id| self.native.cancel(id) catch {};
                self.finishProbe(index, .{ .failure = error.RequestDeadlineExceeded }, now_ms);
                continue;
            }
            if (probe.cache_result) |result| {
                probe.cache_result = null;
                defer self.allocator.free(result);
                const body = std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{s}}}", .{result}) catch |err| {
                    self.finishProbe(index, .{ .failure = err }, now_ms);
                    continue;
                };
                var response: curl.Response = .{ .allocator = self.allocator, .status = 200, .http_version = 0, .body = body, .headers = &.{}, .header_storage = &.{} };
                defer response.deinit();
                self.finishProbe(index, .{ .response = response }, now_ms);
                continue;
            }
            if (probe.native_id == null) self.submitProbe(probe, now_ms) catch |err| {
                self.finishProbe(index, .{ .failure = err }, now_ms);
            };
        }
        return any;
    }

    fn probeHeight(self: *Pool, response: curl.Response) !?u64 {
        var parsed = ParsedResponse.parse(self.allocator, response.body, 1, self.config.max_response_bytes) catch |err| {
            if (err == error.OutOfMemory) return err;
            return null;
        };
        defer parsed.deinit(self.allocator);
        const value = parsed.result orelse return null;
        return switch (self.config.height_protocol) {
            .ethereum => quantity64(value) catch null,
            .sealevel => decimalHeight(value),
            .tendermint => blk: {
                const block = if (value == .object) value.object.get("block") orelse break :blk null else break :blk null;
                const header = if (block == .object) block.object.get("header") orelse break :blk null else break :blk null;
                break :blk if (header == .object) decimalHeight(header.object.get("height") orelse break :blk null) else null;
            },
        };
    }
    fn decimalHeight(value: Value) ?u64 {
        return switch (value) {
            .integer => |n| std.math.cast(u64, n),
            .number_string, .string => |text| std.fmt.parseInt(u64, text, 10) catch null,
            else => null,
        };
    }
    fn probeMethod(self: *const Pool) []const u8 {
        return switch (self.config.height_protocol) {
            .ethereum => "eth_blockNumber",
            .sealevel => "getBlockHeight",
            .tendermint => "block",
        };
    }

    fn finishProbe(self: *Pool, index: usize, result: multi.Result, now_ms: u64) void {
        const probe = self.probes[index] orelse return;
        const endpoint_ = &self.endpoints[index];
        var height = endpoint_.last_block_height;
        var timed_out = false;
        var probe_success = false;
        switch (result) {
            .failure => |err| timed_out = err == error.RequestDeadlineExceeded or err == error.RequestCancelled,
            .response => |response| {
                // Ethereum Source rejects HTTP 429 before decoding but accepts valid
                // JSON-RPC bodies on other statuses. Other protocols stay 2xx-only.
                const accepted = response.status != 429 and (self.config.height_protocol == .ethereum or (response.status >= 200 and response.status < 300));
                const fetched_height = if (accepted) self.probeHeight(response) catch |err| {
                    if (probe.submitted and probe.observer != null) emitObserved(probe.observer.?, .{ .kind = .upstream_completed, .method = self.probeMethod(), .success = false, .cancelled = probe.cancelled, .operation = .block_number_probe, .endpoint_index = @intCast(index), .duration_ms = self.now() -| probe.started_ms, .duration_ns = elapsedNs(probe.started_at, self.now() -| probe.started_ms) });
                    const attached = probe.session;
                    if (attached) |session| session.waiting_probe = false;
                    self.probes[index] = null;
                    if (attached) |session| self.finish(session, err);
                    probe.deinit(self.allocator);
                    return;
                } else null;
                probe_success = fetched_height != null;
                height = fetched_height orelse endpoint_.last_block_height;
            },
        }
        if (!probe_success) if (probe.session) |session| {
            session.all_svm_failures_unresolvable = false;
        };
        if (probe.submitted and probe.observer != null) emitObserved(probe.observer.?, .{ .kind = .upstream_completed, .method = self.probeMethod(), .success = probe_success, .cancelled = probe.cancelled or switch (result) {
            .failure => |err| err == error.RequestCancelled,
            .response => false,
        }, .operation = .block_number_probe, .endpoint_index = @intCast(index), .duration_ms = self.now() -| probe.started_ms, .duration_ns = elapsedNs(probe.started_at, self.now() -| probe.started_ms) });
        if (probe.cache_owner) |cache| {
            if (probe.submitted and !probe_success and !probe.cancelled) self.probeCacheEvent(probe, .cache_upstream_error);
            if (!probe.cache_follower) if (probe.cache_ticket) |ticket| {
                if (probe_success) {
                    const encoded = std.fmt.allocPrint(self.allocator, "\"0x{x}\"", .{height}) catch null;
                    if (encoded) |bytes| {
                        cache.finish(ticket, bytes);
                        self.allocator.free(bytes);
                    } else cache.finish(ticket, null);
                } else cache.finish(ticket, null);
                probe.cache_ticket = null;
            };
        }
        const attached = probe.session;
        if (attached) |session| session.waiting_probe = false;
        self.probes[index] = null;
        if (timed_out) {
            self.emit(.{ .kind = .probe_timed_out, .operation = .block_number_probe, .endpoint_index = @intCast(index) });
        } else {
            const previous = endpoint_.last_block_height;
            endpoint_.failed_count = 0;
            endpoint_.last_block_time_ms = now_ms;
            self.emit(.{ .kind = .probe_succeeded, .operation = .block_number_probe, .endpoint_index = @intCast(index), .previous_block_height = previous, .block_height = height });
            if (height <= previous) {
                self.deprioritize(if (attached) |session| session.id else 0, index);
            } else endpoint_.last_block_height = height;
        }
        if (attached) |session| if (probe.outcome) |*outcome| self.handleOutcome(session, index, outcome, now_ms);
        probe.deinit(self.allocator);
    }

    fn peerFailure(self: *Pool, session: *Session, index: usize, _: anyerror, classification: Classification, now_ms: u64) void {
        session.peers[index].failed = true;
        switch (session.strategy) {
            .single => |single| {
                if (session.peers[index].attempts >= single.max_attempts) {
                    self.finishRetryExhaustion(session, error.RpcPoolRetriesExhausted);
                } else {
                    session.peers[index].done = false;
                    session.peers[index].failed = false;
                    session.peers[index].next_attempt_ms = now_ms +| backoff(single.retry_delay_ms, session.peers[index].attempts, classification);
                }
            },
            .quorum => |quorum| {
                if (session.peers[index].attempts < quorum.max_attempts) {
                    session.peers[index].done = false;
                    session.peers[index].failed = false;
                    session.peers[index].next_attempt_ms = now_ms +| backoff(quorum.retry_delay_ms, session.peers[index].attempts, classification);
                }
            },
            .fallback => {
                session.retry_errors += 1;
                if (classification == .non_retryable) session.saw_non_retryable = true;
                if (isRawSend(session.wire().method)) {
                    if (self.allAttempted(session)) self.finishRawRound(session, now_ms);
                } else if (session.strategy.fallback.hedge != null and hedgeable(session.original.method, session.original.params)) {
                    if (session.next_peer < session.peers.len) {
                        session.refill_hedge = true;
                    } else if (self.activeCount(session) == 0) self.finishFallbackRound(session, now_ms);
                } else if (self.activeCount(session) == 0 and session.next_peer >= session.peers.len) {
                    self.finishFallbackRound(session, now_ms);
                }
            },
        }
        if (session.strategy == .quorum and isSubmission(session.original.method)) self.settleSubmission(session);
    }

    fn peerNonRetryable(self: *Pool, session: *Session, index: usize, response: *ParsedResponse, now_ms: u64) void {
        session.terminal_rpc_error = true;
        switch (session.strategy) {
            .quorum => {
                response.deinit(self.allocator);
                session.peers[index].failed = true;
                if (isSubmission(session.original.method)) self.settleSubmission(session) else self.checkQuorumImpossible(session);
            },
            .single => {
                const bytes = response.takeBytes(self.allocator);
                self.finishBytes(session, bytes);
            },
            .fallback => {
                if (isRawSend(session.wire().method)) {
                    response.deinit(self.allocator);
                    session.saw_non_retryable = true;
                    session.peers[index].failed = true;
                    if (self.allAttempted(session)) self.finishRawRound(session, now_ms);
                } else {
                    const bytes = response.takeBytes(self.allocator);
                    self.finishBytes(session, bytes);
                }
            },
        }
    }

    fn peerSuccess(self: *Pool, session: *Session, index: usize, response: *ParsedResponse, now_ms: u64) !void {
        if (session.strategy == .fallback and session.phase == .actual and session.strategy.fallback.consider_null_transaction_receipt and std.mem.eql(u8, session.wire().method, "eth_getTransactionReceipt") and response.result.? == .null) {
            response.deinit(self.allocator);
            session.peers[index].skip = true;
            session.peers[index].failed = true;
            if (self.activeCount(session) == 0 and session.next_peer >= session.peers.len) self.finishFallbackRound(session, now_ms);
            return;
        }
        switch (session.strategy) {
            .single, .fallback => {
                session.winner_speculative = session.peers[index].speculative;
                const bytes = response.takeBytes(self.allocator);
                self.finishBytes(session, bytes);
            },
            .quorum => {
                if (isSubmission(session.original.method)) {
                    if (session.deferred_winner == null) session.deferred_winner = response.takeBytes(self.allocator) else response.deinit(self.allocator);
                    self.settleSubmission(session);
                } else if (self.numericMethod(session)) {
                    self.numericSuccess(session, index, response, now_ms) catch |err| switch (err) {
                        error.InvalidRpcBlock, error.InvalidRpcQuantity => {
                            response.deinit(self.allocator);
                            self.peerFailure(session, index, err, .retryable, now_ms);
                        },
                        else => return err,
                    };
                } else try self.voteSuccess(session, index, response);
            },
        }
    }

    fn numericMethod(self: *Pool, session: *Session) bool {
        _ = self;
        if (session.phase == .latest or session.phase == .dynamic) return true;
        const method = session.wire().method;
        return std.mem.eql(u8, method, "eth_blockNumber") or std.mem.eql(u8, method, "eth_estimateGas") or std.mem.eql(u8, method, "eth_gasPrice") or std.mem.eql(u8, method, "eth_maxPriorityFeePerGas");
    }

    fn numericSuccess(self: *Pool, session: *Session, index: usize, response: *ParsedResponse, now_ms: u64) !void {
        const result = response.result.?;
        const number: u256 = switch (session.phase) {
            .latest => try quantity64(result),
            .dynamic => try blockNumber(result),
            .actual => try quantity(result),
        };
        try self.retainResponse(response);
        session.peers[index].number = number;
        session.peers[index].response = response.*;
        response.* = undefined;
        var successful: usize = 0;
        for (session.peers) |peer| if (peer.number != null) {
            successful += 1;
        };
        if (successful == self.threshold and session.numeric_quorum_ms == null) {
            session.numeric_quorum_ms = now_ms;
            const floor = if (session.phase == .dynamic) session.strategy.quorum.dynamic_tag_grace_floor_ms else 0;
            session.numeric_grace_deadline_ms = now_ms +| @max(now_ms -| session.phase_started_ms, floor);
        }
    }

    fn voteSuccess(self: *Pool, session: *Session, index: usize, response: *ParsedResponse) !void {
        for (session.peers, 0..) |*peer, other| {
            if (other == index or peer.response == null) continue;
            if (normalizedEqual(peer.response.?.result.?, response.result.?)) {
                peer.votes += 1;
                if (peer.votes >= self.threshold) {
                    self.releaseResponse(&peer.response.?);
                    const bytes = peer.response.?.takeBytes(self.allocator);
                    peer.response = null;
                    response.deinit(self.allocator);
                    self.finishBytes(session, bytes);
                } else response.deinit(self.allocator);
                return;
            }
        }
        try self.retainResponse(response);
        session.peers[index].response = response.*;
        session.peers[index].votes = 1;
        response.* = undefined;
        if (self.threshold == 1) {
            self.releaseResponse(&session.peers[index].response.?);
            const bytes = session.peers[index].response.?.takeBytes(self.allocator);
            session.peers[index].response = null;
            self.finishBytes(session, bytes);
        } else self.checkQuorumImpossible(session);
    }

    fn progress(self: *Pool, session: *Session, now_ms: u64) !void {
        // Cross-Pool cache followers retain only generation tokens. Poll them
        // cooperatively; no owner lock is held across native I/O or PIO.
        for (session.peers, 0..) |peer, index| if (peer.cache_follower) {
            try self.submitPeer(session, index, now_ms);
            if (session.finished) return;
        };
        if (!session.reported_start) {
            session.reported_start = true;
            self.refreshFallbackOrder(session);
            self.emit(.{ .kind = .request_started, .method = session.original.method, .operation = if (isRawSend(session.original.method)) .raw_transaction else .read, .session_id = session.id });
        }
        if (session.waiting_probe) return;
        if (session.restart_number) |number| {
            if (self.activeCount(session) != 0) return;
            session.restart_number = null;
            try self.pinAndRestart(session, number, now_ms);
        }
        switch (session.strategy) {
            .single => try self.submitPeer(session, 0, now_ms),
            .fallback => try self.progressFallback(session, now_ms),
            .quorum => {
                if (self.numericMethod(session)) try self.progressNumeric(session, now_ms);
                if (session.finished or session.restart_number != null) return;
                for (session.peers, 0..) |*peer, index| {
                    if (peer.done or peer.skip) continue;
                    if (now_ms < peer.next_attempt_ms) continue;
                    try self.submitPeer(session, index, now_ms);
                }
                if (!session.finished and !self.numericMethod(session)) self.checkQuorumImpossible(session);
            },
        }
    }

    fn progressFallback(self: *Pool, session: *Session, now_ms: u64) !void {
        if (now_ms < session.round_wait_ms) return;
        if (isRawSend(session.wire().method)) {
            for (session.peers, 0..) |*peer, index| if (!peer.done and !peer.skip) try self.submitPeer(session, index, now_ms);
            return;
        }
        if (session.strategy.fallback.hedge) |hedge| {
            if (!hedgeable(session.original.method, session.original.params)) {
                if (self.activeCount(session) == 0 and session.next_peer < session.peers.len) try self.submitNextFallback(session, now_ms);
                return;
            }
            const active = self.activeCount(session);
            if (session.refill_hedge and session.next_peer < session.peers.len) {
                session.refill_hedge = false;
                try self.submitNextFallback(session, now_ms);
                session.grace_deadline_ms = now_ms +| hedge.delay_ms;
            } else if (active == 0 and session.next_peer < session.peers.len) {
                try self.submitNextFallback(session, now_ms);
                session.grace_deadline_ms = now_ms +| hedge.delay_ms;
            } else if (active == 1 and session.next_peer < session.peers.len and now_ms >= session.grace_deadline_ms) {
                try self.submitNextFallback(session, now_ms);
            }
            return;
        }
        if (self.activeCount(session) == 0 and session.next_peer < session.peers.len) try self.submitNextFallback(session, now_ms);
    }

    fn submitNextFallback(self: *Pool, session: *Session, now_ms: u64) !void {
        while (session.next_peer < session.peers.len and session.peers[session.order[session.next_peer]].skip) session.next_peer += 1;
        if (session.next_peer >= session.peers.len) {
            self.finishFallbackRound(session, now_ms);
            return;
        }
        const index = session.order[session.next_peer];
        session.next_peer += 1;
        const speculative = session.strategy.fallback.hedge != null and hedgeable(session.original.method, session.original.params) and self.activeCount(session) != 0;
        session.peers[index].speculative = speculative;
        if (speculative) self.emitSession(session, .{ .kind = .hedge_started, .hedged = true, .method = session.original.method, .session_id = session.id, .endpoint_index = @intCast(index), .speculative = true });
        try self.submitPeer(session, index, now_ms);
    }

    fn cacheEvent(self: *Pool, session: *Session, index: usize, kind: EventKind) void {
        self.emitSession(session, .{ .kind = kind, .method = session.wire().method, .session_id = session.id, .endpoint_index = @intCast(index) });
    }
    fn cacheRelease(self: *Pool, peer: *Peer) void {
        if (!peer.cache_follower) if (peer.cache_ticket) |ticket| if (self.config.dynamic_tip_cache) |cache| cache.finish(ticket, null);
        peer.cache_ticket = null;
        peer.cache_follower = false;
    }
    fn cachedResult(self: *Pool, session: *Session, index: usize, result: []u8, now_ms: u64) !void {
        defer self.allocator.free(result);
        const body = try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ session.wire().id, result });
        defer self.allocator.free(body);
        const parsed = try ParsedResponse.parse(self.allocator, body, session.wire().id, session.max_response_bytes);
        self.cacheRelease(&session.peers[index]);
        session.peers[index].done = true;
        self.cacheEvent(session, index, .cache_hit);
        var outcome: Outcome = .{ .classification = .success, .response = parsed };
        self.dispatchOutcome(session, index, &outcome, now_ms);
    }
    fn cacheBefore(self: *Pool, session: *Session, index: usize, now_ms: u64) !bool {
        if (!session.indexer_tip_cache) return false;
        const cache = self.config.dynamic_tip_cache orelse return false;
        const peer = &session.peers[index];
        if (peer.cache_follower) {
            switch (try cache.follow(self.allocator, peer.cache_ticket.?)) {
                .pending => return true,
                .hit => |result| {
                    try self.cachedResult(session, index, result, now_ms);
                    return true;
                },
                .released => {
                    peer.cache_follower = false;
                    peer.cache_ticket = null;
                    return false;
                },
            }
        }
        if (peer.cache_checked) return false;
        peer.cache_checked = true;
        const hash = (try tip_cache.key(self.allocator, self.endpoints[index].owned.identity, session.wire().method, session.wire().params)) orelse return false;
        peer.cache_eligible = true;
        self.cacheEvent(session, index, .cache_logical_read);
        switch (try cache.claim(self.allocator, hash)) {
            .bypass => return false,
            .leader => |ticket| {
                peer.cache_ticket = ticket;
                return false;
            },
            .follower => |ticket| {
                peer.cache_ticket = ticket;
                peer.cache_follower = true;
                return true;
            },
            .hit => |result| {
                try self.cachedResult(session, index, result, now_ms);
                return true;
            },
        }
    }
    fn validTipResult(method: []const u8, result: Value) bool {
        if (std.mem.eql(u8, method, "eth_blockNumber")) {
            _ = quantity64(result) catch return false;
            return true;
        }
        if (result == .null) return true;
        if (result != .object) return false;
        _ = blockNumber(result) catch return false;
        return true;
    }

    fn submitPeer(self: *Pool, session: *Session, index: usize, now_ms: u64) !void {
        const peer = &session.peers[index];
        if (session.finished or peer.done or peer.native_id != null or now_ms < peer.next_attempt_ms) return;
        if (try self.cacheBefore(session, index, now_ms)) return;
        if (now_ms >= session.deadline_ms) {
            self.finish(session, error.RequestDeadlineExceeded);
            return;
        }
        const endpoint_ = &self.endpoints[index];
        if (session.strategy != .fallback and endpoint_.cooldown_until_ms > now_ms) {
            peer.cooldown_waited = true;
            peer.next_attempt_ms = endpoint_.cooldown_until_ms;
            self.emit(.{ .kind = .cooldown_wait, .session_id = session.id, .endpoint_index = @intCast(index), .deadline_ms = endpoint_.cooldown_until_ms });
            return;
        }
        if (session.strategy != .fallback and peer.cooldown_waited) {
            peer.cooldown_waited = false;
            const jitter = self.randomBetween(1, 1000);
            peer.next_attempt_ms = now_ms +| jitter;
            self.emit(.{ .kind = .cooldown_jitter, .session_id = session.id, .endpoint_index = @intCast(index), .deadline_ms = peer.next_attempt_ms });
            return;
        }
        if (session.strategy == .fallback and endpoint_.cooldown_until_ms > now_ms) {
            peer.done = true;
            var outcome: Outcome = .{ .classification = .cooldown, .failure = error.RpcRateLimited };
            self.handleOutcome(session, index, &outcome, now_ms);
            return;
        }
        var timeout: u64 = session.deadline_ms - now_ms;
        if (session.strategy == .fallback) {
            // Explicit immutable-read hedge timing takes precedence. The
            // ordinary producer cap bounds request-level sequential fallback,
            // including non-hedgeable methods on a configured hedged pool.
            const physical = if (session.strategy.fallback.hedge != null and hedgeable(session.original.method, session.original.params)) session.strategy.fallback.hedge.?.attempt_timeout_ms else session.strategy.fallback.attempt_timeout_ms;
            if (physical) |limit| timeout = @min(timeout, limit);
        }
        if (timeout == 0) return;
        const request: curl.Request = .{
            .url = endpoint_.owned.endpoint.url,
            .method = .post,
            .headers = endpoint_.headers,
            .body = session.wire().body,
            .timeout_ms = @intCast(@min(timeout, std.math.maxInt(u32))),
            .connect_timeout_ms = @min(session.connect_timeout_ms, @as(u32, @intCast(@min(timeout, std.math.maxInt(u32))))),
            .max_response_bytes = session.max_response_bytes,
            .stop_after_http429_head = self.config.height_protocol == .ethereum,
            .cancel = &session.closed,
        };
        const reservation = try multi.reservationBound(request);
        if (reservation > self.config.max_reserved_bytes -| (self.native.reserved_bytes +| self.retained_bytes)) {
            if (self.retained_bytes != 0) {
                self.finish(session, error.RpcPoolByteBudgetExceeded);
            } else peer.next_attempt_ms = now_ms +| 1;
            return;
        }
        const id = self.native.submit(request, now_ms) catch |err| switch (err) {
            error.CurlMultiQueueFull, error.CurlMultiByteBudgetExceeded => {
                peer.next_attempt_ms = now_ms +| 1;
                return;
            },
            else => return err,
        };
        peer.native_id = id;
        if (peer.cache_eligible and !peer.cache_upstream_reported) {
            self.cacheEvent(session, index, .cache_upstream_read);
            peer.cache_upstream_reported = true;
        }
        peer.started_ms = now_ms;
        peer.started_at = if (session.observer != null and self.config.clock == null) std.time.Instant.now() catch null else null;
        peer.attempts +|= 1;
    }

    fn progressNumeric(self: *Pool, session: *Session, now_ms: u64) !void {
        if (session.numeric_quorum_ms) |_| {
            const pending = self.pendingCount(session);
            if (pending != 0 and now_ms < session.numeric_grace_deadline_ms) return;
            var used: [256]bool = @splat(false);
            var chosen: usize = 0;
            for (0..self.threshold) |_| {
                var best: ?usize = null;
                for (session.peers, 0..) |peer, index| {
                    if (used[index] or peer.number == null) continue;
                    if (best == null or peer.number.? > session.peers[best.?].number.?) best = index;
                }
                chosen = best orelse {
                    self.finish(session, error.NoQuorumReached);
                    return;
                };
                used[chosen] = true;
            }
            self.releaseResponse(&session.peers[chosen].response.?);
            const bytes = session.peers[chosen].response.?.takeBytes(self.allocator);
            session.peers[chosen].response = null;
            if (session.phase == .actual) {
                self.finishBytes(session, bytes);
            } else {
                self.allocator.free(bytes);
                const number = session.peers[chosen].number.?;
                if (self.activeCount(session) == 0) {
                    try self.pinAndRestart(session, number, now_ms);
                } else {
                    session.restart_number = number;
                    for (session.peers) |*peer| {
                        self.cacheRelease(peer);
                        peer.done = true;
                        if (peer.native_id) |id| self.native.cancel(id) catch {};
                    }
                }
            }
            return;
        }
        self.checkQuorumImpossible(session);
    }

    fn pinAndRestart(self: *Pool, session: *Session, number: u256, now_ms: u64) !void {
        if (session.current) |*current| current.deinit(self.allocator);
        session.current = null;
        const tag = try std.fmt.allocPrint(self.allocator, "0x{x}", .{number});
        session.pinned_tag = tag;
        session.original.params.array.items[session.block_parameter_index] = .{ .string = tag };
        session.current = try Request.fromParts(self.allocator, session.original.id, session.original.method, session.original.params, session.max_request_bytes);
        session.phase = .actual;
        self.resetPeers(session);
        session.phase_started_ms = now_ms;
    }

    fn checkQuorumImpossible(self: *Pool, session: *Session) void {
        if (session.finished or session.strategy != .quorum) return;
        if (session.deferred_winner != null or session.restart_number != null) return;
        if (self.numericMethod(session) and session.numeric_quorum_ms != null) return;
        const pending = self.pendingCount(session);
        var possible = pending >= self.threshold;
        if (self.numericMethod(session)) {
            var successful: usize = 0;
            for (session.peers) |peer| if (peer.number != null) {
                successful += 1;
            };
            possible = successful + pending >= self.threshold;
        } else {
            for (session.peers) |peer| if (peer.response != null and peer.votes + pending >= self.threshold) {
                possible = true;
                break;
            };
        }
        if (possible) return;
        if (session.phase == .latest) {
            if (session.current) |*current| current.deinit(self.allocator);
            session.current = null;
            session.phase = .actual;
            self.resetPeers(session);
            session.phase_started_ms = self.now();
        } else self.finish(session, error.NoQuorumReached);
    }

    fn resetPeers(self: *Pool, session: *Session) void {
        for (session.peers) |*peer| {
            std.debug.assert(peer.native_id == null);
            self.cacheRelease(peer);
            peer.cache_checked = false;
            peer.cache_eligible = false;
            peer.cache_upstream_reported = false;
            if (peer.response) |*response| self.destroyResponse(response);
            peer.native_id = null;
            peer.done = false;
            peer.failed = false;
            peer.skip = false;
            peer.attempts = 0;
            peer.next_attempt_ms = 0;
            peer.response = null;
            peer.votes = 0;
            peer.number = null;
        }
        session.numeric_quorum_ms = null;
        session.numeric_grace_deadline_ms = 0;
    }

    fn finishRawRound(self: *Pool, session: *Session, now_ms: u64) void {
        if (session.saw_non_retryable or session.round >= 3) {
            self.finish(session, error.AllRpcProvidersFailed);
            return;
        }
        session.round += 1;
        session.round_wait_ms = now_ms +| session.strategy.fallback.retry_delay_ms;
        for (session.peers) |*peer| {
            peer.done = false;
            peer.failed = false;
        }
    }

    fn finishFallbackRound(self: *Pool, session: *Session, now_ms: u64) void {
        if (session.retry_errors > 3) {
            self.finishRetryExhaustion(session, error.AllRpcProvidersFailed);
            return;
        }
        var eligible = false;
        for (session.peers) |peer| if (!peer.skip) {
            eligible = true;
            break;
        };
        if (!eligible) {
            self.finish(session, error.AllRpcProvidersFailed);
            return;
        }
        session.round_wait_ms = now_ms +| session.strategy.fallback.retry_delay_ms;
        session.next_peer = 0;
        session.refill_hedge = false;
        const filtered_receipt_round = session.strategy.fallback.consider_null_transaction_receipt and std.mem.eql(u8, session.wire().method, "eth_getTransactionReceipt");
        if (!filtered_receipt_round) self.refreshFallbackOrder(session);
        for (session.peers) |*peer| {
            peer.done = peer.skip;
            peer.failed = false;
            peer.speculative = false;
        }
    }

    fn activeCount(self: *Pool, session: *Session) usize {
        _ = self;
        var count: usize = 0;
        for (session.peers) |peer| if (peer.native_id != null or peer.cache_follower) {
            count += 1;
        };
        return count;
    }

    fn pendingCount(self: *Pool, session: *Session) usize {
        _ = self;
        var count: usize = 0;
        for (session.peers) |peer| if (!peer.done and !peer.skip) {
            count += 1;
        };
        return count;
    }

    fn allAttempted(self: *Pool, session: *Session) bool {
        _ = self;
        for (session.peers) |peer| if (!peer.done and !peer.skip) return false;
        return true;
    }

    fn settleSubmission(self: *Pool, session: *Session) void {
        if (!self.allAttempted(session)) return;
        if (session.deferred_winner) |bytes| {
            session.deferred_winner = null;
            self.finishBytes(session, bytes);
        } else self.finish(session, error.NoQuorumReached);
    }

    /// Solana's Source returns an unresolvable block only after the complete
    /// provider/retry policy has failed exclusively with these known errors.
    /// This never runs for quorum, cancellation or an owner/physical deadline.
    fn finishRetryExhaustion(self: *Pool, session: *Session, failure: anyerror) void {
        if (self.config.height_protocol == .sealevel and session.strategy != .quorum and session.all_svm_failures_unresolvable and std.mem.eql(u8, session.wire().method, "getBlock")) if (session.svm_unresolvable_response) |saved| {
            for (session.peers) |peer| if (peer.attempts == 0) {
                self.finish(session, failure);
                return;
            };
            var response = saved;
            session.svm_unresolvable_response = null;
            self.releaseResponse(&response);
            session.terminal_rpc_error = true;
            self.finishBytes(session, response.takeBytes(self.allocator));
            return;
        };
        self.finish(session, failure);
    }

    fn finishBytes(self: *Pool, session: *Session, bytes: []u8) void {
        session.winner = bytes;
        self.finish(session, null);
    }

    fn finish(self: *Pool, session: *Session, failure: ?anyerror) void {
        if (session.finished) {
            if (failure != null and session.winner == null) session.failure = failure;
            return;
        }
        for (self.probes) |entry| if (entry) |probe| {
            if (probe.session != session) continue;
            probe.cancelled = true;
            if (probe.native_id) |id| self.native.cancel(id) catch {};
            probe.session = null;
            if (probe.outcome) |*outcome| outcome.deinit(self.allocator);
            probe.outcome = null;
            probe.deadline_ms = self.now();
            session.waiting_probe = false;
        };
        const cancelled = if (failure) |err| err == error.RequestCancelled or err == error.RpcPoolStopped or err == error.RequestDeadlineExceeded else false;
        self.emitSession(session, .{
            .kind = if (failure == null) .request_succeeded else .request_failed,
            .success = failure == null and !session.terminal_rpc_error,
            .cancelled = cancelled,
            .hedged = isHedged(session),
            .method = session.original.method,
            .operation = if (isRawSend(session.original.method)) .raw_transaction else .read,
            .session_id = session.id,
            .speculative = session.winner_speculative,
            .duration_ms = self.now() -| session.started_ms,
            .duration_ns = elapsedNs(session.started_at, self.now() -| session.started_ms),
        });
        session.mutex.lock();
        session.failure = failure;
        session.finished = true;
        session.wake.broadcast();
        session.mutex.unlock();
        session.closed.store(true, .release);
        for (session.peers, 0..) |*peer, index| {
            self.cacheRelease(peer);
            peer.done = true;
            if (peer.native_id) |id| {
                if (isHedged(session) and !cancelled) self.emitSession(session, .{ .kind = .hedge_cancelled, .hedged = true, .method = session.original.method, .session_id = session.id, .endpoint_index = @intCast(index), .speculative = peer.speculative });
                self.native.cancel(id) catch {};
            }
        }
    }
};

fn backoff(base_ms: u32, attempts: u8, classification: Classification) u64 {
    const shift: u8 = if (attempts <= 1) 0 else attempts - 1;
    const ordinary = @as(u64, base_ms) *| (@as(u64, 1) << @min(shift, 20));
    return if (classification == .rate_limited) @max(ordinary, 20000) else ordinary;
}

fn blockParameterIndex(method: []const u8, params: Value) ?usize {
    if (params != .array or params.array.items.len == 0) return null;
    if (std.mem.eql(u8, method, "eth_getBlockByNumber")) return 0;
    const methods = [_][]const u8{ "eth_call", "eth_createAccessList", "eth_getStorageAt", "eth_getCode", "eth_getProof", "eth_estimateGas", "trace_call", "trace_block" };
    for (methods) |candidate| if (std.mem.eql(u8, method, candidate)) return params.array.items.len - 1;
    return null;
}

fn isRawSend(method: []const u8) bool {
    return std.mem.eql(u8, method, "eth_sendRawTransaction");
}

fn isSubmission(method: []const u8) bool {
    return isRawSend(method) or std.mem.eql(u8, method, "eth_sendTransaction");
}

fn hedgeable(method: []const u8, params: Value) bool {
    if (params != .array) return false;
    const items = params.array.items;
    if (std.mem.eql(u8, method, "eth_getBlockByHash")) return items.len > 0 and isBlockHash(items[0]);
    if (std.mem.eql(u8, method, "eth_getBalance") or std.mem.eql(u8, method, "eth_getCode")) return items.len > 1 and immutableSelector(items[1]);
    if (std.mem.eql(u8, method, "eth_getStorageAt") or std.mem.eql(u8, method, "eth_getProof")) return items.len > 2 and immutableSelector(items[2]);
    return false;
}

fn immutableSelector(value: Value) bool {
    if (value != .object) return false;
    const hash = value.object.get("blockHash") orelse return false;
    return isBlockHash(hash);
}

fn isBlockHash(value: Value) bool {
    if (value != .string or value.string.len != 66 or !std.mem.startsWith(u8, value.string, "0x")) return false;
    for (value.string[2..]) |char| if (!std.ascii.isHex(char)) return false;
    return true;
}

fn normalizedContains(message: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (message.len < needle.len) return false;
    for (0..message.len - needle.len + 1) |start| {
        var matches = true;
        for (needle, 0..) |expected, offset| {
            const actual = if (message[start + offset] == '_') ' ' else std.ascii.toLower(message[start + offset]);
            if (actual != expected) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }
    return false;
}

fn svmUnresolvable(remote: Value) bool {
    if (remote != .object) return false;
    const value = remote.object.get("code") orelse return false;
    if (value != .number_string) return false;
    const code = std.fmt.parseInt(i64, value.number_string, 10) catch return false;
    return code == -32001 or code == -32004 or code == -32007 or code == -32009;
}

pub fn classify(method: []const u8, response: *const ParsedResponse) Classification {
    const rpc_error = response.rpc_error orelse return .success;
    const code_text = rpc_error.object.get("code").?.number_string;
    const code = std.fmt.parseInt(i64, code_text, 10) catch return .retryable;
    const message = rpc_error.object.get("message").?.string;
    const reverted = normalizedContains(message, "revert");
    if (code == 429 or (code != 3 and !reverted and (normalizedContains(message, "429") or normalizedContains(message, "rate limit") or normalizedContains(message, "too many requests")))) return .rate_limited;
    if (std.mem.eql(u8, method, "eth_estimateGas")) return .non_retryable;
    if (std.mem.eql(u8, method, "eth_feeHistory") and (normalizedContains(message, "support") or normalizedContains(message, "invalid type") or normalizedContains(message, "does not exist") or normalizedContains(message, "not available"))) return .non_retryable;
    const submission = isRawSend(method) or std.mem.eql(u8, method, "eth_sendTransaction");
    if ((std.mem.eql(u8, method, "eth_call") or submission) and reverted) return .non_retryable;
    if (submission and (normalizedContains(message, "known") or normalizedContains(message, "nonce") or normalizedContains(message, "underpriced") or normalizedContains(message, "insufficient funds") or normalizedContains(message, "insufficient balance"))) return .non_retryable;
    return .retryable;
}

pub fn normalizedEqual(left: Value, right: Value) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .null => true,
        .bool => |value| value == right.bool,
        .integer => |value| value == right.integer,
        .float => |value| value == right.float,
        .number_string => |value| numberEqual(value, right.number_string),
        .string => |value| std.mem.eql(u8, value, right.string),
        .array => |value| blk: {
            if (value.items.len != right.array.items.len) break :blk false;
            for (value.items, right.array.items) |a, b| if (!normalizedEqual(a, b)) break :blk false;
            break :blk true;
        },
        .object => |value| blk: {
            if (value.count() != right.object.count()) break :blk false;
            var iterator = value.iterator();
            while (iterator.next()) |entry| {
                const other = right.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!normalizedEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

const Decimal = struct { negative: bool, point: i64, digits: []const u8, exact: bool };

fn numberEqual(left: []const u8, right: []const u8) bool {
    if (std.mem.eql(u8, left, right)) return true;
    var left_buffer: [1024]u8 = undefined;
    var right_buffer: [1024]u8 = undefined;
    const a = canonicalNumber(left, &left_buffer) orelse return false;
    const b = canonicalNumber(right, &right_buffer) orelse return false;
    return a.negative == b.negative and a.point == b.point and std.mem.eql(u8, a.digits, b.digits);
}

fn canonicalNumber(text: []const u8, buffer: []u8) ?Decimal {
    var negative = false;
    var rest = text;
    if (rest.len > 0 and rest[0] == '-') {
        negative = true;
        rest = rest[1..];
    }
    const exponent_at = std.mem.indexOfAny(u8, rest, "eE") orelse rest.len;
    const exponent = if (exponent_at < rest.len) std.fmt.parseInt(i64, rest[exponent_at + 1 ..], 10) catch return null else 0;
    const mantissa = rest[0..exponent_at];
    if (mantissa.len > buffer.len) return null;
    const dot = std.mem.indexOfScalar(u8, mantissa, '.') orelse mantissa.len;
    var used: usize = 0;
    for (mantissa) |char| if (char != '.') {
        buffer[used] = char;
        used += 1;
    };
    var first: usize = 0;
    while (first < used and buffer[first] == '0') first += 1;
    if (first == used) return .{ .negative = false, .point = 0, .digits = buffer[0..0], .exact = true };
    var last = used;
    while (last > first and buffer[last - 1] == '0') last -= 1;
    const signed_dot = std.math.cast(i64, dot) orelse return null;
    const signed_first = std.math.cast(i64, first) orelse return null;
    const point = std.math.add(i64, std.math.sub(i64, signed_dot, signed_first) catch return null, exponent) catch return null;
    const digits = buffer[first..last];
    return .{ .negative = negative, .point = point, .digits = digits, .exact = true };
}

fn quantity(value: Value) !u256 {
    if (value != .string or value.string.len < 3 or !std.mem.startsWith(u8, value.string, "0x")) return error.InvalidRpcQuantity;
    return std.fmt.parseInt(u256, value.string[2..], 16) catch error.InvalidRpcQuantity;
}

fn quantity64(value: Value) !u64 {
    const number = try quantity(value);
    return std.math.cast(u64, number) orelse error.InvalidRpcQuantity;
}

fn blockNumber(value: Value) !u64 {
    if (value != .object) return error.InvalidRpcBlock;
    const number = value.object.get("number") orelse return error.InvalidRpcBlock;
    return quantity64(number);
}

test "exact JSON normalization ignores object order and decimal spelling without f64" {
    const allocator = std.testing.allocator;
    var left = try std.json.parseFromSlice(Value, allocator, "{\"n\":9007199254740993,\"x\":1.0,\"o\":{\"a\":1,\"b\":2}}", .{ .parse_numbers = false });
    defer left.deinit();
    var right = try std.json.parseFromSlice(Value, allocator, "{\"o\":{\"b\":2,\"a\":1},\"x\":1e0,\"n\":9007199254740993}", .{ .parse_numbers = false });
    defer right.deinit();
    try std.testing.expect(normalizedEqual(left.value, right.value));
    right.value.object.getPtr("n").?.* = .{ .number_string = "9007199254740992" };
    try std.testing.expect(!normalizedEqual(left.value, right.value));
}

test "configuration rejects impossible thresholds before native loading" {
    try std.testing.expectError(error.ImpossibleRpcQuorum, Pool.start(std.testing.allocator, .{ .library_path = "/never/load", .urls = &.{ "http://localhost:8545", "http://localhost:8545/" }, .strategy = .{ .quorum = .{ .threshold = 2 } } }));
}

fn elapsedNs(started: ?std.time.Instant, fallback_ms: u64) u64 {
    if (started) |start| if (std.time.Instant.now()) |now| return now.since(start) else |_| {};
    return fallback_ms *| std.time.ns_per_ms;
}

const NativeProbeFixture = struct {
    fn now(ctx: *anyopaque) u64 {
        const time: *std.atomic.Value(u64) = @ptrCast(@alignCast(ctx));
        return time.load(.acquire);
    }
    fn response(a: A, body: []const u8) ![]u8 {
        var parsed = try std.json.parseFromSlice(Value, a, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const method = object.get("method").?.string;
        const result = if (std.mem.eql(u8, method, "getBlockHeight")) "123" else if (std.mem.eql(u8, method, "block")) "{\"block\":{\"header\":{\"height\":\"123\"}}}" else if (std.mem.eql(u8, method, "getSlot")) "42" else return error.WrongProtocolProbeMethod;
        return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ object.get("id").?.integer, result });
    }
};
test "native fallback aging uses exact SVM processed block height and Tendermint latest block probes" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]HeightProtocol{ .sealevel, .tendermint }) |protocol_kind| {
        const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "" }}, .response_fn = NativeProbeFixture.response }, .{ .replies = &.{.{ .body = "" }}, .response_fn = NativeProbeFixture.response } };
        var server = try fixture.Fixture.init(16, &behaviors);
        try server.start();
        defer server.deinit();
        const first = try server.url(a, 0);
        defer a.free(first);
        const second = try server.url(a, 1);
        defer a.free(second);
        var time = std.atomic.Value(u64).init(0);
        const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{ first, second }, .strategy = .{ .fallback = .{ .max_block_time_ms = 1 } }, .height_protocol = protocol_kind, .clock = .{ .context = &time, .now_ms_fn = NativeProbeFixture.now } });
        defer owner.deinit();
        time.store(2, .release);
        const result = try owner.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":17,\"method\":\"getSlot\",\"params\":[]}", 2000, 1000, null, 32768);
        defer a.free(result.bytes);
        try std.testing.expectEqual(@as(u64, 123), owner.endpoints[0].last_block_height);
        try std.testing.expectEqual(@as(usize, 2), server.pathHits(0));
        var probe = try std.json.parseFromSlice(Value, a, server.records[1].bodyText(), .{});
        defer probe.deinit();
        const method = probe.value.object.get("method").?.string;
        try std.testing.expectEqualStrings(if (protocol_kind == .sealevel) "getBlockHeight" else "block", method);
        if (protocol_kind == .sealevel) try std.testing.expectEqualStrings("processed", probe.value.object.get("params").?.array.items[0].object.get("commitment").?.string) else try std.testing.expectEqual(@as(usize, 0), probe.value.object.get("params").?.object.count());
        try server.check();
    }
}

const CountedClock = struct {
    calls: std.atomic.Value(usize) = .init(0),
    fn now(ctx: *anyopaque) u64 {
        const self: *CountedClock = @ptrCast(@alignCast(ctx));
        _ = self.calls.fetchAdd(1, .monotonic);
        const instant = std.time.Instant.now() catch unreachable;
        return @as(u64, @intCast(instant.timestamp.sec)) * 1000 + @as(u64, @intCast(instant.timestamp.nsec)) / std.time.ns_per_ms;
    }
};
test "native RPC owner suspends between active socket polls instead of spinning on a stalled request" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "", .stall = true }} }};
    var server = try fixture.Fixture.init(4, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var clock: CountedClock = .{};
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} }, .clock = .{ .context = &clock, .now_ms_fn = CountedClock.now } });
    defer owner.deinit();
    const handle = try owner.submit(fixture.chain_id_body, 1000, 500, 32768);
    defer owner.cancel(handle);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() == 0) {
        if (timer.read() > std.time.ns_per_s) return error.FixtureStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const before = clock.calls.load(.acquire);
    std.Thread.sleep(30 * std.time.ns_per_ms);
    const elapsed = clock.calls.load(.acquire) - before;
    // A busy owner executes thousands of clock reads here. Allow scheduling
    // jitter/callback work while bounding actual owner work during an idle I/O.
    try std.testing.expect(elapsed < 200);
    try std.testing.expect((try owner.poll(handle, a)) == null);
    try server.check();
}
