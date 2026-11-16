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
const envelope = @import("../net/json_envelope.zig");
const wake_notifier = @import("../runtime/wake.zig");
const fiber = @import("../runtime/fiber.zig");
const cancel_wake = @import("../runtime/cancel_wake.zig");

/// `validated`: the Pool already authenticated this envelope against the
/// request id; the caller may adopt the exact result span.
pub const WireResponse = struct { bytes: []u8, len: usize, validated: ?envelope.Validated = null };
/// Borrowed cancellation flags observed by a blocking wait (either raises).
pub const Cancels = struct {
    first: ?*const std.atomic.Value(bool) = null,
    second: ?*const std.atomic.Value(bool) = null,
    pub fn raised(self: Cancels) bool {
        if (self.first) |flag| if (flag.load(.acquire)) return true;
        if (self.second) |flag| if (flag.load(.acquire)) return true;
        return false;
    }
    fn present(self: Cancels) bool {
        return self.first != null or self.second != null;
    }
};
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
    /// Digest of the complete identity, computed once for tip-cache keys.
    tip_identity: tip_cache.Identity,
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

/// One JSON-RPC request, tokenized once without a tree. `params` is a tree
/// only for methods whose params the Pool inspects (see `inspectsParams`);
/// otherwise it is `.null` and no Pool path reads it.
const Request = struct {
    body: []u8,
    method: []const u8,
    method_owned: bool = false,
    id: i64,
    params: Value = .null,
    params_tree: ?std.json.Parsed(Value) = null,
    owned_params: ?std.json.Array = null,

    fn parse(allocator: A, body: []const u8, max_bytes: usize, quorum: bool) !Request {
        if (body.len == 0 or body.len > max_bytes) return error.InvalidRpcRequest;
        const top = try envelope.scan(allocator, body, envelope.pool_options);
        return adopt(allocator, body, &top, quorum);
    }

    /// A body the caller already scanned (read-only policy): only the Pool's
    /// own size and depth bounds remain before adopting that scan.
    fn scanned(allocator: A, body: []const u8, top: *const envelope.Top, max_bytes: usize, quorum: bool) !Request {
        if (body.len == 0 or body.len > max_bytes) return error.InvalidRpcRequest;
        if (top.max_depth > envelope.max_depth) return error.JsonDepthExceeded;
        return adopt(allocator, body, top, quorum);
    }

    fn adopt(allocator: A, body: []const u8, top: *const envelope.Top, quorum: bool) !Request {
        const facts = try envelope.requestFacts(top, body);
        const id = std.fmt.parseInt(i64, facts.id.of(body), 10) catch return error.InvalidRpcRequest;
        const owned = try allocator.dupe(u8, body);
        errdefer allocator.free(owned);
        const method = try envelope.stringAlloc(allocator, owned, facts.method);
        errdefer if (method.owned) allocator.free(method.text);
        if (method.text.len == 0) return error.InvalidRpcRequest;
        var request: Request = .{ .body = owned, .method = method.text, .method_owned = method.owned, .id = id };
        if (inspectsParams(method.text, quorum)) {
            if (facts.params) |span| {
                const tree = try envelope.parseValue(allocator, span.of(owned), false);
                request.params_tree = tree;
                request.params = tree.value;
            } else request.params = .{ .array = std.json.Array.init(allocator) };
        }
        return request;
    }

    /// The exact body the former stringify-then-parse round trip produced,
    /// without the parse. `params` stays borrowed unless `owned_params`
    /// transfers it (the caller keeps ownership on error).
    fn fromParts(allocator: A, id: i64, method: []const u8, params: Value, owned_params: ?std.json.Array, max_bytes: usize) !Request {
        const body = try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = params }, .{});
        errdefer allocator.free(body);
        if (body.len > max_bytes) return error.InvalidRpcRequest;
        const name = try allocator.dupe(u8, method);
        return .{ .body = body, .method = name, .method_owned = true, .id = id, .params = params, .owned_params = owned_params };
    }

    fn deinit(self: *Request, allocator: A) void {
        if (self.params_tree) |tree| tree.deinit();
        if (self.owned_params) |*params| params.deinit();
        if (self.method_owned) allocator.free(self.method);
        allocator.free(self.body);
        self.* = undefined;
    }
};

const block_parameter_methods = [_][]const u8{ "eth_call", "eth_createAccessList", "eth_getStorageAt", "eth_getCode", "eth_getProof", "eth_estimateGas", "trace_call", "trace_block" };
/// Methods whose params some Pool path reads: header validation, hedging,
/// tip-cache keys, CometBFT tx absence, and (quorum) block-tag pinning.
fn inspectsParams(method: []const u8, quorum: bool) bool {
    const always = [_][]const u8{ "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getProof", "tx" };
    for (always) |candidate| if (std.mem.eql(u8, method, candidate)) return true;
    if (quorum) for (block_parameter_methods) |candidate| if (std.mem.eql(u8, method, candidate)) return true;
    return false;
}

const Winner = struct { bytes: []u8, validated: ?envelope.Validated };

/// A validated upstream envelope: exact result span or the (small) error
/// tree. A result tree is built only for the consumers that need one.
const ParsedResponse = struct {
    bytes: []u8,
    result: ?envelope.Span,
    rpc_error: ?Value,
    error_tree: ?std.json.Parsed(Value),
    result_tree: ?std.json.Parsed(Value) = null,
    /// The Ethereum header-result check already ran on this exact response.
    header_checked: bool = false,
    /// Header fields that check decoded (number and hash known).
    header: ?envelope.HeaderFacts = null,
    reserved_bytes: usize,
    charged: bool = false,

    fn parse(allocator: A, body: []const u8, expected_id: i64, max_bytes: usize) !ParsedResponse {
        if (body.len > max_bytes) return error.ResponseTooLarge;
        return parseOwned(allocator, try allocator.dupe(u8, body), expected_id, max_bytes);
    }

    /// Takes ownership of `bytes` (allocated by `allocator`), freed on error.
    fn parseOwned(allocator: A, bytes: []u8, expected_id: i64, max_bytes: usize) !ParsedResponse {
        errdefer allocator.free(bytes);
        if (bytes.len > max_bytes) return error.ResponseTooLarge;
        const response = try envelope.validateResponse(allocator, bytes, expected_id, .pool);
        const tree = response.rpc_error;
        return .{ .bytes = bytes, .result = response.result, .rpc_error = if (tree) |value| value.value else null, .error_tree = tree, .reserved_bytes = bytes.len + if (tree) |value| value.arena.queryCapacity() else 0 };
    }

    fn resultBytes(self: *const ParsedResponse) []const u8 {
        return self.result.?.of(self.bytes);
    }

    /// Result tree (parse_numbers=false, strings borrowed from `bytes`),
    /// built on first use. Consumers build it before any retain so the
    /// byte budget charges it.
    fn resultValue(self: *ParsedResponse, allocator: A) !Value {
        if (self.result_tree) |tree| return tree.value;
        const tree = try envelope.parseValue(allocator, self.resultBytes(), false);
        self.result_tree = tree;
        if (!self.charged) self.reserved_bytes += tree.arena.queryCapacity();
        return tree.value;
    }

    fn deinit(self: *ParsedResponse, allocator: A) void {
        allocator.free(self.takeBytes(allocator));
    }

    fn takeBytes(self: *ParsedResponse, allocator: A) []u8 {
        _ = allocator;
        if (self.result_tree) |tree| tree.deinit();
        if (self.error_tree) |tree| tree.deinit();
        const bytes = self.bytes;
        self.* = undefined;
        return bytes;
    }

    /// Winner bytes plus the validated result span the caller may adopt.
    fn takeWinner(self: *ParsedResponse, allocator: A) Winner {
        const validated: ?envelope.Validated = if (self.result) |span| .{ .result = span, .header_checked = self.header_checked, .header = self.header } else null;
        return .{ .bytes = self.takeBytes(allocator), .validated = validated };
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
    winner_validated: ?envelope.Validated = null,
    winner_speculative: bool = false,
    waiting_probe: bool = false,
    reported_start: bool = false,
    failure: ?anyerror = null,
    finished: bool = false,
    taken: std.atomic.Value(bool) = .init(false),
    /// Pool.mutex: a blocking `wait` caller sleeps on `wake` for this session.
    blocking_waiter: bool = false,
    /// Session.mutex: the departing driver handed the drive token to this waiter.
    grant: bool = false,
    /// Session.mutex: a parked fiber waiting for this session's completion.
    fiber_waiter: ?*fiber.Waiter = null,
    /// Completion resumes suspended (PendingReadIo) supervisor tasks. Off for
    /// sessions whose waiter is woken directly (blocking or fiber wait).
    notify_io: bool = true,

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
    /// Owner loop passes; evidence that the owner blocks on sockets/timers.
    owner_iterations: std.atomic.Value(u64) = .init(0),
    wait_failure: ?anyerror = null,
    /// Owner-only: an outcome was handled this pass (completion, cache hit,
    /// cooldown). Follow-up submissions happen in the next progress pass, so
    /// the owner must not block before running it.
    dirty: bool = false,
    /// Drive token: whoever holds it runs owner passes (native multi, session
    /// progress, retirement). A blocking `wait` caller takes it when free and
    /// drives its own request, so an uncontended RPC needs no thread handoff.
    driver: std.Thread.Mutex = .{},
    /// Pool.mutex: a `wait` caller holds the token / a waiter was granted it.
    caller_driving: bool = false,
    granted: bool = false,
    /// Passes run by blocking callers vs the owner thread (work-count evidence).
    caller_passes: std.atomic.Value(u64) = .init(0),
    /// Returns of the idle owner from its condition wait (handoff evidence).
    owner_wakes: std.atomic.Value(u64) = .init(0),
    /// Drive-token counters (diagnostics): native waits by calling drivers and
    /// by the owner thread, waits whose bound was the caller cancel slice,
    /// and drives a fiber left because a sibling became runnable.
    drive_waits: u64 = 0,
    owner_waits: u64 = 0,
    slice_bounded: u64 = 0,
    sibling_yields: u64 = 0,
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
            try endpoints.append(allocator, .{ .owned = owned, .tip_identity = tip_cache.identity(owned.identity), .headers = native_headers });
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
        self.native.wakeup();
        self.mutex.unlock();
        self.thread.join();
        for (self.sessions) |entry| if (entry) |session| self.destroySession(session);
        std.debug.assert(self.retained_bytes == 0);
        for (self.probes) |entry| if (entry) |probe| probe.deinit(self.allocator);
        var extra: [256]u8 = undefined;
        self.native.reportStats("evm.pool", std.fmt.bufPrint(&extra, ",\"drive_waits\":{d},\"owner_waits\":{d},\"slice_bounded\":{d},\"sibling_yields\":{d},\"owner_wakes\":{d},\"caller_passes\":{d},\"owner_iterations\":{d}", .{ self.drive_waits, self.owner_waits, self.slice_bounded, self.sibling_yields, self.owner_wakes.load(.monotonic), self.caller_passes.load(.monotonic), self.owner_iterations.load(.monotonic) }) catch "");
        self.native.stats_reported = true;
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

    /// Pool milliseconds used by deadlines (`wait`), injected clock if any.
    pub fn now(self: *Pool) u64 {
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
        return self.submitSession(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, true);
    }
    /// For a caller that will `wait` (or `waitCancels`) promptly: the owner
    /// thread is not woken; the waiting caller drives the session itself.
    pub fn submitDeferred(self: *Pool, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool) !Handle {
        return self.submitSession(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, false);
    }
    /// Like `submitDeferred` for a body the caller already scanned once (the
    /// cooperative read-only policy): the Pool adopts that scan instead of
    /// tokenizing the body again. `top` must describe exactly `body`.
    pub fn submitScanned(self: *Pool, body: []const u8, top: *const envelope.Top, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool) !Handle {
        return self.submitRequest(body, top, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, false);
    }
    /// `wake_owner` false: the caller drives the session itself in `wait`.
    fn submitSession(self: *Pool, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool, wake_owner: bool) !Handle {
        return self.submitRequest(body, null, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, wake_owner);
    }
    fn submitRequest(self: *Pool, body: []const u8, scanned: ?*const envelope.Top, timeout_ms: u32, connect_timeout_ms: u32, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool, wake_owner: bool) !Handle {
        if (observer_override) |observer| if (!observer.valid()) return error.InvalidRpcObserver;
        if (timeout_ms == 0 or connect_timeout_ms == 0 or max_response_bytes == 0 or max_response_bytes > self.config.max_response_bytes) return error.InvalidRpcLimit;
        const session = blk: {
            const quorum = self.config.strategy == .quorum;
            var original = if (scanned) |top| try Request.scanned(self.allocator, body, top, self.config.max_request_bytes, quorum) else try Request.parse(self.allocator, body, self.config.max_request_bytes, quorum);
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
        const slot = self.freeSlotLocked() orelse retry: {
            // Taken, drained sessions wait for a driver pass to retire; when
            // nobody drives, retire them now instead of refusing work.
            if (self.driver.tryLock()) {
                self.retireLocked();
                self.driver.unlock();
            }
            break :retry self.freeSlotLocked() orelse {
                self.mutex.unlock();
                session.deinit();
                return error.RpcPoolSessionsFull;
            };
        };
        session.notify_io = wake_owner;
        self.sessions[slot] = session;
        if (wake_owner) self.wakeOwner();
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
        const validated = session.winner_validated;
        session.winner = null;
        session.fiber_waiter = null;
        session.taken.store(true, .release);
        session.mutex.unlock();
        // Retire now when nobody drives (no thread handoff); otherwise the
        // driver retires it on its next pass. The next submit wakes the owner
        // anyway, so a wake just to retire is spent only when this was the
        // last free slot (a submit could otherwise see SessionsFull).
        if (self.driver.tryLock()) {
            self.retireLocked();
            self.driver.unlock();
        } else if (self.freeSlotLocked() == null) self.native.wakeup();
        self.mutex.unlock();
        if (failure) |err| return err;
        const bytes = winner orelse return error.MissingRpcPoolResult;
        // Same allocator: move the winner instead of copying it.
        if (allocator.ptr == self.allocator.ptr and allocator.vtable == self.allocator.vtable) return .{ .bytes = bytes, .len = bytes.len, .validated = validated };
        defer self.allocator.free(bytes);
        const copied = try allocator.dupe(u8, bytes);
        return .{ .bytes = copied, .len = copied.len, .validated = validated };
    }
    /// No borrowed caller token survives cancellation. This consumes the handle;
    /// cancel is idempotent, including after terminal poll or slot retirement.
    pub fn cancel(self: *Pool, handle: Handle) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.findSession(handle) orelse return;
        session.mutex.lock();
        session.fiber_waiter = null;
        session.mutex.unlock();
        session.closed.store(true, .release);
        session.taken.store(true, .release);
        self.wakeOwner();
    }
    /// Wake `waiter` when the session becomes terminal. False when it already
    /// is (poll now). The registration ends at terminal poll, cancel or
    /// `detachWaiter`, all under the session mutex.
    pub fn attachWaiter(self: *Pool, handle: Handle, waiter: *fiber.Waiter) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.findSession(handle) orelse return false;
        session.mutex.lock();
        defer session.mutex.unlock();
        if (session.finished) return false;
        session.fiber_waiter = waiter;
        return true;
    }
    pub fn detachWaiter(self: *Pool, handle: Handle) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.findSession(handle) orelse return;
        session.mutex.lock();
        session.fiber_waiter = null;
        session.mutex.unlock();
    }
    /// Caller holds Pool.mutex. The idle owner waits on the condition; a busy
    /// owner blocks in the native epoll/kqueue wait, interrupted by its wakeup.
    fn wakeOwner(self: *Pool) void {
        // A driving caller or granted waiter progresses every session and
        // hands remaining work over in releaseDriver (under this mutex), so a
        // signal would only wake the idle owner to sleep again. The current
        // driver's socket wait is interrupted either way.
        if (!self.caller_driving and !self.granted) self.wake.signal();
        self.native.wakeup();
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
        const handle = try self.submitSession(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, false);
        return self.waitCancels(handle, allocator, self.now() +| timeout_ms, .{ .first = cancel_flag });
    }
    /// Blocking read observing two borrowed cancellation flags (job and
    /// request); the caller drives its own session when the token is free.
    pub fn fetchCancels(self: *Pool, allocator: A, body: []const u8, timeout_ms: u32, connect_timeout_ms: u32, cancels: Cancels, max_response_bytes: usize, observer_override: ?Observer, use_tip_cache: bool) !WireResponse {
        if (cancels.raised()) return error.RequestCancelled;
        const handle = try self.submitSession(body, timeout_ms, connect_timeout_ms, max_response_bytes, observer_override, use_tip_cache, false);
        return self.waitCancels(handle, allocator, self.now() +| timeout_ms, cancels);
    }
    /// Block the calling thread until a submitted handle is terminal. Consumes
    /// the handle on every return: terminal poll, or cancel on caller
    /// deadline (pool `now` milliseconds) / cancellation. Callers may submit
    /// several independent handles first and then wait for each in turn.
    pub fn wait(self: *Pool, handle: Handle, allocator: A, deadline_ms: u64, cancel_flag: ?*const std.atomic.Value(bool)) !WireResponse {
        return self.waitCancels(handle, allocator, deadline_ms, .{ .first = cancel_flag });
    }
    pub fn waitCancels(self: *Pool, handle: Handle, allocator: A, deadline_ms: u64, cancel_flag: Cancels) !WireResponse {
        // A fiber drives only while no sibling on its loop is runnable (and
        // a sibling's wake interrupts its socket wait); otherwise it parks
        // until the current driver completes the session.
        if (fiber.inFiber()) return self.waitParked(handle, allocator, deadline_ms, cancel_flag);
        defer self.cancel(handle);
        // A runtime raise of a borrowed flag (runtime/cancel_wake.zig) ends
        // the driver's socket wait or this follower's wait at once; the
        // slice below only backstops flags raised by a plain store.
        var cancel_waker: CancelWaker = .{ .pool = self };
        var cancel_registration: cancel_wake.Pair = .{};
        defer cancel_registration.unregister();
        cancel_waker.follower = handle;
        cancel_registration.register(cancel_flag.first, cancel_flag.second, cancel_waker.waker());
        // The session may have been submitted without waking a driver; tell
        // the current driver once (not once per timed slice).
        var driver_told = false;
        while (true) {
            if (try self.poll(handle, allocator)) |response| return response;
            if (cancel_flag.raised()) return error.RequestCancelled;
            const now_ms = self.now();
            if (now_ms >= deadline_ms) return error.RequestDeadlineExceeded;
            // Leader: nobody drives, so this thread runs owner passes until its
            // own session is terminal (or its deadline/cancel), then hands off.
            if (self.driver.tryLock()) {
                try self.driveFor(handle, deadline_ms, cancel_flag);
                driver_told = false;
                continue;
            }
            // Follower: the current driver progresses this session; completion
            // (or a drive grant) broadcasts. A timed slice remains only for a
            // borrowed cancel flag (no notifier) or an injected test clock.
            var slice_ms = deadline_ms - now_ms;
            if (cancel_flag.present()) slice_ms = @min(slice_ms, caller_cancel_slice_ms);
            if (self.config.clock != null) slice_ms = @min(slice_ms, injected_clock_slice_ms);
            self.mutex.lock();
            const session = self.findSession(handle) orelse {
                self.mutex.unlock();
                return error.InvalidRpcHandle;
            };
            session.blocking_waiter = true;
            // The driver may be blocked in a socket wait without this session.
            if (!driver_told) self.wakeOwner();
            driver_told = true;
            session.mutex.lock();
            self.mutex.unlock();
            // This handle has one caller, so taken remains false until it polls
            // or cancels. No driver can retire this session while waiting.
            if (!session.finished and !session.grant and !cancel_flag.raised()) session.wake.timedWait(&session.mutex, slice_ms *| std.time.ns_per_ms) catch {};
            session.mutex.unlock();
            // Grants are issued under Pool.mutex while blocking_waiter is set:
            // consume and stop accepting them atomically, so no grant can land
            // after this point and leave `granted` set with nobody driving.
            self.mutex.lock();
            session.mutex.lock();
            const granted = session.grant;
            session.grant = false;
            session.mutex.unlock();
            session.blocking_waiter = false;
            if (granted) self.granted = false;
            self.mutex.unlock();
            // A granted waiter drives now; if the token was taken meanwhile,
            // that holder drives instead. Either way no work is left undriven.
            if (granted and self.driver.tryLock()) try self.driveFor(handle, deadline_ms, cancel_flag);
        }
    }
    /// Fiber wait: wake the owner (the session may have been submitted for
    /// a driving caller), park on a Waiter that Pool.finish wakes, then poll.
    /// Same deadline (pool ms) and cancellation semantics as `wait`.
    fn waitParked(self: *Pool, handle: Handle, allocator: A, deadline_ms: u64, cancel_flag: Cancels) !WireResponse {
        // Terminal poll or cancel ends the waiter registration under the
        // session mutex before `waiter` leaves scope.
        defer self.cancel(handle);
        var waiter: fiber.Waiter = .{};
        // A runtime cancel raise wakes the parked fiber (or its socket wait
        // when it drives); unregistered before `waiter` leaves scope.
        var cancel_waker: CancelWaker = .{ .pool = self, .waiter = &waiter };
        var cancel_registration: cancel_wake.Pair = .{};
        defer cancel_registration.unregister();
        cancel_registration.register(cancel_flag.first, cancel_flag.second, cancel_waker.waker());
        var attached = false;
        var owner_told = false;
        while (true) {
            if (try self.poll(handle, allocator)) |response| return response;
            if (cancel_flag.raised()) return error.RequestCancelled;
            const now_ms = self.now();
            if (now_ms >= deadline_ms) return error.RequestDeadlineExceeded;
            // Leader on the fiber's own thread: no owner handoff, no wake back.
            if (fiber.mayBlockThread() and self.driver.tryLock()) {
                fiber.setInterrupt(.{ .ctx = self, .call = interruptDriver });
                defer fiber.setInterrupt(null);
                try self.driveFor(handle, deadline_ms, cancel_flag);
                owner_told = false;
                continue;
            }
            if (!owner_told) {
                // The session may have been submitted for a driving caller.
                self.mutex.lock();
                self.wakeOwner();
                self.mutex.unlock();
                owner_told = true;
            }
            if (!attached) {
                attached = true;
                _ = self.attachWaiter(handle, &waiter);
                continue; // it may have finished before the registration
            }
            // Completion wakes the fiber; borrowed cancel flags have no
            // notifier, so they are rechecked on a coarse slice.
            var slice_ms = deadline_ms - now_ms;
            if (cancel_flag.present()) slice_ms = @min(slice_ms, parked_cancel_slice_ms);
            if (self.config.clock != null) slice_ms = @min(slice_ms, injected_clock_slice_ms);
            _ = waiter.waitTimeout(fiber.monoMs() +| @as(i64, @intCast(@min(slice_ms, std.math.maxInt(i32)))));
        }
    }
    /// Wakes a wait that observes a borrowed cancel flag when the runtime
    /// raises it: the socket wait (if this caller drives), the follower's
    /// session condition, or the parked fiber.
    const CancelWaker = struct {
        pool: *Pool,
        /// Blocking caller: its session is looked up per wake (a session
        /// pointer could be retired once the caller polled it).
        follower: ?Handle = null,
        waiter: ?*fiber.Waiter = null,
        fn waker(self: *CancelWaker) cancel_wake.Waker {
            return .{ .context = self, .call = call };
        }
        fn call(context: *anyopaque) void {
            const self: *CancelWaker = @ptrCast(@alignCast(context));
            self.pool.native.wakeup();
            if (self.follower) |handle| {
                self.pool.mutex.lock();
                defer self.pool.mutex.unlock();
                const session = self.pool.findSession(handle) orelse return;
                session.mutex.lock();
                session.wake.broadcast();
                session.mutex.unlock();
            }
            if (self.waiter) |waiter| waiter.wake();
        }
    };
    fn interruptDriver(context: *anyopaque) void {
        const self: *Pool = @ptrCast(@alignCast(context));
        self.native.wakeup();
    }
    /// Caller holds the drive token; released (and handed off) on return.
    fn driveFor(self: *Pool, handle: Handle, deadline_ms: u64, cancel_flag: Cancels) !void {
        self.mutex.lock();
        self.caller_driving = true;
        const own = self.findSession(handle);
        self.mutex.unlock();
        defer self.releaseDriver(true);
        const session = own orelse return error.InvalidRpcHandle;
        while (true) {
            const pass_ = self.pass();
            _ = self.caller_passes.fetchAdd(1, .monotonic);
            // Only the driver finishes sessions, and this caller has not taken
            // its own session, so it cannot be retired while driving.
            if (session.finished) return;
            if (cancel_flag.raised()) return;
            if (pass_.now_ms >= deadline_ms) return;
            // A fiber driver yields its thread as soon as a sibling is runnable.
            if (fiber.siblingReady()) {
                self.sibling_yields += 1;
                return;
            }
            if (pass_.busy) continue;
            var cap: u64 = deadline_ms - pass_.now_ms;
            if (cancel_flag.present()) cap = @min(cap, caller_cancel_slice_ms);
            self.drive_waits += 1;
            if (cap < pass_.timeout and cap == caller_cancel_slice_ms) self.slice_bounded += 1;
            self.native.wait(pass_.now_ms, @intCast(@min(pass_.timeout, cap))) catch |err| {
                self.wait_failure = err;
            };
        }
    }
    /// Drop the drive token, then give remaining work to a blocked waiter
    /// (it must wake anyway) or else to the owner thread.
    fn releaseDriver(self: *Pool, caller: bool) void {
        self.driver.unlock();
        self.mutex.lock();
        defer self.mutex.unlock();
        if (caller) self.caller_driving = false;
        if (!self.needsDriverLocked()) return;
        for (self.sessions) |entry| if (entry) |session| {
            if (!session.blocking_waiter) continue;
            session.mutex.lock();
            defer session.mutex.unlock();
            if (session.finished or session.grant) continue;
            session.grant = true;
            self.granted = true;
            session.wake.signal();
            return;
        };
        self.wake.signal();
    }
    /// Pool.mutex held. Work exists that only a driver can advance: a probe,
    /// an unfinished session, a taken session awaiting retirement, or stop.
    fn needsDriverLocked(self: *Pool) bool {
        for (self.probes) |entry| if (entry != null) return true;
        for (self.sessions) |entry| if (entry) |session| {
            if (self.stopping.load(.acquire) or session.taken.load(.acquire)) return true;
            session.mutex.lock();
            const finished = session.finished;
            session.mutex.unlock();
            if (!finished) return true;
        };
        return false;
    }
    fn freeSlotLocked(self: *Pool) ?usize {
        for (self.sessions, 0..) |entry, index| if (entry == null) return index;
        return null;
    }
    /// Pool.mutex and the drive token held.
    fn retireLocked(self: *Pool) void {
        for (self.sessions) |*entry| if (entry.*) |session| {
            const drained = for (session.peers) |peer| {
                if (peer.native_id != null) break false;
            } else true;
            if (drained and !session.waiting_probe and (session.taken.load(.acquire) or self.stopping.load(.acquire))) {
                entry.* = null;
                self.destroySession(session);
            }
        };
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
            session.current = try Request.fromParts(self.allocator, request.id, "eth_blockNumber", .{ .array = std.json.Array.init(self.allocator) }, null, session.max_request_bytes);
        } else {
            var params = std.json.Array.init(self.allocator);
            errdefer params.deinit();
            try params.append(tag);
            try params.append(.{ .bool = false });
            // The new request owns this array; the tag string stays borrowed
            // from the original, which outlives it.
            session.current = try Request.fromParts(self.allocator, request.id, "eth_getBlockByNumber", .{ .array = params }, params, session.max_request_bytes);
        }
        session.phase_started_ms = session.started_ms;
    }

    /// Owner thread: the fallback driver for asynchronous handles, retiring
    /// sessions and shutdown. Idle while a `wait` caller holds the token.
    fn run(self: *Pool) void {
        while (true) {
            self.mutex.lock();
            while (!self.stopping.load(.acquire) and (self.caller_driving or self.granted or !self.needsDriverLocked())) {
                self.wake.wait(&self.mutex);
                _ = self.owner_wakes.fetchAdd(1, .monotonic);
            }
            self.mutex.unlock();
            self.driver.lock();
            while (true) {
                const pass_ = self.pass();
                if (pass_.empty and pass_.stopped) {
                    self.driver.unlock();
                    return;
                }
                if (!pass_.needs_driver) break;
                if (pass_.busy) continue;
                self.owner_waits += 1;
                self.native.wait(pass_.now_ms, pass_.timeout) catch |err| {
                    self.wait_failure = err;
                };
            }
            self.releaseDriver(false);
        }
    }

    const Pass = struct { now_ms: u64, empty: bool, stopped: bool, needs_driver: bool, busy: bool, timeout: u32 };
    /// Drive token held. One owner pass: progress, drain native completions,
    /// retire. `busy` means follow-up work exists; run another pass first.
    fn pass(self: *Pool) Pass {
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
        var completed = false;
        // Outcomes handled during progress (cache hits, cooldown skips)
        // also need another pass before blocking.
        const progressed = self.dirty;
        self.dirty = false;
        while (self.pollNative(now_ms) catch |err| blk: {
            for (snapshot[0..self.sessions.len]) |entry| if (entry) |session| if (!session.finished) self.finish(session, err);
            break :blk null;
        }) |value| {
            var completion = value;
            defer completion.deinit();
            self.complete(snapshot[0..self.sessions.len], &completion, now_ms);
            completed = true;
        }
        _ = self.owner_iterations.fetchAdd(1, .monotonic);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.retireLocked();
        const empty_sessions = for (self.sessions) |entry| {
            if (entry != null) break false;
        } else true;
        const empty_probes = for (self.probes) |entry| {
            if (entry != null) break false;
        } else true;
        // Live table under the mutex: the snapshot may name sessions retired
        // above. Completions only mutate state; their follow-ups happen in the
        // next progress pass, so a busy pass must not block.
        return .{
            .now_ms = now_ms,
            .empty = empty_sessions and empty_probes,
            .stopped = self.stopping.load(.acquire),
            .needs_driver = self.needsDriverLocked(),
            .busy = completed or progressed or self.dirty,
            .timeout = self.nextWaitMs(self.sessions, now_ms),
        };
    }

    fn pollNative(self: *Pool, now_ms: u64) !?multi.Completion {
        // Reported once to the sessions live at failure, like a poll error.
        if (self.wait_failure) |err| {
            self.wait_failure = null;
            return err;
        }
        // Every driver blocks in native.wait whenever a pass is not busy, so
        // readiness is gathered there: a pass makes no kernel call of its own.
        return self.native.advance(now_ms);
    }
    /// Owner thread, after progress. Over-approximates every owner timer: an
    /// early wake costs one pass, a missed timer would stall a session.
    fn nextWaitMs(self: *Pool, sessions: []const ?*Session, now_ms: u64) u32 {
        var next: u64 = std.math.maxInt(u64);
        for (self.probes) |entry| if (entry) |probe| {
            next = @min(next, probe.deadline_ms);
            // Budget-deferred probes and cross-Pool tip-cache followers have no
            // socket or timer of their own: poll them cooperatively.
            if (probe.native_id == null or probe.cache_follower) next = @min(next, now_ms +| cooperative_poll_ms);
        };
        for (sessions) |entry| if (entry) |session| {
            if (session.finished) continue;
            next = @min(next, session.deadline_ms);
            for ([_]u64{ session.round_wait_ms, session.grace_deadline_ms, session.numeric_grace_deadline_ms }) |timer| if (timer > now_ms) {
                next = @min(next, timer);
            };
            for (session.peers) |peer| {
                if (peer.cache_follower) next = @min(next, now_ms +| cooperative_poll_ms);
                if (!peer.done and peer.native_id == null and peer.next_attempt_ms > now_ms) next = @min(next, peer.next_attempt_ms);
            }
        };
        // Injected clocks are not wall durations; fixtures advance them freely.
        if (self.config.clock != null) next = @min(next, now_ms +| cooperative_poll_ms);
        if (next == std.math.maxInt(u64)) return std.math.maxInt(u32);
        return @intCast(@min(@max(next -| now_ms, 1), std.math.maxInt(u32)));
    }

    fn complete(self: *Pool, sessions: []?*Session, completion: *multi.Completion, now_ms: u64) void {
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
                        // Native response-buffer allocation failure is never a
                        // provider fault: fail the session instead of retrying.
                        if (err == error.OutOfMemory) {
                            self.finish(session, err);
                            return;
                        }
                        var outcome: Outcome = .{ .classification = .retryable, .failure = err };
                        self.dispatchOutcome(session, index, &outcome, now_ms);
                    },
                    .response => |*response| {
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
                        // Same allocator: the parsed response adopts the native body.
                        var parsed = ParsedResponse.parseOwned(self.allocator, response.takeBody(), session.wire().id, session.max_response_bytes) catch |err| {
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
                        const header_method = @import("header.zig").isMethod(session.wire().method);
                        const known_tip = std.mem.eql(u8, session.wire().method, "eth_blockNumber") or (self.config.height_protocol != .ethereum and std.mem.eql(u8, session.wire().method, "eth_getBlockByNumber"));
                        const ethereum_header = classification == .success and header_method and self.config.height_protocol == .ethereum;
                        // The header check reads its fields from the result span when it
                        // can decide there; otherwise (and for tips) one tree is built.
                        const header_span: ?HeaderCheck = if (ethereum_header) headerResult(self.allocator, parsed.resultBytes(), headerPending(session.wire())) catch |err| {
                            self.reportUpstream(session, index, false, false);
                            parsed.deinit(self.allocator);
                            self.finish(session, err);
                            return;
                        } else null;
                        const header_decided: ?bool = if (header_span) |check| check != .invalid else null;
                        if (header_span) |check| if (check == .valid) {
                            parsed.header = check.valid;
                        };
                        const result_tree: ?Value = if (classification == .success and (known_tip or (ethereum_header and header_decided == null))) parsed.resultValue(self.allocator) catch |err| {
                            self.reportUpstream(session, index, false, false);
                            parsed.deinit(self.allocator);
                            self.finish(session, err);
                            return;
                        } else null;
                        if (classification == .success and self.config.height_protocol == .ethereum) {
                            if (header_method) {
                                var failure: ?anyerror = if (header_decided) |valid| (if (valid) null else error.RpcResponseDecode) else null;
                                if (header_decided == null) @import("header.zig").validateResult(session.wire().method, session.wire().params, result_tree.?) catch |err| {
                                    failure = err;
                                };
                                if (failure) |err| {
                                    self.reportUpstream(session, index, false, false);
                                    parsed.deinit(self.allocator);
                                    var invalid: Outcome = .{ .classification = .retryable, .failure = err };
                                    self.dispatchOutcome(session, index, &invalid, now_ms);
                                    return;
                                }
                            }
                            parsed.header_checked = true;
                        }
                        if (classification == .success and known_tip and !validTipResult(session.wire().method, result_tree.?)) {
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
        self.dirty = true;
        const peer = &session.peers[index];
        if (peer.cache_eligible and peer.cache_upstream_reported) {
            var stored = false;
            if (outcome.classification == .success) if (outcome.response) |*response| if (response.result != null) if (response.resultValue(self.allocator) catch null) |value| {
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
        self.dirty = true;
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
                const key = (try tip_cache.key(self.allocator, endpoint_.tip_identity, "eth_blockNumber", .null)).?;
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
        if (parsed.result == null) return null;
        const value = try parsed.resultValue(self.allocator);
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

    /// Allocation failure while probing: retire the probe and fail its session.
    fn abortProbe(self: *Pool, index: usize, probe: *Probe, err: anyerror) void {
        if (probe.submitted and probe.observer != null) emitObserved(probe.observer.?, .{ .kind = .upstream_completed, .method = self.probeMethod(), .success = false, .cancelled = probe.cancelled, .operation = .block_number_probe, .endpoint_index = @intCast(index), .duration_ms = self.now() -| probe.started_ms, .duration_ns = elapsedNs(probe.started_at, self.now() -| probe.started_ms) });
        const attached = probe.session;
        if (attached) |session| session.waiting_probe = false;
        self.probes[index] = null;
        if (attached) |session| self.finish(session, err);
        probe.deinit(self.allocator);
    }
    fn finishProbe(self: *Pool, index: usize, result: multi.Result, now_ms: u64) void {
        const probe = self.probes[index] orelse return;
        const endpoint_ = &self.endpoints[index];
        var height = endpoint_.last_block_height;
        var timed_out = false;
        var probe_success = false;
        switch (result) {
            .failure => |err| {
                if (err == error.OutOfMemory) return self.abortProbe(index, probe, err);
                timed_out = err == error.RequestDeadlineExceeded or err == error.RequestCancelled;
            },
            .response => |response| {
                // Ethereum Source rejects HTTP 429 before decoding but accepts valid
                // JSON-RPC bodies on other statuses. Other protocols stay 2xx-only.
                const accepted = response.status != 429 and (self.config.height_protocol == .ethereum or (response.status >= 200 and response.status < 300));
                const fetched_height = if (accepted) self.probeHeight(response) catch |err| return self.abortProbe(index, probe, err) else null;
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
        if (session.strategy == .fallback and session.phase == .actual and session.strategy.fallback.consider_null_transaction_receipt and std.mem.eql(u8, session.wire().method, "eth_getTransactionReceipt") and std.mem.eql(u8, response.resultBytes(), "null")) {
            response.deinit(self.allocator);
            session.peers[index].skip = true;
            session.peers[index].failed = true;
            if (self.activeCount(session) == 0 and session.next_peer >= session.peers.len) self.finishFallbackRound(session, now_ms);
            return;
        }
        switch (session.strategy) {
            .single, .fallback => {
                session.winner_speculative = session.peers[index].speculative;
                self.finishWinner(session, response.takeWinner(self.allocator));
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
        const result = try response.resultValue(self.allocator);
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
        // Built before any retain: retained peer responses already hold theirs.
        const value = try response.resultValue(self.allocator);
        for (session.peers, 0..) |*peer, other| {
            if (other == index or peer.response == null) continue;
            if (normalizedEqual(try peer.response.?.resultValue(self.allocator), value)) {
                peer.votes += 1;
                if (peer.votes >= self.threshold) {
                    self.releaseResponse(&peer.response.?);
                    const winner = peer.response.?.takeWinner(self.allocator);
                    peer.response = null;
                    response.deinit(self.allocator);
                    self.finishWinner(session, winner);
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
            const winner = session.peers[index].response.?.takeWinner(self.allocator);
            session.peers[index].response = null;
            self.finishWinner(session, winner);
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
        const parsed = try ParsedResponse.parseOwned(self.allocator, body, session.wire().id, session.max_response_bytes);
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
        const hash = (try tip_cache.key(self.allocator, self.endpoints[index].tip_identity, session.wire().method, session.wire().params)) orelse return false;
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
    fn headerPending(request: *const Request) bool {
        const params = request.params;
        return std.mem.eql(u8, request.method, "eth_getBlockByNumber") and params == .array and params.array.items.len > 0 and params.array.items[0] == .string and std.mem.eql(u8, params.array.items[0].string, "pending");
    }
    const HeaderField = enum { number, hash, parentHash, timestamp, gasLimit, baseFeePerGas };
    /// header.validateResult decided from the result span's members (every
    /// failure there is RpcResponseDecode, so validity is all it reports).
    /// Null: escaped strings or anything else the span walk will not decide;
    /// the caller then builds the tree and runs header.validateResult itself.
    fn headerResultValid(allocator: A, result: []const u8, pending: bool) !?bool {
        const check = try headerResult(allocator, result, pending) orelse return null;
        return check != .invalid;
    }
    /// A decided header check; `valid` carries the fields Header.parse would
    /// return (null for a null block or a pending one without number/hash).
    const HeaderCheck = union(enum) { invalid, valid: ?envelope.HeaderFacts };
    fn headerResult(allocator: A, result: []const u8, pending: bool) !?HeaderCheck {
        if (std.mem.eql(u8, result, "null")) return .{ .valid = null };
        const found = (try @import("../net/json_fast.zig").fields(HeaderField, allocator, result)) orelse return null;
        const codecs = @import("codecs.zig");
        const Text = union(enum) { text: []const u8, null_value, invalid, undecided };
        const text = struct {
            fn of(bytes: []const u8, member: ?envelope.Member) Text {
                const value = member orelse return .invalid;
                const raw = value.span.of(bytes);
                if (value.kind == .other and std.mem.eql(u8, raw, "null")) return .null_value;
                if (value.kind != .string) return .invalid;
                if (std.mem.indexOfScalar(u8, raw, '\\') != null) return .undecided;
                return .{ .text = raw[1 .. raw.len - 1] };
            }
        }.of;
        if (found[@intFromEnum(HeaderField.gasLimit)] != null) switch (text(result, found[@intFromEnum(HeaderField.gasLimit)])) {
            .text => |value| _ = codecs.quantityAs(u256, value) catch return .invalid,
            .undecided => return null,
            else => return .invalid,
        };
        if (found[@intFromEnum(HeaderField.baseFeePerGas)] != null) switch (text(result, found[@intFromEnum(HeaderField.baseFeePerGas)])) {
            .text => |value| _ = codecs.quantityAs(u256, value) catch return .invalid,
            .null_value => {},
            .undecided => return null,
            .invalid => return .invalid,
        };
        const number: ?u64 = switch (text(result, found[@intFromEnum(HeaderField.number)])) {
            .text => |value| codecs.quantity(value) catch return .invalid,
            .null_value => null,
            .undecided => return null,
            .invalid => return .invalid,
        };
        const hash: ?[32]u8 = switch (text(result, found[@intFromEnum(HeaderField.hash)])) {
            .text => |value| codecs.fixedHex(32, value) catch return .invalid,
            .null_value => null,
            .undecided => return null,
            .invalid => return .invalid,
        };
        const parent_hash = switch (text(result, found[@intFromEnum(HeaderField.parentHash)])) {
            .text => |value| codecs.fixedHex(32, value) catch return .invalid,
            .undecided => return null,
            else => return .invalid,
        };
        const timestamp = switch (text(result, found[@intFromEnum(HeaderField.timestamp)])) {
            .text => |value| codecs.quantity(value) catch return .invalid,
            .undecided => return null,
            else => return .invalid,
        };
        const unknown: HeaderCheck = if (pending) .{ .valid = null } else .invalid;
        return .{ .valid = .{ .number = number orelse return unknown, .hash = hash orelse return unknown, .parent_hash = parent_hash, .timestamp = timestamp } };
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
            const winner = session.peers[chosen].response.?.takeWinner(self.allocator);
            session.peers[chosen].response = null;
            if (session.phase == .actual) {
                self.finishWinner(session, winner);
            } else {
                self.allocator.free(winner.bytes);
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
        session.current = try Request.fromParts(self.allocator, session.original.id, session.original.method, session.original.params, null, session.max_request_bytes);
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
        self.finishWinner(session, .{ .bytes = bytes, .validated = null });
    }

    fn finishWinner(self: *Pool, session: *Session, winner: Winner) void {
        session.winner = winner.bytes;
        session.winner_validated = winner.validated;
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
        // Woken under the session mutex: detach also takes it, so the Waiter
        // (on the parked fiber's stack) cannot be gone during the wake.
        if (session.fiber_waiter) |waiter| {
            session.fiber_waiter = null;
            waiter.wake();
        }
        const notify_io = session.notify_io;
        session.mutex.unlock();
        if (notify_io) wake_notifier.notifyIo();
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

const cooperative_poll_ms: u64 = 2;
/// Cancellation recheck while a blocking caller waits or drives with a
/// borrowed cancel flag. Runtime raisers wake waits directly (cancel_wake);
/// this only backstops plain-store flags. Same bound as a parked fiber: Depot
/// wait counters showed a 10 ms slice ending 2.35 kernel waits per relayer
/// RPC, more than socket readiness (1.83); each was a voluntary switch.
const caller_cancel_slice_ms: u64 = 100;
/// Cancellation recheck while a fiber is parked on a session (no notifier).
pub const parked_cancel_slice_ms: u64 = 100;
const injected_clock_slice_ms: u64 = 5;

fn backoff(base_ms: u32, attempts: u8, classification: Classification) u64 {
    const shift: u8 = if (attempts <= 1) 0 else attempts - 1;
    const ordinary = @as(u64, base_ms) *| (@as(u64, 1) << @min(shift, 20));
    return if (classification == .rate_limited) @max(ordinary, 20000) else ordinary;
}

fn blockParameterIndex(method: []const u8, params: Value) ?usize {
    if (params != .array or params.array.items.len == 0) return null;
    if (std.mem.eql(u8, method, "eth_getBlockByNumber")) return 0;
    for (block_parameter_methods) |candidate| if (std.mem.eql(u8, method, candidate)) return params.array.items.len - 1;
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

/// Work per cooperative read, legacy chain vs one-scan chain, on the same
/// bytes: read-only policy, Pool request, Pool response envelope (plus the
/// header check where the method needs it) and the caller's decode.
fn rpcJsonWork(a: A, body: []const u8, bytes: []const u8, id: i64, legacy_chain: bool) !void {
    const legacy = @import("../net/json_envelope_differential_test.zig");
    const read_replay = @import("../net/read_replay.zig");
    const provider = @import("provider.zig");
    const header_method = std.mem.indexOf(u8, body, "eth_getBlockByNumber") != null;
    const copy = try a.dupe(u8, bytes);
    if (legacy_chain) {
        defer a.free(copy);
        _ = try legacy.legacyRequireReadOnly(a, body, 1 << 20);
        var request = try legacy.legacyRequestParse(a, body, 1 << 20);
        request.deinit(a);
        var response = try legacy.legacyParseOwned(a, copy, id, 1 << 20);
        response.parsed.deinit();
        var caller = try std.json.parseFromSlice(Value, a, bytes, .{ .duplicate_field_behavior = .@"error" });
        defer caller.deinit();
        _ = try provider.validateEnvelope(caller.value, id);
        if (header_method) {
            var again = try std.json.parseFromSlice(Value, a, body, .{});
            again.deinit();
        }
        return;
    }
    const scanned = try read_replay.scanReadOnly(a, body, 1 << 20);
    var request = try Request.scanned(a, body, &scanned.top, 1 << 20, false);
    request.deinit(a);
    var response = try ParsedResponse.parseOwned(a, copy, id, 1 << 20);
    if (header_method) {
        _ = try response.resultValue(a);
        response.header_checked = true;
    }
    const winner = response.takeWinner(a);
    defer a.free(winner.bytes);
    const tree = (try provider.adoptValidated(a, winner.bytes, id, winner.validated.?.result)).?;
    tree.deinit();
}

test "one cooperative read allocates a fraction of the legacy parse chain" {
    const fixture_hash_0 = "0x" ++ "769f" ** 16;
    const fixture_hash_1 = "0x" ++ "0000" ** 16;
    const fixture_hash_2 = "0x" ++ "0000" ** 16;
    const fixture_hash_3 = "0x" ++ "b1d5" ** 16;
    const fixture_hash_4 = "0x" ++ "2f1e" ** 16;
    const fixture_hash_5 = "0x" ++ "1f1e" ** 16;
    const log = "{\"address\":\"0x3a464f746d23ab22155710f44db16dca53e0775e\",\"topics\":[\"" ++ fixture_hash_0 ++ "\",\"" ++ fixture_hash_1 ++ "\"],\"data\":\"" ++ fixture_hash_2 ++ "00" ** 31 ++ "77\",\"blockNumber\":\"0x12a05f2\",\"transactionHash\":\"" ++ fixture_hash_3 ++ "\",\"transactionIndex\":\"0x3\",\"blockHash\":\"" ++ fixture_hash_4 ++ "\",\"logIndex\":\"0x1a\",\"removed\":false}";
    const logs = "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":[" ++ (log ++ ",") ** 19 ++ log ++ "]}";
    const cases = [_]struct { name: []const u8, body: []const u8, bytes: []const u8 }{
        .{ .name = "eth_getLogs x20", .body = "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"0x12a05f0\",\"toBlock\":\"0x12a05f2\",\"address\":\"0x3a464f746d23ab22155710f44db16dca53e0775e\",\"topics\":[\"" ++ fixture_hash_0 ++ "\"]}]}", .bytes = logs },
        .{ .name = "eth_call", .body = "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x3a464f746d23ab22155710f44db16dca53e0775e\",\"data\":\"0x" ++ "ab" ** 512 ++ "\"},\"latest\"]}", .bytes = "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":\"0x" ++ "00" ** 96 ++ "\"}" },
        .{ .name = "eth_blockNumber", .body = "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"eth_blockNumber\",\"params\":[]}", .bytes = "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":\"0x12a05f2\"}" },
        .{ .name = "eth_getBlockByNumber", .body = "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"eth_getBlockByNumber\",\"params\":[\"0x12a05f2\",false]}", .bytes = "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"number\":\"0x12a05f2\",\"hash\":\"" ++ fixture_hash_4 ++ "\",\"parentHash\":\"" ++ fixture_hash_5 ++ "\",\"timestamp\":\"0x6553f100\",\"gasLimit\":\"0x1c9c380\",\"baseFeePerGas\":\"0x7\",\"transactions\":[],\"uncles\":[]}}" },
    };
    for (cases) |case| {
        var old = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        try rpcJsonWork(old.allocator(), case.body, case.bytes, 9, true);
        var new = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        try rpcJsonWork(new.allocator(), case.body, case.bytes, 9, false);
        if (std.process.hasEnvVarConstant("HYPERLANE_RPCJSON_COUNTS")) std.debug.print("{s}: allocations {d} -> {d}, bytes {d} -> {d}\n", .{ case.name, old.allocations, new.allocations, old.allocated_bytes, new.allocated_bytes });
        try std.testing.expect(new.allocations * 3 <= old.allocations * 2);
        try std.testing.expect(new.allocated_bytes * 3 <= old.allocated_bytes * 2);
    }
}

/// Legacy requireReadOnly + Request.parse against scanReadOnly + Request.scanned
/// (cooperative path) and against Request.parse (direct submit path).
fn checkPoolRequest(a: A, body: []const u8, quorum: bool) !void {
    const legacy = @import("../net/json_envelope_differential_test.zig");
    const read_replay = @import("../net/read_replay.zig");
    const limit = 1 << 20;
    // Cooperative: policy first, then the Pool adopts the policy's scan.
    const old_policy = legacy.legacyRequireReadOnly(a, body, limit);
    const new_policy = read_replay.scanReadOnly(a, body, limit);
    if (old_policy) |id| {
        const scan = new_policy catch |err| {
            std.debug.print("policy: legacy ok, new {s} for {s}\n", .{ @errorName(err), body });
            return error.DifferentialMismatch;
        };
        try std.testing.expectEqual(id, scan.id);
        try comparePoolRequest(a, body, legacy.legacyRequestParse(a, body, limit), Request.scanned(a, body, &scan.top, limit, quorum), quorum);
    } else |old_err| {
        if (new_policy) |_| {
            std.debug.print("policy: legacy {s}, new ok for {s}\n", .{ @errorName(old_err), body });
            return error.DifferentialMismatch;
        } else |new_err| try std.testing.expectEqual(old_err, new_err);
    }
    // Direct submit.
    try comparePoolRequest(a, body, legacy.legacyRequestParse(a, body, limit), Request.parse(a, body, limit, quorum), quorum);
}
fn comparePoolRequest(a: A, body: []const u8, old: anyerror!@import("../net/json_envelope_differential_test.zig").LegacyRequest, new: anyerror!Request, quorum: bool) !void {
    const legacy = @import("../net/json_envelope_differential_test.zig");
    if (old) |value| {
        var l = value;
        defer l.deinit(a);
        var n = new catch |err| {
            std.debug.print("pool request: legacy ok, new {s} for {s}\n", .{ @errorName(err), body });
            return error.DifferentialMismatch;
        };
        defer n.deinit(a);
        try std.testing.expectEqualStrings(l.method, n.method);
        try std.testing.expectEqual(l.id, n.id);
        if (inspectsParams(n.method, quorum)) try std.testing.expect(legacy.deepEqual(l.params, n.params)) else try std.testing.expect(n.params == .null);
    } else |old_err| {
        if (new) |value| {
            var n = value;
            n.deinit(a);
            std.debug.print("pool request: legacy {s}, new ok for {s}\n", .{ @errorName(old_err), body });
            return error.DifferentialMismatch;
        } else |new_err| if (old_err != new_err) {
            std.debug.print("pool request: legacy {s}, new {s} for {s}\n", .{ @errorName(old_err), @errorName(new_err), body });
            return error.DifferentialMismatch;
        }
    }
}

test "pool requests from one scan match the legacy policy and request parse" {
    const a = std.testing.allocator;
    const legacy = @import("../net/json_envelope_differential_test.zig");
    var extra: std.ArrayList(u8) = .empty;
    defer extra.deinit(a);
    for (legacy.request_corpus) |body| for ([_]bool{ false, true }) |quorum| try checkPoolRequest(a, body, quorum);
    const shaped = [_][]const u8{
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"eth_getBlockByHash\",\"params\":[\"0x" ++ "ab" ** 32 ++ "\",false]}",
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"eth_getStorageAt\",\"params\":[\"0x1\",\"0x0\",{\"blockHash\":\"0x" ++ "cd" ** 32 ++ "\"}]}",
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x1\",\"data\":\"0x\\u0030\"},\"finalized\"]}",
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"eth_estimateGas\"}",
    };
    for (shaped) |body| for ([_]bool{ false, true }) |quorum| try checkPoolRequest(a, body, quorum);
    // Valid read requests around the Pool's depth bound (policy has none).
    for ([_]usize{ 125, 126, 127, 128, 200 }) |depth| {
        extra.clearRetainingCapacity();
        try extra.appendSlice(a, "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"eth_call\",\"params\":");
        try extra.appendNTimes(a, '[', depth);
        try extra.appendNTimes(a, ']', depth);
        try extra.append(a, '}');
        for ([_]bool{ false, true }) |quorum| try checkPoolRequest(a, extra.items, quorum);
    }
    var prng = std.Random.DefaultPrng.init(0x5eed_4a50_4e00_0002);
    const random = prng.random();
    for (0..3000) |round| {
        const source = legacy.request_corpus[random.uintLessThan(usize, legacy.request_corpus.len)];
        if (round % 2 == 0) try legacy.mutate(random, source, &extra, a) else try legacy.reshape(random, source, &extra, a);
        try checkPoolRequest(a, extra.items, random.boolean());
    }
}

test "header check from the result span decides exactly as header.validateResult" {
    const a = std.testing.allocator;
    const hash = "\"0x" ++ "11" ** 32 ++ "\"";
    const parent = "\"0x" ++ "22" ** 32 ++ "\"";
    const fields_ok = [_][]const u8{ "\"number\":\"0x10\"", "\"hash\":" ++ hash, "\"parentHash\":" ++ parent, "\"timestamp\":\"0x123\"", "\"gasLimit\":\"0x1c9c380\"", "\"baseFeePerGas\":\"0x7\"" };
    const replacements = [_][]const u8{ "null", "\"\"", "\"0x\"", "\"0xzz\"", "7", "true", "{}", "\"0x" ++ "11" ** 31 ++ "\"", "\"0x10000000000000000\"", "\"\\u0030x10\"", "\"0x" ++ "ff" ** 33 ++ "\"" };
    var cases: std.ArrayList([]u8) = .empty;
    defer {
        for (cases.items) |case| a.free(case);
        cases.deinit(a);
    }
    for (0..fields_ok.len + 1) |drop| for (0..replacements.len + 1) |replace| for (0..fields_ok.len) |target| {
        var body: std.ArrayList(u8) = .empty;
        errdefer body.deinit(a);
        try body.appendSlice(a, "{\"transactions\":[],");
        for (fields_ok, 0..) |field, index| {
            if (index == drop) continue;
            if (index == target and replace < replacements.len) {
                const colon = std.mem.indexOfScalar(u8, field, ':').?;
                try body.appendSlice(a, field[0 .. colon + 1]);
                try body.appendSlice(a, replacements[replace]);
            } else try body.appendSlice(a, field);
            try body.append(a, ',');
        }
        try body.appendSlice(a, "\"size\":\"0x1\"}");
        try cases.append(a, try body.toOwnedSlice(a));
    };
    for ([_][]const u8{ "null", "[1]", "\"x\"", "7", "{}" }) |extra| try cases.append(a, try a.dupe(u8, extra));
    var decided: usize = 0;
    for (cases.items) |result| for ([_][]const u8{ "[\"latest\",false]", "[\"pending\",false]" }) |params_text| {
        const params = try envelope.parseValue(a, params_text, false);
        defer params.deinit();
        const tree = try envelope.parseValue(a, result, false);
        defer tree.deinit();
        const expected = if (@import("header.zig").validateResult("eth_getBlockByNumber", params.value, tree.value)) |_| true else |_| false;
        var request: Request = .{ .body = @constCast(""), .method = "eth_getBlockByNumber", .id = 1, .params = params.value };
        if (try Pool.headerResult(a, result, Pool.headerPending(&request))) |check| if (check == .valid) {
            // Decoded fields are exactly what Header.parse returns; absent
            // facts only where Header.parse fails (null or pending block).
            const parsed = @import("header.zig").Header.parse(tree.value);
            if (check.valid) |facts| {
                const header = try parsed;
                try std.testing.expectEqual(header.number, facts.number);
                try std.testing.expectEqual(header.timestamp, facts.timestamp);
                try std.testing.expectEqualSlices(u8, &header.hash, &facts.hash);
                try std.testing.expectEqualSlices(u8, &header.parent_hash, &facts.parent_hash);
            } else try std.testing.expect(std.meta.isError(parsed));
        };
        if (try Pool.headerResultValid(a, result, Pool.headerPending(&request))) |valid| {
            decided += 1;
            if (valid != expected) {
                std.debug.print("header span {} vs tree {} for {s} {s}\n", .{ valid, expected, result, params_text });
                return error.DifferentialMismatch;
            }
        }
    };
    try std.testing.expect(decided * 10 >= cases.items.len * 2 * 8);
}

const SpanFixture = struct {
    fn response(a: A, body: []const u8) ![]u8 {
        const parsed = try std.json.parseFromSlice(Value, a, body, .{});
        defer parsed.deinit();
        const id = parsed.value.object.get("id").?.integer;
        const method = parsed.value.object.get("method").?.string;
        const result = if (std.mem.eql(u8, method, "eth_getBlockByNumber"))
            "{\"number\":\"0x10\",\"timestamp\":\"0x123\",\"hash\":\"0x" ++ "11" ** 32 ++ "\",\"parentHash\":\"0x" ++ "22" ** 32 ++ "\"}"
        else if (std.mem.eql(u8, method, "eth_call")) "\"0x" ++ "00" ** 31 ++ "07\"" else return error.UnexpectedRpcMethod;
        return std.fmt.allocPrint(a, "{{ \"jsonrpc\" : \"2.0\", \"id\":{d},\n \"result\": {s} }}", .{ id, result });
    }
};

test "cooperative reads hand the pool-validated result span to the caller end to end" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const read_replay = @import("../net/read_replay.zig");
    const provider = @import("provider.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = SpanFixture.response }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384 });
    defer owner.deinit();
    var replay = try read_replay.Replay.init(a, owner, .{ .max_attempt_ms = 5000 });
    defer replay.deinit();
    try replay.beginPass(null);
    defer replay.endPass(null);
    // The exchange result carries the exact span and the header check.
    const wire = try replay.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"eth_getBlockByNumber\",\"params\":[\"0x10\",false]}", .{ .timeout_ms = 4000, .max_response_bytes = 8192 });
    defer a.free(wire.bytes);
    const validated = wire.validated.?;
    try std.testing.expect(validated.header_checked);
    try std.testing.expectEqual(@as(u8, '{'), wire.bytes[validated.result.start]);
    // The header fields the check decoded travel with the span.
    const facts = validated.header orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u64, 16), facts.number);
    try std.testing.expectEqual(@as(u64, 0x123), facts.timestamp);
    try std.testing.expectEqualSlices(u8, &(.{0x22} ** 32), &facts.parent_hash);
    const adopted = (try provider.adoptValidated(a, wire.bytes[0..wire.len], 3, validated.result)).?;
    defer adopted.deinit();
    try std.testing.expectEqualStrings("0x10", adopted.value.object.get("result").?.object.get("number").?.string);
    // The typed client decodes through the same adoption.
    var client = try provider.RpcClient.init(a, url, .{ .exchange = replay.interface(), .timeout_ms = 4000, .max_response_bytes = 8192 });
    defer client.deinit();
    const header = try client.blockHeader(.{ .number = 16 });
    try std.testing.expectEqual(@as(u64, 16), header.number);
    try std.testing.expectEqualSlices(u8, &(.{0x11} ** 32), &header.hash);
    try std.testing.expect(try client.count(@splat(0), .latest) == 7);
    // Raw calls keep pool-validated results in their bytes (no tree).
    var raw = try client.callRaw("eth_getBlockByNumber", .{ "0x10", false });
    defer raw.deinit();
    try std.testing.expect(raw.raw() != null and raw.tree == null and raw.header_facts != null);
    try std.testing.expectEqualStrings("0x10", (try raw.value()).object.get("number").?.string);
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
test "native RPC owner blocks on sockets while a request stalls and wakes on cancel" {
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
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    const handle = try owner.submit(fixture.chain_id_body, 10000, 5000, 32768);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() == 0) {
        if (timer.read() > std.time.ns_per_s) return error.FixtureStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const before = owner.owner_iterations.load(.acquire);
    std.Thread.sleep(200 * std.time.ns_per_ms);
    // The former 2 ms condition slice made ~100 passes here.
    try std.testing.expect(owner.owner_iterations.load(.acquire) - before <= 4);
    const cancelled_at = timer.read();
    owner.cancel(handle);
    // Cancel interrupts the socket wait: the session slot is retired promptly.
    while (true) {
        owner.mutex.lock();
        const live = for (owner.sessions) |entry| {
            if (entry != null) break true;
        } else false;
        owner.mutex.unlock();
        if (!live) break;
        if (timer.read() - cancelled_at > 2 * std.time.ns_per_s) return error.CancelDidNotWakeOwner;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try server.check();
}
test "native RPC owner runs the next fallback peer after a cooldown skip resolved during progress" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .status = 429, .body = "" }} }, .{ .replies = &.{.{ .body = fixture.chain_id_ok }} } };
    var server = try fixture.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{ first, second }, .strategy = .{ .fallback = .{} } });
    defer owner.deinit();
    // Endpoint 0 rate-limits and enters cooldown; endpoint 1 answers.
    const warm = try owner.fetch(a, fixture.chain_id_body, 5000, 1000, null, 4096);
    a.free(warm.bytes);
    // Endpoint 0 is now skipped inside progress (no native completion). The
    // owner must take another pass instead of sleeping to the 5 s deadline.
    var timer = try std.time.Timer.start();
    const response = try owner.fetch(a, fixture.chain_id_body, 5000, 1000, null, 4096);
    a.free(response.bytes);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), server.pathHits(1));
}
test "blocking fetch callers drive their own requests without owner thread handoffs" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = fixture.chain_id_ok }} }};
    var server = try fixture.Fixture.init(20, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    for (0..20) |_| {
        const response = try owner.fetch(a, fixture.chain_id_body, 5000, 1000, null, 4096);
        defer a.free(response.bytes);
        try std.testing.expectEqualStrings(fixture.chain_id_ok, response.bytes);
    }
    // Every pass ran on the calling thread; the owner thread never woke.
    const total = owner.owner_iterations.load(.acquire);
    try std.testing.expect(total >= 20);
    try std.testing.expectEqual(total, owner.caller_passes.load(.acquire));
    // So only this thread touched the native multi. Passes make no kernel
    // call of their own; each fetch costs a few readiness waits (connect,
    // response), not one per pass or per live transfer.
    try std.testing.expectEqual(@as(u64, 0), owner.native.harvests);
    try std.testing.expect(owner.native.waits <= 4 * 20);
}

test "async submits and cancels during a caller's drive do not wake the idle owner thread" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "", .stall = true }} }};
    var server = try fixture.Fixture.init(64, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    const Driver = struct {
        fn run(pool: *Pool, result: *?anyerror) void {
            const response = pool.fetch(std.testing.allocator, fixture.chain_id_body, 600, 500, null, 4096) catch |err| {
                result.* = err;
                return;
            };
            std.testing.allocator.free(response.bytes);
        }
    };
    var result: ?anyerror = null;
    const thread = try std.Thread.spawn(.{}, Driver.run, .{ owner, &result });
    var timer = try std.time.Timer.start();
    while (true) {
        owner.mutex.lock();
        const driving = owner.caller_driving;
        owner.mutex.unlock();
        if (driving and server.acceptedCount() > 0) break;
        if (timer.read() > 2 * std.time.ns_per_s) {
            thread.join();
            return error.CallerNeverDrove;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const wakes = owner.owner_wakes.load(.acquire);
    for (0..20) |_| owner.cancel(try owner.submit(fixture.chain_id_body, 5000, 1000, 4096));
    const during = owner.owner_wakes.load(.acquire) - wakes;
    thread.join();
    try std.testing.expectEqual(@as(?anyerror, error.RequestDeadlineExceeded), result);
    // The driving caller retires the cancelled sessions itself; previously
    // each submit and cancel signalled the owner only for it to sleep again.
    try std.testing.expectEqual(@as(u64, 0), during);
    try server.check();
}

const ConcurrentFetch = struct {
    owner: *Pool,
    body: []const u8,
    expected: []const u8,
    failures: std.atomic.Value(usize) = .init(0),
    // Non-null: followers wake on timed slices, exercising grant races.
    cancel: std.atomic.Value(bool) = .init(false),
    fn run(self: *ConcurrentFetch) void {
        for (0..10) |_| {
            const response = self.owner.fetch(std.testing.allocator, self.body, 5000, 1000, &self.cancel, 4096) catch {
                _ = self.failures.fetchAdd(1, .acq_rel);
                continue;
            };
            defer std.testing.allocator.free(response.bytes);
            if (!std.mem.eql(u8, response.bytes, self.expected)) _ = self.failures.fetchAdd(1, .acq_rel);
        }
    }
};
test "concurrent blocking callers share one drive token and all complete" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    // Mixed delays force followers, grants and owner fallback to interleave.
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{ .{ .body = fixture.chain_id_ok, .delay_ms = 20 }, .{ .body = fixture.chain_id_ok }, .{ .body = fixture.chain_id_ok, .delay_ms = 5 } } }};
    var server = try fixture.Fixture.init(81, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    var work: ConcurrentFetch = .{ .owner = owner, .body = fixture.chain_id_body, .expected = fixture.chain_id_ok };
    var threads: [8]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, ConcurrentFetch.run, .{&work});
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(usize, 0), work.failures.load(.acquire));
    owner.mutex.lock();
    const stale_grant = owner.granted or owner.caller_driving;
    owner.mutex.unlock();
    try std.testing.expect(!stale_grant);
    // An async handle progresses only through the owner thread fallback:
    // poll never drives, so a stale grant would park it until its deadline.
    const handle = try owner.submit(fixture.chain_id_body, 5000, 1000, 4096);
    var timer = try std.time.Timer.start();
    while (true) {
        if (try owner.poll(handle, a)) |response| {
            a.free(response.bytes);
            break;
        }
        if (timer.read() > 3 * std.time.ns_per_s) return error.OwnerFallbackStalled;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

const FiberFetch = struct {
    owner: *Pool,
    body: []const u8,
    fn run(self: *FiberFetch, input: u32, _: *const std.atomic.Value(bool)) !u32 {
        for (0..input) |_| {
            const response = try self.owner.fetch(std.testing.allocator, self.body, 5000, 1000, null, 4096);
            std.testing.allocator.free(response.bytes);
        }
        return input;
    }
    fn freeInput(_: *FiberFetch, _: u32) void {}
    fn freeOutput(_: *FiberFetch, _: u32) void {}
};
test "a lone fiber drives its own pool requests without owner thread handoffs" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = fixture.chain_id_ok }} }};
    var server = try fixture.Fixture.init(10, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    var context: FiberFetch = .{ .owner = owner, .body = fixture.chain_id_body };
    const io = @import("../runtime/io_pool.zig");
    const workers = try io.Pool(u32, u32, FiberFetch, 1, 2).startWith(a, &context, FiberFetch.run, FiberFetch.freeInput, FiberFetch.freeOutput, .{ .fibers = true });
    defer workers.deinit();
    _ = try workers.submit(10, 0, 60_000);
    var timer = try std.time.Timer.start();
    const completion = while (true) {
        if (workers.poll(1)) |value| break value;
        if (timer.read() > 10 * std.time.ns_per_s) return error.FiberFetchStalled;
        std.Thread.sleep(std.time.ns_per_ms);
    };
    try std.testing.expectEqual(@as(u32, 10), completion.result.value);
    // Every pass ran on the fiber's worker: the owner thread never drove.
    try std.testing.expectEqual(owner.owner_iterations.load(.acquire), owner.caller_passes.load(.acquire));
}

const StalledFetch = struct {
    owner: *Pool,
    body: []const u8,
    fn run(self: *StalledFetch, _: u32, cancel: *const std.atomic.Value(bool)) !u32 {
        const response = try self.owner.fetch(std.testing.allocator, self.body, 60_000, 1000, cancel, 4096);
        std.testing.allocator.free(response.bytes);
        return 1;
    }
    fn freeInput(_: *StalledFetch, _: u32) void {}
    fn freeOutput(_: *StalledFetch, _: u32) void {}
};
test "a runtime cancel raise ends blocking and fiber pool waits without a recheck slice" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{ .{ .body = "", .stall = true }, .{ .body = "", .stall = true } } }};
    var server = try fixture.Fixture.init(4, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    // Fiber job: io_pool cancellation raises the job's borrowed flag.
    var context: StalledFetch = .{ .owner = owner, .body = fixture.chain_id_body };
    const io = @import("../runtime/io_pool.zig");
    const workers = try io.Pool(u32, u32, StalledFetch, 1, 2).startWith(a, &context, StalledFetch.run, StalledFetch.freeInput, StalledFetch.freeOutput, .{ .fibers = true });
    defer workers.deinit();
    const id = try workers.submit(0, 0, 120_000);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() == 0) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.FixtureStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    std.Thread.sleep(20 * std.time.ns_per_ms);
    const cancelled_at = timer.read();
    var delivered = cancel_wake.delivered.load(.acquire);
    _ = try workers.cancel(id);
    // The raise found the wait's registration and woke it (no recheck slice).
    try std.testing.expect(cancel_wake.delivered.load(.acquire) > delivered);
    while (workers.retained(id)) {
        if (timer.read() - cancelled_at > 5 * std.time.ns_per_s) return error.CancelDidNotEndFiberWait;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // Blocking caller on its own thread, flag raised by a lane-style owner.
    const Caller = struct {
        owner: *Pool,
        cancel: std.atomic.Value(bool) = .init(false),
        result: ?anyerror = null,
        fn run(self: *@This()) void {
            const response = self.owner.fetch(std.testing.allocator, fixture.chain_id_body, 60_000, 1000, &self.cancel, 4096) catch |err| {
                self.result = err;
                return;
            };
            std.testing.allocator.free(response.bytes);
        }
    };
    var caller: Caller = .{ .owner = owner };
    const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    while (server.acceptedCount() < 2) {
        if (timer.read() > 10 * std.time.ns_per_s) {
            cancel_wake.raise(&caller.cancel);
            thread.join();
            return error.FixtureStartTimeout;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    std.Thread.sleep(20 * std.time.ns_per_ms);
    delivered = cancel_wake.delivered.load(.acquire);
    cancel_wake.raise(&caller.cancel);
    try std.testing.expect(cancel_wake.delivered.load(.acquire) > delivered);
    thread.join();
    try std.testing.expectEqual(@as(?anyerror, error.RequestCancelled), caller.result);
}

test "native RPC owner notices delayed responses without any further submit" {
    const a = std.testing.allocator;
    const fixture = @import("pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    // Concurrent delayed replies on one pool; nothing else wakes the owner.
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = fixture.chain_id_ok, .delay_ms = 150 }} }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} } });
    defer owner.deinit();
    for (0..4) |_| {
        var handles: [8]Handle = undefined;
        for (&handles) |*handle| handle.* = try owner.submit(fixture.chain_id_body, 10000, 5000, 32768);
        var timer = try std.time.Timer.start();
        var done: usize = 0;
        var finished: [8]bool = @splat(false);
        while (done < handles.len) {
            for (handles, &finished) |handle, *flag| if (!flag.*) if (try owner.poll(handle, a)) |response| {
                a.free(response.bytes);
                flag.* = true;
                done += 1;
            };
            // 150 ms server delay; a lost socket wake stalls until the deadline.
            if (timer.read() > 3 * std.time.ns_per_s) return error.DelayedResponseNotNoticed;
            std.Thread.sleep(std.time.ns_per_ms);
        }
    }
}
