const std = @import("std");
const abi = @import("codecs.zig");
const Curl = @import("../net/curl.zig");
const Endpoint = @import("../net/endpoint.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
const TipCache = @import("../net/dynamic_tip_cache.zig");
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

pub const WireResponse = struct { bytes: []u8, len: usize };
pub const Exchange = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, Allocator, []const u8, Options) anyerror!WireResponse,
    commit_read_section_fn: ?*const fn (*anyopaque) anyerror!void = null,
};
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
    headers: []std.http.Header,
    native_headers: []Curl.Header,
    http: std.http.Client,
    options: Options,
    next_id: i64 = 1,
    last_rpc_error_code: ?i64 = null,

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
        return .{ .allocator = allocator, .url = endpoint.endpoint.url, .endpoint = endpoint, .headers = try headers.toOwnedSlice(allocator), .native_headers = native_headers, .http = .{ .allocator = allocator }, .options = options };
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
        if (method.len == 0 or method.len > 128) return error.InvalidRpcMethod;
        if (self.next_id == std.math.maxInt(i64)) return error.RpcIdExhausted;
        const id = self.next_id;
        self.next_id += 1;
        self.last_rpc_error_code = null;
        const body = try std.json.Stringify.valueAlloc(self.allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = params }, .{});
        defer self.allocator.free(body);
        const fetched = if (self.options.exchange) |exchange| try exchange.fetch_fn(exchange.context, self.allocator, body, self.options) else if (self.options.native_transport) |native| try self.fetchNative(native, body) else try self.fetchStd(body);
        errdefer self.allocator.free(fetched.bytes);
        if (fetched.len > fetched.bytes.len or fetched.len > self.options.max_response_bytes) return error.RpcResponseTooLarge;
        var parsed = std.json.parseFromSlice(Value, self.allocator, fetched.bytes[0..fetched.len], .{ .duplicate_field_behavior = .@"error", .max_value_len = self.options.max_response_bytes }) catch |err| return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        errdefer parsed.deinit();
        self.last_rpc_error_code = validateEnvelope(parsed.value, id) catch |err| return @import("pool.zig").responseDecodeError(self.options.protocol, err);
        if (self.options.protocol == .ethereum and self.last_rpc_error_code == null and @import("header.zig").isMethod(method)) {
            var request = try std.json.parseFromSlice(Value, self.allocator, body, .{});
            defer request.deinit();
            try @import("header.zig").validateResult(method, request.value.object.get("params").?, parsed.value.object.get("result").?);
        }
        return .{ .allocator = self.allocator, .bytes = fetched.bytes, .parsed = parsed };
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
        const hash = (try TipCache.key(self.allocator, self.endpoint.identity, method, params)) orelse return self.fetchNativeTimed(native, body, self.options.timeout_ms);
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
        var response = try self.call("eth_chainId", .{});
        defer response.deinit();
        return abi.quantityAs(u256, try string(response.value()));
    }

    pub fn checkChain(self: *RpcClient, expected: u256) !void {
        if (try self.chainId256() != expected) return error.WrongChain;
    }

    pub fn blockNumber(self: *RpcClient) !u64 {
        var response = try self.call("eth_blockNumber", .{});
        defer response.deinit();
        return abi.quantity(try string(response.value()));
    }

    pub fn confirmedHead(self: *RpcClient, confirmations: u64) !u64 {
        const head = try self.blockNumber();
        if (head < confirmations) return error.InsufficientConfirmations;
        return head - confirmations;
    }

    pub fn getBlock(self: *RpcClient, block: BlockRef) !RpcResponse {
        const tag = try block.text(self.allocator);
        defer self.allocator.free(tag);
        return self.call("eth_getBlockByNumber", .{ tag, false });
    }

    pub fn blockHeader(self: *RpcClient, block: BlockRef) !BlockHeader {
        var response = try self.getBlock(block);
        defer response.deinit();
        const header = try BlockHeader.parse(response.value());
        switch (block) {
            .number => |expected| if (header.number != expected) return error.WrongBlock,
            else => {},
        }
        return header;
    }

    /// The caller must authenticate each returned log against canonical headers
    /// before committing it. This checks address, topic and requested number range.
    pub fn getLogs(self: *RpcClient, address: Address, from: u64, to: u64, topic0: ?Hash) !RpcResponse {
        if (from > to or to - from >= self.options.max_log_range) return error.InvalidLogRange;
        const from_text = try abi.quantityAlloc(self.allocator, from);
        defer self.allocator.free(from_text);
        const to_text = try abi.quantityAlloc(self.allocator, to);
        defer self.allocator.free(to_text);
        const address_text = try abi.hexAlloc(self.allocator, &address);
        defer self.allocator.free(address_text);
        const topic_text = if (topic0) |t| try abi.hexAlloc(self.allocator, &t) else null;
        defer if (topic_text) |t| self.allocator.free(t);
        var topics: [1][]const u8 = undefined;
        if (topic_text) |t| topics[0] = t;
        var response = try self.call("eth_getLogs", .{.{ .fromBlock = from_text, .toBlock = to_text, .address = address_text, .topics = if (topic_text != null) topics[0..1] else topics[0..0] }});
        errdefer response.deinit();
        if (response.value() != .array) return error.InvalidRpcResult;
        for (response.value().array.items) |raw| {
            var log = try Log.parse(self.allocator, raw);
            defer log.deinit();
            if (log.block_number < from or log.block_number > to or !std.mem.eql(u8, &log.address, &address)) return error.LogOutsideFilter;
            if (topic0) |expected| {
                if (log.topic_count == 0 or !std.mem.eql(u8, &log.topics[0], &expected)) return error.LogOutsideFilter;
            }
        }
        return response;
    }

    /// Caller owns returned raw ABI bytes.
    pub fn ethCall(self: *RpcClient, address: Address, calldata: []const u8, block: BlockRef) ![]u8 {
        const to = try abi.hexAlloc(self.allocator, &address);
        defer self.allocator.free(to);
        const data = try abi.hexAlloc(self.allocator, calldata);
        defer self.allocator.free(data);
        const tag = try block.text(self.allocator);
        defer self.allocator.free(tag);
        var response = try self.call("eth_call", .{ .{ .to = to, .data = data }, tag });
        defer response.deinit();
        return decodeHexAlloc(self.allocator, try string(response.value()));
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
