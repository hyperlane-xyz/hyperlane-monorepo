const std = @import("std");
const abi = @import("codecs.zig");
const Curl = @import("../net/curl.zig");
const Endpoint = @import("../net/endpoint.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
const TipCache = @import("../net/dynamic_tip_cache.zig");
const envelope = @import("../net/json_envelope.zig");
const json_fast = @import("../net/json_fast.zig");
pub const Address = abi.Address;
pub const Hash = abi.Hash;

pub const RpcResponse = struct {
    allocator: Allocator,
    bytes: []u8,
    parsed: std.json.Parsed(Value),

    /// Value borrows this response; consume before deinit.
    pub fn value(self: RpcResponse) Value {
        return self.parsed.value.object.get("result").?;
    }

    pub fn isError(self: RpcResponse) bool {
        const value_ = self.parsed.value.object.get("error") orelse return false;
        return value_ != .null;
    }

    /// Structured revert data, borrowed until deinit. Never format the remote
    /// error message: providers may include endpoint credentials in that text.
    pub fn errorData(self: RpcResponse) ?Value {
        const value_ = self.parsed.value.object.get("error") orelse return null;
        if (value_ != .object) return null;
        return value_.object.get("data");
    }

    pub fn deinit(self: *RpcResponse) void {
        self.parsed.deinit();
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

/// A validated response whose result is read straight from its bytes when
/// the pool already validated them: `span` is then the exact result JSON
/// (syntax, depth and duplicate keys checked over the whole body by the
/// pool; the envelope around it rechecked by this client). Otherwise the
/// envelope was decoded as call() does and `tree` holds it.
pub const RawResponse = struct {
    allocator: Allocator,
    protocol: @import("pool.zig").HeightProtocol,
    bytes: []u8,
    span: ?envelope.Span,
    /// Whole-envelope tree (decoded path) or result tree (built by value()).
    tree: ?std.json.Parsed(Value) = null,
    rpc_error: bool = false,
    /// Header fields the pool already decoded from this exact result.
    header_facts: ?envelope.HeaderFacts = null,

    /// The exact result JSON, when it was never decoded into a tree.
    pub fn raw(self: *const RawResponse) ?[]const u8 {
        return if (self.span) |span| span.of(self.bytes) else null;
    }
    pub fn isError(self: RawResponse) bool {
        return self.rpc_error;
    }
    /// The result as RpcResponse.value() gives it (parsed on first use);
    /// borrows this response.
    pub fn value(self: *RawResponse) !Value {
        if (self.tree) |tree| return if (self.span == null) tree.value.object.get("result").? else tree.value;
        // Not reachable for a span the pool validated; same error mapping
        // as a full decode otherwise.
        self.tree = envelope.parseValue(self.allocator, self.raw().?, true) catch |err| return @import("pool.zig").responseDecodeError(self.protocol, err);
        return self.tree.?.value;
    }
    /// `string(value())` without a tree when the result is an unescaped string.
    pub fn text(self: *RawResponse) ![]const u8 {
        if (self.raw()) |bytes| if (bytes.len >= 2 and bytes[0] == '"' and std.mem.indexOfScalar(u8, bytes, '\\') == null) return bytes[1 .. bytes.len - 1];
        return string(try self.value());
    }
    /// BlockHeader.parse of the result, from the pool's decoded fields when
    /// it has them.
    pub fn header(self: *RawResponse) !BlockHeader {
        if (self.header_facts) |facts| return .{ .number = facts.number, .hash = facts.hash, .parent_hash = facts.parent_hash, .timestamp = facts.timestamp };
        return BlockHeader.parse(try self.value());
    }
    pub fn deinit(self: *RawResponse) void {
        if (self.tree) |tree| tree.deinit();
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

pub const BlockRef = union(enum) {
    number: u64,
    latest,
    safe,
    finalized,
    earliest,
    pending,

    /// Same exact five configured tags as the production Rust provider.
    pub fn fromTag(value: []const u8) !BlockRef {
        if (std.mem.eql(u8, value, "latest")) return .latest;
        if (std.mem.eql(u8, value, "finalized")) return .finalized;
        if (std.mem.eql(u8, value, "safe")) return .safe;
        if (std.mem.eql(u8, value, "earliest")) return .earliest;
        if (std.mem.eql(u8, value, "pending")) return .pending;
        return error.InvalidEvmReorgTag;
    }

    fn text(self: BlockRef, allocator: Allocator) ![]u8 {
        return switch (self) {
            .number => |n| abi.quantityAlloc(allocator, n),
            .latest => allocator.dupe(u8, "latest"),
            .safe => allocator.dupe(u8, "safe"),
            .finalized => allocator.dupe(u8, "finalized"),
            .earliest => allocator.dupe(u8, "earliest"),
            .pending => allocator.dupe(u8, "pending"),
        };
    }
};

/// `0x`-prefixed lowercase hex JSON string of `bytes`, written straight into
/// the request: the same bytes as Stringify of abi.hexAlloc's text, without
/// that allocation or Stringify's per-byte string escaping pass.
pub const HexParam = struct {
    bytes: []const u8,
    pub fn jsonStringify(self: HexParam, jw: anytype) !void {
        try jw.beginWriteRaw();
        try jw.writer.writeAll("\"0x");
        const digits = "0123456789abcdef";
        var chunk: [128]u8 = undefined;
        var at: usize = 0;
        while (at < self.bytes.len) {
            const n: usize = @min(chunk.len / 2, self.bytes.len - at);
            for (self.bytes[at..][0..n], 0..) |byte, i| {
                chunk[2 * i] = digits[byte >> 4];
                chunk[2 * i + 1] = digits[byte & 15];
            }
            try jw.writer.writeAll(chunk[0 .. 2 * n]);
            at += n;
        }
        try jw.writer.writeByte('"');
        jw.endWriteRaw();
    }
};
/// abi.quantityAlloc's text as a JSON string, written in place.
pub const QuantityParam = struct {
    value: u64,
    pub fn jsonStringify(self: QuantityParam, jw: anytype) !void {
        try jw.beginWriteRaw();
        try jw.writer.print("\"0x{x}\"", .{self.value});
        jw.endWriteRaw();
    }
};
/// BlockRef.text as a JSON string, written in place.
pub const BlockParam = struct {
    block: BlockRef,
    pub fn jsonStringify(self: BlockParam, jw: anytype) !void {
        switch (self.block) {
            .number => |n| try (QuantityParam{ .value = n }).jsonStringify(jw),
            .latest => try jw.write("latest"),
            .safe => try jw.write("safe"),
            .finalized => try jw.write("finalized"),
            .earliest => try jw.write("earliest"),
            .pending => try jw.write("pending"),
        }
    }
};
/// Params already serialized as JSON.
const RawParams = struct { json: []const u8 };

/// `validated`: a Pool winner already authenticated against this request id.
pub const WireResponse = struct { bytes: []u8, len: usize, validated: ?envelope.Validated = null };
pub const Exchange = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, Allocator, []const u8, Options) anyerror!WireResponse,
    commit_read_section_fn: ?*const fn (*anyopaque) anyerror!void = null,
    /// Independent requests overlapped by the owner. All-or-error: on error
    /// no `out` entry remains allocated. Absent: callMany runs serially.
    fetch_many_fn: ?*const fn (*anyopaque, Allocator, []const []const u8, Options, []WireResponse) anyerror!void = null,
};
/// One JSON-RPC call whose params are already serialized JSON.
pub const RawCall = struct { method: []const u8, params_json: []const u8 };
pub const Options = struct {
    /// Shared transport protocol identity. Ethereum decodes JSON-RPC on every
    /// HTTP status except 429, preserving revert data required by EIP-3668.
    protocol: @import("pool.zig").HeightProtocol = .ethereum,
    /// Source indexer-only dynamic tip coalescing. Fresh safety/vote clients stay off.
    indexer_tip_cache: bool = false,
    dynamic_tip_cache: ?*TipCache.Cache = null,
    native_cache_observer: ?TipCache.Observer = null,
    max_response_bytes: usize = 8 * 1024 * 1024,
    max_log_range: u64 = 2000,
    /// Explicit native transport supplies DNS/connect/read deadlines and
    /// cancellation. The std-only path remains available for isolated fixtures.
    native_transport: ?*Curl.Client = null,
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 5000,
    /// Actual absolute monotonic caller deadline for direct endpoint-pool
    /// exchanges. Cooperative replay owns its retained deadline independently;
    /// a transient callback/request timeout must not replace that owner.
    owner_deadline_ns: ?u64 = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    /// Serialized native endpoint-pool owner. The returned wire bytes transfer
    /// to this client and still pass the same JSON-RPC envelope validation.
    exchange: ?Exchange = null,
    /// Non-owning async owner; Sources may create independent read journals.
    async_pool: ?*@import("pool.zig").Pool = null,
    pool_observer: ?@import("pool.zig").Observer = null,
    read_budget: ?*@import("../net/byte_budget.zig").Budget = null,
};

const BoundedResponse = struct {
    writer: std.Io.Writer,
    exceeded: bool = false,

    fn init(bytes: []u8) BoundedResponse {
        return .{ .writer = .{ .buffer = bytes, .vtable = &.{ .drain = drain } } };
    }

    fn drain(writer: *std.Io.Writer, _: []const []const u8, _: usize) std.Io.Writer.Error!usize {
        const self: *BoundedResponse = @fieldParentPtr("writer", writer);
        self.exceeded = true;
        return error.WriteFailed;
    }
};

/// Serial typed JSON-RPC client. Retrying/hedging belongs to an injected pool;
/// callers explicitly choose reads or exact signed-transaction broadcasts.
/// HTTP(S) uses std's TLS certificate/hostname verification and forbids redirects.
/// The std-only path bounds bytes/ranges. Production callers provide
/// native_transport to additionally bound DNS/connect/read wall time.
pub const RpcClient = struct {
    allocator: Allocator,
    url: []const u8,
    endpoint: Endpoint.OwnedEndpoint,
    /// Digest of the complete endpoint identity for tip-cache keys.
    tip_identity: TipCache.Identity,
    headers: []std.http.Header,
    native_headers: []Curl.Header,
    http: std.http.Client,
    options: Options,
    next_id: i64 = 1,
    last_rpc_error_code: ?i64 = null,
    /// Size of the last encoded request; new bodies start at this capacity.
    /// Each call owns its body: lane fibers share one client and park
    /// mid-call, so a shared body buffer would be overwritten under them.
    body_hint: usize = 0,

    /// Forget a completed read section only after its controller has advanced
    /// past that section; subsequent identical fences must be physical reads.
    pub fn commitReadSection(self: *RpcClient) !void {
        if (self.options.exchange) |exchange_| if (exchange_.commit_read_section_fn) |commit| try commit(exchange_.context);
    }
    pub fn init(allocator: Allocator, url: []const u8, options: Options) !RpcClient {
        if (options.max_response_bytes == 0 or options.max_log_range == 0 or options.timeout_ms == 0 or options.connect_timeout_ms == 0) return error.InvalidRpcLimit;
        var endpoint = Endpoint.OwnedEndpoint.parse(allocator, url) catch |err| {
            if (err == error.OutOfMemory) return err;
            return error.InvalidRpcUrl;
        };
        errdefer endpoint.deinit();
        var headers: std.ArrayList(std.http.Header) = .empty;
        defer headers.deinit(allocator);
        try headers.appendSlice(allocator, &.{ .{ .name = "content-type", .value = "application/json" }, .{ .name = "accept-encoding", .value = "identity" }, .{ .name = "user-agent", .value = "hyperlane-zig/0.1.0" } });
        for (endpoint.endpoint.headers) |header| {
            var found = false;
            for (headers.items) |*existing| if (std.ascii.eqlIgnoreCase(existing.name, header.name)) {
                existing.* = header;
                found = true;
                break;
            };
            if (!found) try headers.append(allocator, header);
        }
        const native_headers = try allocator.alloc(Curl.Header, headers.items.len);
        errdefer allocator.free(native_headers);
        for (headers.items, native_headers) |header, *native| native.* = .{ .name = header.name, .value = header.value };
        try Curl.validateRequest(.{ .url = endpoint.endpoint.url, .method = .post, .headers = native_headers });
        return .{ .allocator = allocator, .url = endpoint.endpoint.url, .endpoint = endpoint, .tip_identity = TipCache.identity(endpoint.identity), .headers = try headers.toOwnedSlice(allocator), .native_headers = native_headers, .http = .{ .allocator = allocator }, .options = options };
    }

    pub fn deinit(self: *RpcClient) void {
        self.http.deinit();
        self.allocator.free(self.headers);
        self.allocator.free(self.native_headers);
        self.endpoint.deinit();
        self.* = undefined;
    }

    /// Params may be any JSON serializable tuple/array or std.json.Value.
    pub fn call(self: *RpcClient, method: []const u8, params: anytype) !RpcResponse {
        var response = try self.callEnvelope(method, params);
        errdefer response.deinit();
        if (response.isError()) return error.RpcError;
        return response;
    }

    /// Validate the full envelope but retain structured errors for contracts
    /// whose read protocol intentionally reverts (EIP-3668).
    pub fn callEnvelope(self: *RpcClient, method: []const u8, params: anytype) !RpcResponse {
        const id = try self.nextId(method);
        var buffer: std.ArrayList(u8) = .empty;
        defer buffer.deinit(self.allocator);
        const body = try self.encode(&buffer, id, method, params);
        const fetched = try self.fetchOne(body);
        return self.decodeEnvelope(method, body, id, fetched);
    }
    fn nextId(self: *RpcClient, method: []const u8) !i64 {
        if (method.len == 0 or method.len > 128) return error.InvalidRpcMethod;
        if (self.next_id == std.math.maxInt(i64)) return error.RpcIdExhausted;
        const id = self.next_id;
        self.next_id += 1;
        self.last_rpc_error_code = null;
        return id;
    }
    fn fetchOne(self: *RpcClient, body: []const u8) !WireResponse {
        return if (self.options.exchange) |exchange| try exchange.fetch_fn(exchange.context, self.allocator, body, self.options) else if (self.options.native_transport) |native| try self.fetchNative(native, body) else try self.fetchStd(body);
    }
    /// The request body, exactly Stringify of `{jsonrpc, id, method, params}`
    /// (RawParams are copied verbatim), in the caller-owned `buffer`.
    fn encode(self: *RpcClient, buffer: *std.ArrayList(u8), id: i64, method: []const u8, params: anytype) ![]const u8 {
        try buffer.ensureTotalCapacity(self.allocator, self.body_hint);
        try self.append(buffer, id, method, params);
        self.body_hint = buffer.items.len;
        return buffer.items;
    }
    fn append(self: *RpcClient, buffer: *std.ArrayList(u8), id: i64, method: []const u8, params: anytype) !void {
        var out: std.Io.Writer.Allocating = .fromArrayList(self.allocator, buffer);
        defer buffer.* = out.toArrayList();
        const writer = &out.writer;
        writeBody(writer, id, method, params) catch return error.OutOfMemory;
    }
    fn writeBody(writer: *std.Io.Writer, id: i64, method: []const u8, params: anytype) std.Io.Writer.Error!void {
        try writer.print("{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":", .{id});
        try std.json.Stringify.value(method, .{}, writer);
        try writer.writeAll(",\"params\":");
        if (@TypeOf(params) == RawParams) try writer.writeAll(params.json) else try std.json.Stringify.value(params, .{}, writer);
        try writer.writeByte('}');
    }
    /// Independent calls, overlapped when the exchange supports it; every
    /// envelope is validated exactly as call() (RpcError on any error object).
    /// All-or-error: on error no `out` entry remains allocated.
    pub fn callMany(self: *RpcClient, calls: []const RawCall, out: []RpcResponse) !void {
        return self.exchangeMany(RpcResponse, decodeEnvelope, calls, out);
    }
    /// callMany whose results stay in their response bytes when the pool
    /// already validated them (see RawResponse); same errors and ownership.
    pub fn callManyRaw(self: *RpcClient, calls: []const RawCall, out: []RawResponse) !void {
        return self.exchangeMany(RawResponse, decodeRaw, calls, out);
    }
    /// call() with the result left in its response bytes when possible.
    pub fn callRaw(self: *RpcClient, method: []const u8, params: anytype) !RawResponse {
        const id = try self.nextId(method);
        var buffer: std.ArrayList(u8) = .empty;
        defer buffer.deinit(self.allocator);
        const body = try self.encode(&buffer, id, method, params);
        var response = try self.decodeRaw(method, body, id, try self.fetchOne(body));
        errdefer response.deinit();
        if (response.isError()) return error.RpcError;
        return response;
    }
    fn exchangeMany(self: *RpcClient, comptime R: type, comptime decode: anytype, calls: []const RawCall, out: []R) !void {
        if (calls.len != out.len) return error.InvalidRpcBatch;
        var buffer: std.ArrayList(u8) = .empty;
        defer buffer.deinit(self.allocator);
        var filled: usize = 0;
        errdefer for (out[0..filled]) |*response| response.deinit();
        const many = if (self.options.exchange) |exchange| exchange.fetch_many_fn else null;
        if (many == null or calls.len < 2) {
            for (calls, out) |raw, *slot| {
                const id = try self.nextId(raw.method);
                buffer.clearRetainingCapacity();
                const body = try self.encode(&buffer, id, raw.method, RawParams{ .json = raw.params_json });
                slot.* = try decode(self, raw.method, body, id, try self.fetchOne(body));
                filled += 1;
                if (slot.isError()) return error.RpcError;
            }
            return;
        }
        const ids = try self.allocator.alloc(i64, calls.len);
        defer self.allocator.free(ids);
        const bodies = try self.allocator.alloc([]const u8, calls.len);
        defer self.allocator.free(bodies);
        const ends = try self.allocator.alloc(usize, calls.len);
        defer self.allocator.free(ends);
        // All bodies go into the one buffer; slice it only once it stops growing.
        for (calls, ids, ends) |raw, *id, *end| {
            id.* = try self.nextId(raw.method);
            try self.append(&buffer, id.*, raw.method, RawParams{ .json = raw.params_json });
            end.* = buffer.items.len;
        }
        var start: usize = 0;
        for (bodies, ends) |*body, end| {
            body.* = buffer.items[start..end];
            start = end;
        }
        const wires = try self.allocator.alloc(WireResponse, calls.len);
        defer self.allocator.free(wires);
        try many.?(self.options.exchange.?.context, self.allocator, bodies, self.options, wires);
        var consumed: usize = 0;
        errdefer for (wires[consumed..]) |wire| self.allocator.free(wire.bytes);
        for (calls, ids, bodies, wires, out) |raw, id, body, wire, *slot| {
            consumed += 1;
            slot.* = try decode(self, raw.method, body, id, wire);
            filled += 1;
        }
        for (out) |response| if (response.isError()) return error.RpcError;
    }
    /// Takes ownership of `fetched` on every return. A pool winner whose
    /// envelope checks out keeps its result span (no tree); everything else,
    /// and header methods the pool did not header-check, decode as call().
    fn decodeRaw(self: *RpcClient, method: []const u8, body: []const u8, id: i64, fetched: WireResponse) !RawResponse {
        if (fetched.validated) |validated| if (fetched.len <= fetched.bytes.len and fetched.len <= self.options.max_response_bytes and
            (validated.header_checked or self.options.protocol != .ethereum or !@import("header.zig").isMethod(method)))
        {
            errdefer self.allocator.free(fetched.bytes);
            if (try adoptable(self.allocator, fetched.bytes[0..fetched.len], id, validated.result)) {
                self.last_rpc_error_code = null;
                return .{ .allocator = self.allocator, .protocol = self.options.protocol, .bytes = fetched.bytes, .span = validated.result, .header_facts = validated.header };
            }
        };
        const response = try self.decodeEnvelope(method, body, id, fetched);
        return .{ .allocator = self.allocator, .protocol = self.options.protocol, .bytes = response.bytes, .span = null, .tree = response.parsed, .rpc_error = response.isError() };
    }
    /// Takes ownership of `fetched` on every return.
    fn decodeEnvelope(self: *RpcClient, method: []const u8, body: []const u8, id: i64, fetched: WireResponse) !RpcResponse {
        errdefer self.allocator.free(fetched.bytes);
        if (fetched.len > fetched.bytes.len or fetched.len > self.options.max_response_bytes) return error.RpcResponseTooLarge;
        const bytes = fetched.bytes[0..fetched.len];
        if (fetched.validated) |validated| if (try adoptValidated(self.allocator, bytes, id, validated.result)) |adopted| {
            var parsed = adopted;
            errdefer parsed.deinit();
            self.last_rpc_error_code = null;
            if (self.options.protocol == .ethereum and !validated.header_checked and @import("header.zig").isMethod(method)) try validateHeader(self.allocator, method, body, parsed.value.object.get("result").?);
            return .{ .allocator = self.allocator, .bytes = fetched.bytes, .parsed = parsed };
        };
        var parsed = envelope.parseValue(self.allocator, bytes, true) catch |err| return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        errdefer parsed.deinit();
        self.last_rpc_error_code = validateEnvelope(parsed.value, id) catch |err| return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        if (self.options.protocol == .ethereum and self.last_rpc_error_code == null and @import("header.zig").isMethod(method)) try validateHeader(self.allocator, method, body, parsed.value.object.get("result").?);
        return .{ .allocator = self.allocator, .bytes = fetched.bytes, .parsed = parsed };
    }
    /// Header-result check against this request's own params; only the params
    /// span of the (self-built) body is parsed.
    fn validateHeader(allocator: Allocator, method: []const u8, body: []const u8, result: Value) !void {
        const top = try envelope.scan(allocator, body, .{});
        var params = try envelope.parseValue(allocator, top.get(.params).?.span.of(body), true);
        defer params.deinit();
        try @import("header.zig").validateResult(method, params.value, result);
    }

    const Fetched = WireResponse;
    fn fetchNative(self: *RpcClient, native: *Curl.Client, body: []const u8) !Fetched {
        if (self.options.indexer_tip_cache and self.options.dynamic_tip_cache != null and native.send_override == null) return self.fetchNativeCached(native, body);
        return self.fetchNativeTimed(native, body, self.options.timeout_ms);
    }
    fn nativeCacheEvent(self: *RpcClient, method: []const u8, event: TipCache.Event) void {
        if (self.options.native_cache_observer) |observer| observer.notify(self.url, method, event);
    }
    /// Legacy direct-native indexers retain their existing synchronous owner.
    /// Followers wait only within this call's absolute timeout/cancel budget;
    /// no cache mutex is held while awaiting another owner or doing network I/O.
    /// Cooperative indexers use Pool/ReadReplay instead of this path.
    fn fetchNativeCached(self: *RpcClient, native: *Curl.Client, body: []const u8) !Fetched {
        if (self.options.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        var request = try std.json.parseFromSlice(Value, self.allocator, body, .{});
        defer request.deinit();
        const object = request.value.object;
        const method = object.get("method").?.string;
        const id = object.get("id").?.integer;
        const params = object.get("params").?;
        const hash = (try TipCache.key(self.allocator, self.tip_identity, method, params)) orelse return self.fetchNativeTimed(native, body, self.options.timeout_ms);
        const cache = self.options.dynamic_tip_cache.?;
        const started = try std.time.Instant.now();
        self.nativeCacheEvent(method, .logical_read);
        var leader: ?TipCache.Ticket = null;
        defer if (leader) |ticket| cache.finish(ticket, null);
        var cached: ?[]u8 = null;
        switch (try cache.claim(self.allocator, hash)) {
            .hit => |result| cached = result,
            .leader => |ticket| leader = ticket,
            .bypass => {},
            .follower => |ticket| while (true) {
                if (self.options.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
                if ((try std.time.Instant.now()).since(started) >= @as(u64, self.options.timeout_ms) * std.time.ns_per_ms) return error.RequestDeadlineExceeded;
                switch (try cache.follow(self.allocator, ticket)) {
                    .hit => |result| {
                        cached = result;
                        break;
                    },
                    .released => break,
                    .pending => std.Thread.sleep(std.time.ns_per_ms),
                }
            },
        }
        if (cached) |result| {
            defer self.allocator.free(result);
            self.nativeCacheEvent(method, .cache_hit);
            const bytes = try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, result });
            errdefer self.allocator.free(bytes);
            if (bytes.len > self.options.max_response_bytes) return error.RpcResponseTooLarge;
            return .{ .bytes = bytes, .len = bytes.len };
        }
        const elapsed = (try std.time.Instant.now()).since(started) / std.time.ns_per_ms;
        if (elapsed >= self.options.timeout_ms) return error.RequestDeadlineExceeded;
        self.nativeCacheEvent(method, .upstream_read);
        const response = self.fetchNativeTimed(native, body, self.options.timeout_ms - @as(u32, @intCast(elapsed))) catch |err| {
            if (err != error.RequestCancelled) self.nativeCacheEvent(method, .upstream_error);
            return err;
        };
        errdefer self.allocator.free(response.bytes);
        var parsed = std.json.parseFromSlice(Value, self.allocator, response.bytes[0..response.len], .{ .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = self.options.max_response_bytes }) catch |err| {
            self.nativeCacheEvent(method, .upstream_error);
            return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        };
        defer parsed.deinit();
        const rpc_error = validateCachedEnvelope(parsed.value, id) catch |err| {
            self.nativeCacheEvent(method, .upstream_error);
            return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        };
        if (rpc_error) {
            self.nativeCacheEvent(method, .upstream_error);
            return response;
        }
        const result = parsed.value.object.get("result").?;
        if (self.options.protocol == .ethereum) @import("header.zig").validateResult(method, params, result) catch |err| {
            self.nativeCacheEvent(method, .upstream_error);
            return err;
        };
        const valid = if (std.mem.eql(u8, method, "eth_blockNumber")) blk: {
            if (result != .string) break :blk false;
            _ = abi.quantity(result.string) catch break :blk false;
            break :blk true;
        } else blk: {
            if (result == .null) break :blk true;
            if (result != .object) break :blk false;
            const number = result.object.get("number") orelse break :blk false;
            if (number != .string) break :blk false;
            _ = abi.quantity(number.string) catch break :blk false;
            break :blk true;
        };
        if (valid) if (leader) |ticket| {
            const encoded = try std.json.Stringify.valueAlloc(self.allocator, result, .{});
            defer self.allocator.free(encoded);
            cache.finish(ticket, encoded);
            leader = null;
        };
        return response;
    }
    fn validateCachedEnvelope(value: Value, id: i64) !bool {
        if (value != .object) return error.InvalidRpcEnvelope;
        const version = value.object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
        const actual_id = value.object.get("id") orelse return error.InvalidRpcEnvelope;
        if (version != .string or !std.mem.eql(u8, version.string, "2.0") or actual_id != .number_string) return error.InvalidRpcEnvelope;
        if ((std.fmt.parseInt(i64, actual_id.number_string, 10) catch return error.RpcIdMismatch) != id) return error.RpcIdMismatch;
        if (value.object.contains("result") == value.object.contains("error")) return error.InvalidRpcEnvelope;
        if (value.object.get("error")) |err| {
            if (err != .object) return error.InvalidRpcEnvelope;
            const code = err.object.get("code") orelse return error.InvalidRpcEnvelope;
            const message = err.object.get("message") orelse return error.InvalidRpcEnvelope;
            if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
            _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
            return true;
        }
        return false;
    }
    fn fetchNativeTimed(self: *RpcClient, native: *Curl.Client, body: []const u8, timeout_ms: u32) !Fetched {
        var response = try native.send(self.allocator, .{
            .url = self.url,
            .method = .post,
            .headers = self.native_headers,
            .body = body,
            .timeout_ms = timeout_ms,
            .connect_timeout_ms = @min(timeout_ms, self.options.connect_timeout_ms),
            .cancel = self.options.cancel,
            .max_response_bytes = self.options.max_response_bytes,
            .stop_after_http429_head = self.options.protocol == .ethereum,
        });
        defer response.deinit();
        if (self.options.protocol == .ethereum and response.status == 429) return error.RpcRateLimited;
        if (self.options.protocol != .ethereum and response.status != 200) return error.RpcHttpStatus;
        const bytes = response.takeBody();
        return .{ .bytes = bytes, .len = bytes.len };
    }

    fn fetchStd(self: *RpcClient, body: []const u8) !Fetched {
        // Fixed writer rejects both advertised and chunked oversized responses.
        const bytes = try self.allocator.alloc(u8, self.options.max_response_bytes);
        errdefer self.allocator.free(bytes);
        var sink = BoundedResponse.init(bytes);
        if (self.options.protocol == .ethereum) return self.fetchStdEthereum(body, bytes, &sink);
        const response = self.http.fetch(.{
            .location = .{ .url = self.url },
            .method = .POST,
            .payload = body,
            .headers = .{ .accept_encoding = .omit },
            .extra_headers = self.headers,
            .redirect_behavior = .unhandled,
            .response_writer = &sink.writer,
        }) catch |err| switch (err) {
            error.WriteFailed => if (sink.exceeded) return error.RpcResponseTooLarge else return err,
            else => return err,
        };
        if (response.status != .ok) return error.RpcHttpStatus;
        return .{ .bytes = bytes, .len = sink.writer.buffered().len };
    }
    fn fetchStdEthereum(self: *RpcClient, body: []const u8, bytes: []u8, sink: *BoundedResponse) !Fetched {
        var request = try self.http.request(.POST, try std.Uri.parse(self.url), .{ .headers = .{ .accept_encoding = .omit }, .extra_headers = self.headers, .redirect_behavior = .unhandled });
        defer request.deinit();
        request.transfer_encoding = .{ .content_length = body.len };
        var writer = try request.sendBodyUnflushed(&.{});
        try writer.writer.writeAll(body);
        try writer.end();
        try request.connection.?.flush();
        var response = try request.receiveHead(&.{});
        if (response.head.status == .too_many_requests) return error.RpcRateLimited;
        const decompression_bytes: usize = switch (response.head.content_encoding) {
            .identity => 0,
            .zstd => std.compress.zstd.default_window_len,
            .deflate, .gzip => std.compress.flate.max_window_len,
            .compress => return error.UnsupportedCompressionMethod,
        };
        const buffer = try self.allocator.alloc(u8, decompression_bytes);
        defer self.allocator.free(buffer);
        var transfer: [64]u8 = undefined;
        var decompressor: std.http.Decompress = undefined;
        const reader = response.readerDecompressing(&transfer, &decompressor, buffer);
        _ = reader.streamRemaining(&sink.writer) catch |err| switch (err) {
            error.ReadFailed => return response.bodyErr().?,
            error.WriteFailed => if (sink.exceeded) return error.RpcResponseTooLarge else return err,
        };
        return .{ .bytes = bytes, .len = sink.writer.buffered().len };
    }

    pub fn chainId(self: *RpcClient) !u64 {
        return std.math.cast(u64, try self.chainId256()) orelse error.ChainIdOutOfRange;
    }

    pub fn chainId256(self: *RpcClient) !u256 {
        var response = try self.callRaw("eth_chainId", .{});
        defer response.deinit();
        return abi.quantityAs(u256, try response.text());
    }

    pub fn checkChain(self: *RpcClient, expected: u256) !void {
        if (try self.chainId256() != expected) return error.WrongChain;
    }

    pub fn blockNumber(self: *RpcClient) !u64 {
        var response = try self.callRaw("eth_blockNumber", .{});
        defer response.deinit();
        return abi.quantity(try response.text());
    }

    pub fn confirmedHead(self: *RpcClient, confirmations: u64) !u64 {
        const head = try self.blockNumber();
        if (head < confirmations) return error.InsufficientConfirmations;
        return head - confirmations;
    }

    pub fn getBlock(self: *RpcClient, block: BlockRef) !RpcResponse {
        return self.call("eth_getBlockByNumber", .{ BlockParam{ .block = block }, false });
    }

    pub fn blockHeader(self: *RpcClient, block: BlockRef) !BlockHeader {
        var response = try self.callRaw("eth_getBlockByNumber", .{ BlockParam{ .block = block }, false });
        defer response.deinit();
        const header = try response.header();
        switch (block) {
            .number => |expected| if (header.number != expected) return error.WrongBlock,
            else => {},
        }
        return header;
    }

    /// The caller must authenticate each returned log against canonical headers
    /// before committing it. This checks address, topic and requested number range.
    pub fn getLogs(self: *RpcClient, address: Address, from: u64, to: u64, topic0: ?Hash) !RpcResponse {
        const filter = try LogFilter.init(self, address, from, to, topic0);
        var topic: [1]HexParam = undefined;
        var response = try self.call("eth_getLogs", .{filter.params(&topic)});
        errdefer response.deinit();
        if (response.value() != .array) return error.InvalidRpcResult;
        for (response.value().array.items) |raw| {
            var log = try Log.parse(self.allocator, raw);
            defer log.deinit();
            try filter.check(log);
        }
        return response;
    }
    /// getLogs decoded: the same request, checks and errors, returning the
    /// logs (each and the slice allocated with `allocator`) instead of JSON.
    pub fn logs(self: *RpcClient, allocator: Allocator, address: Address, from: u64, to: u64, topic0: ?Hash) ![]Log {
        const filter = try LogFilter.init(self, address, from, to, topic0);
        var topic: [1]HexParam = undefined;
        var response = try self.callRaw("eth_getLogs", .{filter.params(&topic)});
        defer response.deinit();
        if (response.raw()) |raw| if (try rawLogs(allocator, raw, false)) |decoded| {
            errdefer freeLogs(allocator, decoded);
            for (decoded) |log| try filter.check(log);
            return decoded;
        };
        // Tree path, in getLogs order: each log parsed, then checked.
        const value = try response.value();
        if (value != .array) return error.InvalidRpcResult;
        const decoded = try allocator.alloc(Log, value.array.items.len);
        var built: usize = 0;
        errdefer {
            for (decoded[0..built]) |*log| log.deinit();
            allocator.free(decoded);
        }
        for (value.array.items, decoded) |raw, *log| {
            log.* = try Log.parse(allocator, raw);
            built += 1;
            try filter.check(log.*);
        }
        return decoded;
    }
    const LogFilter = struct {
        address: Address,
        from: u64,
        to: u64,
        topic0: ?Hash,

        fn init(client: *RpcClient, address: Address, from: u64, to: u64, topic0: ?Hash) !LogFilter {
            if (from > to or to - from >= client.options.max_log_range) return error.InvalidLogRange;
            return .{ .address = address, .from = from, .to = to, .topic0 = topic0 };
        }
        const Params = struct { fromBlock: QuantityParam, toBlock: QuantityParam, address: HexParam, topics: []const HexParam };
        /// Borrows `topic` (one slot) for the topics array.
        fn params(self: *const LogFilter, topic: *[1]HexParam) Params {
            const topics: []const HexParam = if (self.topic0) |*expected| blk: {
                topic[0] = .{ .bytes = expected };
                break :blk topic[0..1];
            } else topic[0..0];
            return .{ .fromBlock = .{ .value = self.from }, .toBlock = .{ .value = self.to }, .address = .{ .bytes = &self.address }, .topics = topics };
        }
        fn check(self: *const LogFilter, log: Log) !void {
            if (log.block_number < self.from or log.block_number > self.to or !std.mem.eql(u8, &log.address, &self.address)) return error.LogOutsideFilter;
            if (self.topic0) |expected| {
                if (log.topic_count == 0 or !std.mem.eql(u8, &log.topics[0], &expected)) return error.LogOutsideFilter;
            }
        }
    };

    /// Caller owns returned raw ABI bytes.
    pub fn ethCall(self: *RpcClient, address: Address, calldata: []const u8, block: BlockRef) ![]u8 {
        var response = try self.callRaw("eth_call", .{ .{ .to = HexParam{ .bytes = &address }, .data = HexParam{ .bytes = calldata } }, BlockParam{ .block = block } });
        defer response.deinit();
        return decodeHexAlloc(self.allocator, try response.text());
    }

    pub fn delivered(self: *RpcClient, mailbox: Address, message_id: Hash, block: BlockRef) !bool {
        const bytes = try self.ethCall(mailbox, &abi.hashCall("delivered(bytes32)", message_id), block);
        defer self.allocator.free(bytes);
        return abi.decodeBool(bytes);
    }

    pub fn recipientIsm(self: *RpcClient, mailbox: Address, recipient: Address, block: BlockRef) !Address {
        const bytes = try self.ethCall(mailbox, &abi.recipientIsmCall(recipient), block);
        defer self.allocator.free(bytes);
        return abi.addressWord(bytes);
    }

    pub fn count(self: *RpcClient, hook: Address, block: BlockRef) !u32 {
        const bytes = try self.ethCall(hook, &abi.selector("count()"), block);
        defer self.allocator.free(bytes);
        return abi.uintWord(u32, bytes);
    }

    pub fn latestCheckpoint(self: *RpcClient, hook: Address, block: BlockRef) !abi.Checkpoint {
        const bytes = try self.ethCall(hook, &abi.selector("latestCheckpoint()"), block);
        defer self.allocator.free(bytes);
        return abi.decodeCheckpoint(bytes);
    }
};

/// Returns the RPC error code only for a well-formed error response. Result null
/// is valid JSON-RPC; typed methods decide whether their result may be null.
/// A Pool winner already authenticated against this id with its exact result
/// span. The envelope outside that span is still checked here, in this
/// dialect (integer id, jsonrpc "2.0", no error member), on a copy whose
/// result is replaced by `0`; then only the result is parsed (its syntax and
/// duplicate keys are checked by that parse). Null: anything unexpected, and
/// the caller decodes the whole body as before. Errors only on allocation.
pub fn adoptValidated(allocator: Allocator, bytes: []const u8, id: i64, span: envelope.Span) !?std.json.Parsed(Value) {
    if (!try adoptable(allocator, bytes, id, span)) return null;
    var tree = envelope.parseValue(allocator, span.of(bytes), true) catch |err| {
        if (err == error.OutOfMemory) return err;
        return null;
    };
    errdefer tree.deinit();
    // Same root shape callers read today (`parsed.value.object.get(...)`).
    var root = std.json.ObjectMap.init(tree.arena.allocator());
    try root.put("jsonrpc", .{ .string = "2.0" });
    try root.put("id", .{ .integer = id });
    try root.put("result", tree.value);
    tree.value = .{ .object = root };
    return tree;
}
/// The envelope half of adoptValidated: whether everything outside the
/// pool-validated result span is a plain success envelope for `id`.
fn adoptable(allocator: Allocator, bytes: []const u8, id: i64, span: envelope.Span) !bool {
    if (span.start >= span.end or span.end > bytes.len) return false;
    const outside_len = bytes.len - (span.end - span.start) + 1;
    var stack: [512]u8 = undefined;
    const heap = if (outside_len > stack.len) try allocator.alloc(u8, outside_len) else null;
    defer if (heap) |memory| allocator.free(memory);
    const outside = heap orelse stack[0..outside_len];
    @memcpy(outside[0..span.start], bytes[0..span.start]);
    outside[span.start] = '0';
    @memcpy(outside[span.start + 1 ..], bytes[span.end..]);
    const top = envelope.scan(allocator, outside, .{}) catch |err| {
        if (err == error.OutOfMemory) return err;
        return false;
    };
    if (!top.object or top.get(.@"error") != null) return false;
    const version = top.get(.jsonrpc) orelse return false;
    if (!envelope.isString(outside, version, "2.0")) return false;
    const actual = top.get(.id) orelse return false;
    const text = actual.span.of(outside);
    if (actual.kind != .number or !std.json.isNumberFormattedLikeAnInteger(text)) return false;
    if ((std.fmt.parseInt(i64, text, 10) catch return false) != id) return false;
    const result = top.get(.result) orelse return false;
    return result.span.start == span.start and result.span.end == span.start + 1;
}

pub fn validateEnvelope(value: Value, expected_id: i64) !?i64 {
    if (value != .object) return error.InvalidRpcEnvelope;
    const object = value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return error.InvalidRpcEnvelope;
    const id = object.get("id") orelse return error.InvalidRpcEnvelope;
    if (id != .integer or id.integer != expected_id) return error.RpcIdMismatch;
    const has_result = object.contains("result");
    const has_error = object.contains("error");
    if (has_result == has_error) return error.InvalidRpcEnvelope;
    if (has_error) {
        const rpc_error = object.get("error").?;
        if (rpc_error != .object) return error.InvalidRpcEnvelope;
        const code = rpc_error.object.get("code") orelse return error.InvalidRpcEnvelope;
        const message = rpc_error.object.get("message") orelse return error.InvalidRpcEnvelope;
        if (code != .integer or message != .string) return error.InvalidRpcEnvelope;
        return code.integer;
    }
    return null;
}

fn field(value: Value, name: []const u8) !Value {
    if (value != .object) return error.InvalidRpcResult;
    return value.object.get(name) orelse error.InvalidRpcResult;
}

pub fn string(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidRpcResult;
    return value.string;
}

fn decodeHexAlloc(allocator: Allocator, text: []const u8) ![]u8 {
    if (text.len < 2 or text.len % 2 != 0 or !std.mem.startsWith(u8, text, "0x")) return error.InvalidHex;
    const bytes = try allocator.alloc(u8, (text.len - 2) / 2);
    errdefer allocator.free(bytes);
    _ = try abi.decodeHex(bytes, text);
    return bytes;
}

pub const BlockHeader = @import("header.zig").Header;

pub fn freeLogs(allocator: Allocator, items: []Log) void {
    for (items) |*log| log.deinit();
    allocator.free(items);
}

const LogField = enum { removed, topics, address, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, data };

/// The logs Log.parse returns for every element of the eth_getLogs result
/// JSON `result` (allocated with `allocator`), read from its bytes. Null when
/// any element would fail Log.parse or cannot be decided here (escapes,
/// duplicate keys, odd shapes): the caller then decodes the tree, which owns
/// every error. `absent_removed`: a missing or null `removed` reads as false
/// (scraper.evm.parseLog); otherwise it must be present like Log.parse.
pub fn rawLogs(allocator: Allocator, result: []const u8, absent_removed: bool) !?[]Log {
    var scratch = std.heap.stackFallback(1024, allocator);
    const rows = (try json_fast.elements(LogField, allocator, scratch.get(), result)) orelse return null;
    defer allocator.free(rows);
    const logs = try allocator.alloc(Log, rows.len);
    var built: usize = 0;
    errdefer {
        for (logs[0..built]) |*log| log.deinit();
        allocator.free(logs);
    }
    for (rows, logs) |row, *log| {
        log.* = (try rawLog(allocator, result, row, absent_removed)) orelse {
            for (logs[0..built]) |*done| done.deinit();
            allocator.free(logs);
            return null;
        };
        built += 1;
    }
    return logs;
}
fn rawLog(allocator: Allocator, bytes: []const u8, row: json_fast.Fields(LogField), absent_removed: bool) !?Log {
    const Field = struct {
        fn text(input: []const u8, found: ?envelope.Member) ?[]const u8 {
            const member = found orelse return null;
            if (member.kind != .string) return null;
            const raw = member.span.of(input);
            if (std.mem.indexOfScalar(u8, raw, '\\') != null) return null;
            return raw[1 .. raw.len - 1];
        }
    };
    const at = struct {
        fn f(r: json_fast.Fields(LogField), name: LogField) ?envelope.Member {
            return r[@intFromEnum(name)];
        }
    }.f;
    if (at(row, .removed)) |removed| {
        const raw = removed.span.of(bytes);
        if (!std.mem.eql(u8, raw, "false") and !(absent_removed and std.mem.eql(u8, raw, "null"))) return null;
    } else if (!absent_removed) return null;
    // Topics: an already-validated array of at most four unescaped strings.
    const topics_member = at(row, .topics) orelse return null;
    var topics: [4]Hash = .{.{0} ** 32} ** 4;
    var topic_count: u8 = 0;
    {
        const raw = topics_member.span.of(bytes);
        if (raw[0] != '[') return null;
        var i: usize = 1;
        while (true) {
            while (i < raw.len and std.ascii.isWhitespace(raw[i])) i += 1;
            if (i >= raw.len) return null;
            if (raw[i] == ']') break;
            if (raw[i] == ',') {
                i += 1;
                continue;
            }
            if (raw[i] != '"' or topic_count == 4) return null;
            const end = std.mem.indexOfScalarPos(u8, raw, i + 1, '"') orelse return null;
            const text = raw[i + 1 .. end];
            if (std.mem.indexOfScalar(u8, text, '\\') != null) return null;
            topics[topic_count] = abi.fixedHex(32, text) catch return null;
            topic_count += 1;
            i = end + 1;
        }
    }
    const address = abi.fixedHex(20, Field.text(bytes, at(row, .address)) orelse return null) catch return null;
    const block_number = abi.quantity(Field.text(bytes, at(row, .blockNumber)) orelse return null) catch return null;
    const block_hash = abi.fixedHex(32, Field.text(bytes, at(row, .blockHash)) orelse return null) catch return null;
    const transaction_hash = abi.fixedHex(32, Field.text(bytes, at(row, .transactionHash)) orelse return null) catch return null;
    const transaction_index = abi.quantity(Field.text(bytes, at(row, .transactionIndex)) orelse return null) catch return null;
    const log_index = abi.quantity(Field.text(bytes, at(row, .logIndex)) orelse return null) catch return null;
    const data_text = Field.text(bytes, at(row, .data)) orelse return null;
    const data = decodeHexAlloc(allocator, data_text) catch |err| return if (err == error.OutOfMemory) err else null;
    return .{ .allocator = allocator, .address = address, .topics = topics, .topic_count = topic_count, .data = data, .block_number = block_number, .block_hash = block_hash, .transaction_hash = transaction_hash, .transaction_index = transaction_index, .log_index = log_index };
}

pub const Log = struct {
    allocator: Allocator,
    address: Address,
    topics: [4]Hash,
    topic_count: u8,
    data: []u8,
    block_number: u64,
    block_hash: Hash,
    transaction_hash: Hash,
    transaction_index: u64,
    log_index: u64,

    pub fn parse(allocator: Allocator, raw: Value) !Log {
        const removed = try field(raw, "removed");
        if (removed != .bool) return error.InvalidRpcResult;
        if (removed.bool) return error.RemovedLog;
        const raw_topics = try field(raw, "topics");
        if (raw_topics != .array or raw_topics.array.items.len > 4) return error.InvalidRpcResult;
        var topics: [4]Hash = .{.{0} ** 32} ** 4;
        for (raw_topics.array.items, 0..) |entry, i| topics[i] = try abi.fixedHex(32, try string(entry));
        // Allocate data last, after all fallible metadata validation.
        const address = try abi.fixedHex(20, try string(try field(raw, "address")));
        const block_number = try abi.quantity(try string(try field(raw, "blockNumber")));
        const block_hash = try abi.fixedHex(32, try string(try field(raw, "blockHash")));
        const transaction_hash = try abi.fixedHex(32, try string(try field(raw, "transactionHash")));
        const transaction_index = try abi.quantity(try string(try field(raw, "transactionIndex")));
        const log_index = try abi.quantity(try string(try field(raw, "logIndex")));
        const data = try decodeHexAlloc(allocator, try string(try field(raw, "data")));
        return .{ .allocator = allocator, .address = address, .topics = topics, .topic_count = @intCast(raw_topics.array.items.len), .data = data, .block_number = block_number, .block_hash = block_hash, .transaction_hash = transaction_hash, .transaction_index = transaction_index, .log_index = log_index };
    }

    pub fn deinit(self: *Log) void {
        self.allocator.free(self.data);
        self.* = undefined;
    }

    pub fn event(self: Log) !abi.Event {
        return abi.decodeEvent(self.topics[0..self.topic_count], self.data);
    }

    pub fn matchesHeader(self: Log, header: BlockHeader) bool {
        return self.block_number == header.number and std.mem.eql(u8, &self.block_hash, &header.hash);
    }
};

test "RPC envelope rejects ambiguous mismatched and malformed responses" {
    const cases = [_][]const u8{
        "[]",
        "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":0}",
        "{\"jsonrpc\":\"2.0\",\"id\":1}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null,\"error\":{\"code\":-1,\"message\":\"bad\"}}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":null}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":\"-1\",\"message\":\"bad\"}}",
    };
    for (cases) |text| {
        var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, text, .{});
        defer parsed.deinit();
        try std.testing.expectError(error.InvalidRpcEnvelope, validateEnvelope(parsed.value, 1));
    }
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}", .{});
    defer parsed.deinit();
    try std.testing.expectError(error.RpcIdMismatch, validateEnvelope(parsed.value, 1));
    try std.testing.expectEqual(@as(?i64, null), try validateEnvelope(parsed.value, 2));
}

test "JSON-RPC errors retain only safe error code" {
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"private endpoint detail\"}}", .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(?i64, -32000), try validateEnvelope(parsed.value, 1));
}

const ManyFixture = struct {
    calls: usize = 0,
    many_calls: usize = 0,
    /// Index of the response replaced by a JSON-RPC error object, if any.
    error_at: ?usize = null,
    fn reply(a: Allocator, body: []const u8, rpc_error: bool) !WireResponse {
        var request = try std.json.parseFromSlice(Value, a, body, .{});
        defer request.deinit();
        const id = request.value.object.get("id").?.integer;
        const bytes = if (rpc_error)
            try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{{\"code\":3,\"message\":\"x\"}}}}", .{id})
        else
            try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x{x}\"}}", .{ id, id });
        return .{ .bytes = bytes, .len = bytes.len };
    }
    fn fetch(context: *anyopaque, a: Allocator, body: []const u8, _: Options) anyerror!WireResponse {
        const self: *ManyFixture = @ptrCast(@alignCast(context));
        self.calls += 1;
        return reply(a, body, false);
    }
    fn fetchMany(context: *anyopaque, a: Allocator, bodies: []const []const u8, _: Options, out: []WireResponse) anyerror!void {
        const self: *ManyFixture = @ptrCast(@alignCast(context));
        self.many_calls += 1;
        var filled: usize = 0;
        errdefer for (out[0..filled]) |wire| a.free(wire.bytes);
        for (bodies, out, 0..) |body, *slot, index| {
            slot.* = try reply(a, body, self.error_at == index);
            filled += 1;
        }
    }
};

fn callManyExercise(a: Allocator, error_at: ?usize) !void {
    var fixture: ManyFixture = .{ .error_at = error_at };
    var client = try RpcClient.init(a, "http://fixture/rpc", .{ .exchange = .{ .context = &fixture, .fetch_fn = ManyFixture.fetch, .fetch_many_fn = ManyFixture.fetchMany } });
    defer client.deinit();
    const calls = [_]RawCall{ .{ .method = "eth_chainId", .params_json = "[]" }, .{ .method = "eth_blockNumber", .params_json = "[]" }, .{ .method = "eth_gasPrice", .params_json = "[]" } };
    var out: [3]RpcResponse = undefined;
    try client.callMany(&calls, &out);
    defer for (&out) |*response| response.deinit();
    try std.testing.expectEqual(@as(usize, 1), fixture.many_calls);
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
    for (out, [_][]const u8{ "0x1", "0x2", "0x3" }) |response, expected| try std.testing.expectEqualStrings(expected, response.value().string);
}

test "RPC callMany overlaps through fetch_many, keeps id order, and frees everything on error" {
    try callManyExercise(std.testing.allocator, null);
    try std.testing.expectError(error.RpcError, callManyExercise(std.testing.allocator, 1));
    try std.testing.checkAllAllocationFailures(std.testing.allocator, callManyExercise, .{null});
    // Without fetch_many the same calls run serially through fetch_fn.
    var fixture: ManyFixture = .{};
    var client = try RpcClient.init(std.testing.allocator, "http://fixture/rpc", .{ .exchange = .{ .context = &fixture, .fetch_fn = ManyFixture.fetch } });
    defer client.deinit();
    var out: [2]RpcResponse = undefined;
    try client.callMany(&.{ .{ .method = "eth_chainId", .params_json = "[]" }, .{ .method = "eth_chainId", .params_json = "[1]" } }, &out);
    defer for (&out) |*response| response.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.calls);
    try std.testing.expectEqualStrings("0x2", out[1].value().string);
}

test "RPC configuration and invalid log ranges reject before network access" {
    for ([_][]const u8{ "ftp://localhost", "http://localhost/#fragment" }) |url|
        try std.testing.expectError(error.InvalidRpcUrl, RpcClient.init(std.testing.allocator, url, .{}));
    var client = try RpcClient.init(std.testing.allocator, "http://127.0.0.1:1", .{ .max_log_range = 10 });
    defer client.deinit();
    try std.testing.expectError(error.InvalidLogRange, client.getLogs(.{0} ** 20, 10, 9, null));
    try std.testing.expectError(error.InvalidLogRange, client.getLogs(.{0} ** 20, 0, 10, null));
}

test "RPC endpoint credentials and custom headers are owned sanitized and emitted once" {
    var client = try RpcClient.init(std.testing.allocator, "https://fixture-user:fixture-password@fixture/rpc?custom_rpc_header=X-Test:one&custom_rpc_header=Content-Type:application/json&keep=one%20two", .{});
    defer client.deinit();
    try std.testing.expectEqualStrings("https://fixture/rpc?keep=one+two", client.url);
    var content_types: usize = 0;
    var authorizations: usize = 0;
    for (client.headers, client.native_headers) |header, native| {
        try std.testing.expectEqualStrings(header.name, native.name);
        try std.testing.expectEqualStrings(header.value, native.value);
        if (std.ascii.eqlIgnoreCase(header.name, "content-type")) content_types += 1;
        if (std.ascii.eqlIgnoreCase(header.name, "authorization")) {
            authorizations += 1;
            // Fixed expected bytes keep this assertion independent of the production encoder.
            try std.testing.expect(std.mem.startsWith(u8, header.value, "Basic "));
            try std.testing.expectEqualSlices(u8, &.{ 90, 109, 108, 52, 100, 72, 86, 121, 90, 83, 49, 49, 99, 50, 86, 121, 79, 109, 90, 112, 101, 72, 82, 49, 99, 109, 85, 116, 99, 71, 70, 122, 99, 51, 100, 118, 99, 109, 81, 61 }, header.value[6..]);
        }
    }
    try std.testing.expectEqual(@as(usize, 1), content_types);
    try std.testing.expectEqual(@as(usize, 1), authorizations);
}

test "missing blocks and noncanonical block quantities reject" {
    try std.testing.expectError(error.MissingBlock, BlockHeader.parse(.null));
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"number\":\"0x01\"}", .{});
    defer parsed.deinit();
    try std.testing.expectError(error.InvalidQuantity, BlockHeader.parse(parsed.value));
}

const Fixture = struct {
    server: std.net.Server,
    body: []const u8,
    status: u16 = 200,
    failure: ?anyerror = null,
    stall_ms: u64 = 0,

    fn serve(self: *Fixture) void {
        self.serveFallible() catch |err| {
            self.failure = err;
        };
    }

    fn serveFallible(self: *Fixture) !void {
        const connection = try self.server.accept();
        defer connection.stream.close();
        var request: [8192]u8 = undefined;
        var used: usize = 0;
        while (true) {
            if (used == request.len) return error.FixtureRequestTooLarge;
            const read = try connection.stream.read(request[used..]);
            if (read == 0) return error.FixtureUnexpectedEof;
            used += read;
            if (std.mem.indexOf(u8, request[0..used], "\r\n\r\n")) |header_end| {
                const prefix = "content-length: ";
                const start = std.ascii.indexOfIgnoreCase(request[0..header_end], prefix) orelse return error.FixtureMissingLength;
                const value_start = start + prefix.len;
                const value_end = std.mem.indexOfPos(u8, request[0..used], value_start, "\r\n") orelse return error.FixtureMissingLength;
                const length = try std.fmt.parseInt(usize, request[value_start..value_end], 10);
                if (used < header_end + 4 + length) continue;
                var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, request[header_end + 4 ..][0..length], .{});
                defer parsed.deinit();
                const params = try field(parsed.value, "params");
                if (params != .array) return error.FixtureParamsNotArray;
                break;
            }
        }
        if (self.stall_ms > 0) std.Thread.sleep(self.stall_ms * std.time.ns_per_ms);
        var header_buffer: [128]u8 = undefined;
        const header = try std.fmt.bufPrint(&header_buffer, "HTTP/1.1 {d} Fixture\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ self.status, self.body.len });
        try connection.stream.writeAll(header);
        try connection.stream.writeAll(self.body);
    }
};

test "native RPC transport enforces envelope bounds cancellation and deadline" {
    const library = std.process.getEnvVarOwned(std.testing.allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer std.testing.allocator.free(library);
    var transport = try Curl.Client.init(std.testing.allocator, library);
    defer transport.deinit();
    const cases = [_]struct { stall_ms: u64, limit: usize, expected: ?anyerror }{
        .{ .stall_ms = 0, .limit = 1024, .expected = null },
        .{ .stall_ms = 0, .limit = 8, .expected = error.ResponseTooLarge },
        .{ .stall_ms = 150, .limit = 1024, .expected = error.RequestDeadlineExceeded },
    };
    for (cases) |case| {
        var fixture: Fixture = .{
            .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}),
            .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}",
            .stall_ms = case.stall_ms,
        };
        defer fixture.server.deinit();
        const url = try std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
        defer std.testing.allocator.free(url);
        var client = try RpcClient.init(std.testing.allocator, url, .{ .native_transport = &transport, .max_response_bytes = case.limit, .timeout_ms = if (case.stall_ms > 0) 50 else 2000 });
        defer client.deinit();
        const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
        defer thread.join();
        if (case.expected) |expected| {
            try std.testing.expectError(expected, client.chainId());
        } else {
            try std.testing.expectEqual(@as(u64, 1), try client.chainId());
        }
    }
    var cancel = std.atomic.Value(bool).init(true);
    var client = try RpcClient.init(std.testing.allocator, "http://127.0.0.1:1", .{ .native_transport = &transport, .cancel = &cancel });
    defer client.deinit();
    try std.testing.expectError(error.RequestCancelled, client.chainId());
}

const FixtureOperation = enum { chain_id, block_number, confirmed_head, check_chain, get_block, block_header, logs, eth_call, delivered, recipient_ism, count, checkpoint };

fn loopbackRequest(body: []const u8, status: u16, limit: usize, operation: FixtureOperation) !u64 {
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .body = body, .status = status };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    defer std.testing.allocator.free(url);
    var client = try RpcClient.init(std.testing.allocator, url, .{ .max_response_bytes = limit });
    defer client.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    return switch (operation) {
        .chain_id => client.chainId(),
        .block_number => client.blockNumber(),
        .confirmed_head => client.confirmedHead(1),
        .check_chain => blk: {
            try client.checkChain(1);
            break :blk 1;
        },
        .get_block => blk: {
            var response = try client.getBlock(.{ .number = 1 });
            defer response.deinit();
            break :blk (try BlockHeader.parse(response.value())).number;
        },
        .block_header => (try client.blockHeader(.{ .number = 1 })).number,
        .logs => blk: {
            var response = try client.getLogs(.{0} ** 20, 1, 1, null);
            defer response.deinit();
            break :blk @intCast(response.value().array.items.len);
        },
        .eth_call => blk: {
            const bytes = try client.ethCall(.{0} ** 20, &.{}, .{ .number = 1 });
            defer std.testing.allocator.free(bytes);
            break :blk @intCast(bytes.len);
        },
        .delivered => if (try client.delivered(.{0} ** 20, .{0} ** 32, .{ .number = 1 })) 1 else 0,
        .recipient_ism => (try client.recipientIsm(.{0} ** 20, .{0} ** 20, .{ .number = 1 }))[19],
        .count => try client.count(.{0} ** 20, .{ .number = 1 }),
        .checkpoint => (try client.latestCheckpoint(.{0} ** 20, .{ .number = 1 })).index,
    };
}

test "HTTP loopback exercises typed RPC calls and bounded envelopes" {
    const ok = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}";
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(ok, 200, 1024, .chain_id));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(ok, 200, 1024, .check_chain));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(ok, 200, 1024, .block_number));
    try std.testing.expectEqual(@as(u64, 0), try loopbackRequest(ok, 200, 1024, .confirmed_head));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(ok, 500, 1024, .chain_id));
    try std.testing.expectError(error.RpcRateLimited, loopbackRequest(ok, 429, 1024, .chain_id));
    try std.testing.expectError(error.RpcResponseTooLarge, loopbackRequest(ok, 200, 16, .chain_id));
    try std.testing.expectError(error.RpcIdMismatch, loopbackRequest("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x1\"}", 200, 1024, .chain_id));
    try std.testing.expectError(error.RpcResponseDecode, loopbackRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"id\":1,\"result\":\"0x1\"}", 200, 1024, .chain_id));
}

test "HTTP loopback validates block and call result types" {
    const header = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x1\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x2\"}}";
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(header, 200, 1024, .get_block));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(header, 200, 1024, .block_header));
    const boolean = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\"}";
    try std.testing.expectEqual(@as(u64, 32), try loopbackRequest(boolean, 200, 1024, .eth_call));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(boolean, 200, 1024, .delivered));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(boolean, 200, 1024, .recipient_ism));
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(boolean, 200, 1024, .count));
    const checkpoint = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000007\"}";
    try std.testing.expectEqual(@as(u64, 7), try loopbackRequest(checkpoint, 200, 1024, .checkpoint));
    try std.testing.expectError(error.InvalidRpcResult, loopbackRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":0}", 200, 1024, .logs));
    try std.testing.expectEqual(@as(u64, 0), try loopbackRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[]}", 200, 1024, .logs));
}

const fixture_log = "{\"address\":\"0x0000000000000000000000000000000000000000\",\n\"topics\":[\"0x253a3a04cab70d47c1504809242d9350" ++ "cd81627b4f1d50753e159cf8cd76ed33\"],\n\"data\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000007\",\n\"blockNumber\":\"0x1\",\"blockHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\n\"transactionHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000002\",\n\"transactionIndex\":\"0x0\",\"logIndex\":\"0x2\",\"removed\":false}";

test "log parser validates full metadata canonical identity and removed logs" {
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, fixture_log, .{});
    defer parsed.deinit();
    var log = try Log.parse(std.testing.allocator, parsed.value);
    defer log.deinit();
    try std.testing.expectEqual(@as(u32, 7), (try log.event()).insertion.index);
    try std.testing.expectEqual(@as(u64, 2), log.log_index);
    var header: BlockHeader = .{ .number = 1, .hash = log.block_hash, .parent_hash = .{0} ** 32, .timestamp = 1 };
    try std.testing.expect(log.matchesHeader(header));
    header.hash[0] = 1;
    try std.testing.expect(!log.matchesHeader(header));
    parsed.value.object.getPtr("removed").?.* = .{ .bool = true };
    try std.testing.expectError(error.RemovedLog, Log.parse(std.testing.allocator, parsed.value));
    parsed.value.object.getPtr("removed").?.* = .{ .bool = false };
    parsed.value.object.getPtr("blockNumber").?.* = .{ .string = "0x01" };
    try std.testing.expectError(error.InvalidQuantity, Log.parse(std.testing.allocator, parsed.value));
}

test "HTTP log filter rejects out of range and mismatched contract logs" {
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, fixture_log, .{});
    defer parsed.deinit();
    const response = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .jsonrpc = "2.0", .id = 1, .result = .{parsed.value} }, .{});
    defer std.testing.allocator.free(response);
    try std.testing.expectEqual(@as(u64, 1), try loopbackRequest(response, 200, 2048, .logs));
    parsed.value.object.getPtr("blockNumber").?.* = .{ .string = "0x2" };
    const outside = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .jsonrpc = "2.0", .id = 1, .result = .{parsed.value} }, .{});
    defer std.testing.allocator.free(outside);
    try std.testing.expectError(error.LogOutsideFilter, loopbackRequest(outside, 200, 2048, .logs));
    parsed.value.object.getPtr("blockNumber").?.* = .{ .string = "0x1" };
    parsed.value.object.getPtr("address").?.* = .{ .string = "0x0000000000000000000000000000000000000001" };
    const wrong_contract = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .jsonrpc = "2.0", .id = 1, .result = .{parsed.value} }, .{});
    defer std.testing.allocator.free(wrong_contract);
    try std.testing.expectError(error.LogOutsideFilter, loopbackRequest(wrong_contract, 200, 2048, .logs));
}

test {
    _ = @import("logs_differential_test.zig");
}

fn expectBody(client: *RpcClient, id: i64, method: []const u8, params: anytype, legacy: anytype) !void {
    const expected = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = legacy }, .{});
    defer std.testing.allocator.free(expected);
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(expected, try client.encode(&buffer, id, method, params));
}

test "request bodies are byte-identical to Stringify of the whole envelope" {
    const a = std.testing.allocator;
    var client = try RpcClient.init(a, "http://fixture/rpc", .{});
    defer client.deinit();
    // Generic params go through Stringify unchanged.
    var tree = try std.json.parseFromSlice(Value, a, "{\"b\":[1,2.5,\"x\\u0000y\"],\"a\":null,\"c\":{\"d\":true}}", .{});
    defer tree.deinit();
    const Optional = struct { to: ?[]const u8, value: ?u64 = null, nested: struct { flag: bool, list: []const []const u8 } };
    const strings = [_][]const u8{ "plain", "q\"uote", "back\\slash", "ctl\x01\n\t", "\u{e9}\u{1F600}", "bad\xff" };
    for ([_]i64{ 1, 0, -1, std.math.maxInt(i64), std.math.minInt(i64) }) |id| {
        try expectBody(&client, id, "eth_chainId", .{}, .{});
        try expectBody(&client, id, "eth_getBlockByNumber", .{ "latest", false }, .{ "latest", false });
        try expectBody(&client, id, "x", tree.value, tree.value);
        try expectBody(&client, id, "x", .{Optional{ .to = null, .nested = .{ .flag = false, .list = &strings } }}, .{Optional{ .to = null, .nested = .{ .flag = false, .list = &strings } }});
        try expectBody(&client, id, "eth_sendRawTransaction", .{"0x02f8"}, .{"0x02f8"});
        for (strings) |text| {
            try expectBody(&client, id, text, .{text}, .{text});
            // Raw params (callMany) match the former allocPrint body.
            const legacy_method = try std.json.Stringify.valueAlloc(a, text, .{});
            defer a.free(legacy_method);
            const legacy = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":{s},\"params\":{s}}}", .{ id, legacy_method, "[\"0x1\",false]" });
            defer a.free(legacy);
            var buffer: std.ArrayList(u8) = .empty;
            defer buffer.deinit(a);
            try std.testing.expectEqualStrings(legacy, try client.encode(&buffer, id, text, RawParams{ .json = "[\"0x1\",false]" }));
        }
    }
    // Typed params write the same text the allocating helpers produced.
    var calldata: [300]u8 = undefined;
    for (&calldata, 0..) |*byte, i| byte.* = @truncate(i *% 37);
    const address: Address = .{ 0x00, 0xff, 0x10 } ++ .{0xab} ** 17;
    const blocks = [_]BlockRef{ .{ .number = 0 }, .{ .number = 0x10 }, .{ .number = std.math.maxInt(u64) }, .latest, .safe, .finalized, .earliest, .pending };
    for (blocks) |block| {
        const tag = try block.text(a);
        defer a.free(tag);
        try expectBody(&client, 7, "eth_getBlockByNumber", .{ BlockParam{ .block = block }, false }, .{ tag, false });
        for ([_][]const u8{ "", calldata[0..1], calldata[0..64], calldata[0..65], &calldata }) |data| {
            const to = try abi.hexAlloc(a, &address);
            defer a.free(to);
            const data_text = try abi.hexAlloc(a, data);
            defer a.free(data_text);
            try expectBody(&client, 7, "eth_call", .{ .{ .to = HexParam{ .bytes = &address }, .data = HexParam{ .bytes = data } }, BlockParam{ .block = block } }, .{ .{ .to = to, .data = data_text }, tag });
        }
    }
    for ([_]?Hash{ null, .{0x5a} ** 32 }) |topic0| for ([_][2]u64{ .{ 0, 0 }, .{ 1, 1999 }, .{ 0x123456, std.math.maxInt(u64) } }) |range| {
        const filter: RpcClient.LogFilter = .{ .address = address, .from = range[0], .to = range[1], .topic0 = topic0 };
        var topic: [1]HexParam = undefined;
        const from_text = try abi.quantityAlloc(a, range[0]);
        defer a.free(from_text);
        const to_text = try abi.quantityAlloc(a, range[1]);
        defer a.free(to_text);
        const address_text = try abi.hexAlloc(a, &address);
        defer a.free(address_text);
        const topic_text = if (topic0) |t| try abi.hexAlloc(a, &t) else null;
        defer if (topic_text) |t| a.free(t);
        var topics: [1][]const u8 = undefined;
        if (topic_text) |t| topics[0] = t;
        try expectBody(&client, 9, "eth_getLogs", .{filter.params(&topic)}, .{.{ .fromBlock = from_text, .toBlock = to_text, .address = address_text, .topics = if (topic_text != null) topics[0..1] else topics[0..0] }});
    };
    // scraper.evm events(): three addresses, one OR-set of four topics.
    const contracts = [3]Address{ address, .{0x01} ** 20, .{0xfe} ** 20 };
    const hashes = [4]Hash{ .{0x11} ** 32, .{0x22} ** 32, .{0x33} ** 32, .{0x44} ** 32 };
    var address_params: [3]HexParam = undefined;
    var address_texts: [3][]const u8 = undefined;
    for (&contracts, &address_params, &address_texts) |*contract, *param, *text| {
        param.* = .{ .bytes = contract };
        text.* = try abi.hexAlloc(a, contract);
    }
    defer for (address_texts) |text| a.free(text);
    var topic_params: [4]HexParam = undefined;
    var topic_texts: [4][]const u8 = undefined;
    for (&hashes, &topic_params, &topic_texts) |*hash, *param, *text| {
        param.* = .{ .bytes = hash };
        text.* = try abi.hexAlloc(a, hash);
    }
    defer for (topic_texts) |text| a.free(text);
    const from_text = try abi.quantityAlloc(a, 0x1b4);
    defer a.free(from_text);
    const through_text = try abi.quantityAlloc(a, 0x2000);
    defer a.free(through_text);
    try expectBody(&client, 11, "eth_getLogs", .{.{ .fromBlock = QuantityParam{ .value = 0x1b4 }, .toBlock = QuantityParam{ .value = 0x2000 }, .address = address_params, .topics = .{topic_params} }}, .{.{ .fromBlock = from_text, .toBlock = through_text, .address = address_texts, .topics = .{topic_texts} }});
    // New bodies start at the last body's size.
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(a);
    _ = try client.encode(&buffer, 1, "eth_chainId", .{});
    try std.testing.expect(buffer.capacity >= client.body_hint);
}

test "a call parked mid-exchange keeps its body while another call on the same client runs" {
    // Lane fibers share one client and park inside fetch; a nested call stands
    // in for the sibling fiber that runs while the first is parked.
    const Nested = struct {
        client: *RpcClient = undefined,
        depth: usize = 0,
        fn fetch(context: *anyopaque, allocator: Allocator, body: []const u8, _: Options) anyerror!WireResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            const before = try allocator.dupe(u8, body);
            defer allocator.free(before);
            self.depth += 1;
            if (self.depth == 1) {
                var inner = try self.client.call("eth_call", .{ .{ .to = "0x" ++ "22" ** 20, .data = "0x" ++ "ab" ** 300 }, "latest" });
                inner.deinit();
            }
            try std.testing.expectEqualStrings(before, body);
            var parsed = try std.json.parseFromSlice(struct { id: i64 }, allocator, body, .{ .ignore_unknown_fields = true });
            defer parsed.deinit();
            const bytes = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x01\"}}", .{parsed.value.id});
            return .{ .bytes = bytes, .len = bytes.len };
        }
    };
    var fixture: Nested = .{};
    var client = try RpcClient.init(std.testing.allocator, "http://fixture/rpc", .{ .exchange = .{ .context = &fixture, .fetch_fn = Nested.fetch } });
    defer client.deinit();
    fixture.client = &client;
    var outer = try client.call("eth_blockNumber", .{});
    defer outer.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.depth);
}
