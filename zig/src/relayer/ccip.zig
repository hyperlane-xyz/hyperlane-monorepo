//! Hyperlane CCIP-read: OffchainLookup revert decoding, request authentication,
//! and bounded retries driven by the owner scheduler's injected clock.
const std = @import("std");
const abi = @import("../evm/codecs.zig");
const protocol = @import("../protocol/root.zig");
const curl = @import("../net/curl.zig");
const Allocator = std.mem.Allocator;
pub const Address = [20]u8;
pub const Hash = [32]u8;
pub const max_response_bytes = 1024 * 1024;

pub const Lookup = struct {
    allocator: Allocator,
    encoded: []u8,
    sender: Address,
    urls: [][]const u8,
    call_data: []const u8,
    callback_function: [4]u8,
    extra_data: []const u8,

    pub fn deinit(self: *Lookup) void {
        self.allocator.free(self.urls);
        self.allocator.free(self.encoded);
        self.* = undefined;
    }
};

fn integer(bytes: []const u8, offset: usize) !usize {
    if (offset > bytes.len or bytes.len - offset < 32) return error.InvalidOffchainLookup;
    return abi.uintWord(usize, bytes[offset..][0..32]) catch error.InvalidOffchainLookup;
}

fn dynamic(bytes: []const u8, offset: usize) ![]const u8 {
    if (offset < 160 or offset % 32 != 0) return error.InvalidOffchainLookup;
    const length = try integer(bytes, offset);
    const start = offset + 32;
    if (length > bytes.len - start) return error.InvalidOffchainLookup;
    const padding = (32 - length % 32) % 32;
    if (padding > bytes.len - start - length or !std.mem.allEqual(u8, bytes[start + length ..][0..padding], 0)) return error.InvalidOffchainLookup;
    return bytes[start..][0..length];
}

/// Returned slices borrow an owned copy. A caller must additionally bind sender
/// to the queried ISM before allowing any offchain request or signing operation.
pub fn decode(allocator: Allocator, encoded: []const u8) !Lookup {
    if (encoded.len > max_response_bytes or encoded.len < 4 + 160 or (encoded.len - 4) % 32 != 0 or
        !std.mem.eql(u8, encoded[0..4], &abi.selector("OffchainLookup(address,string[],bytes,bytes4,bytes)"))) return error.InvalidOffchainLookup;
    const owned = try allocator.dupe(u8, encoded);
    errdefer allocator.free(owned);
    const bytes = owned[4..];
    const sender = try abi.addressWord(bytes[0..32]);
    if (!std.mem.allEqual(u8, bytes[100..128], 0)) return error.InvalidOffchainLookup;
    const urls_offset = try integer(bytes, 32);
    if (urls_offset < 160 or urls_offset % 32 != 0) return error.InvalidOffchainLookup;
    const count = try integer(bytes, urls_offset);
    if (count > 256 or count > (bytes.len - urls_offset - 32) / 32) return error.InvalidOffchainLookup;
    const urls_head = urls_offset + 32;
    const urls = try allocator.alloc([]const u8, count);
    errdefer allocator.free(urls);
    for (urls, 0..) |*url, i| {
        const offset = try integer(bytes, urls_head + 32 * i);
        if (offset < count * 32 or offset % 32 != 0 or offset > bytes.len - urls_head) return error.InvalidOffchainLookup;
        url.* = try dynamic(bytes, urls_head + offset);
        if (!std.unicode.utf8ValidateSlice(url.*)) return error.InvalidOffchainLookup;
    }
    return .{ .allocator = allocator, .encoded = owned, .sender = sender, .urls = urls, .call_data = try dynamic(bytes, try integer(bytes, 64)), .callback_function = bytes[96..100].*, .extra_data = try dynamic(bytes, try integer(bytes, 128)) };
}

pub fn requestHash(sender: Address, data: []const u8, url_template: []const u8) Hash {
    var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
    hasher.update("HYPERLANE_OFFCHAINLOOKUP");
    hasher.update(&sender);
    hasher.update(data);
    hasher.update(url_template);
    var result: Hash = undefined;
    hasher.final(&result);
    return result;
}

pub const Signer = struct {
    context: *anyopaque,
    address: Address,
    sign_digest: *const fn (*anyopaque, Hash, ?*const std.atomic.Value(bool)) anyerror![65]u8,
    retain_fn: ?*const fn (*anyopaque) void = null,
    release_fn: ?*const fn (*anyopaque) void = null,

    pub fn retain(self: Signer) !Signer {
        if ((self.retain_fn == null) != (self.release_fn == null)) return error.InvalidCcipSignerLifetime;
        if (self.retain_fn) |retain_| retain_(self.context);
        return self;
    }

    pub fn release(self: Signer) void {
        if (self.release_fn) |release_| release_(self.context);
    }
};

pub const SignerProvider = struct {
    context: *anyopaque,
    deadline_utc_ns: u64,
    bind_fn: *const fn (*anyopaque, ?*const std.atomic.Value(bool), u64) anyerror!?Signer,

    pub fn bind(self: SignerProvider, cancel: ?*const std.atomic.Value(bool)) !?Signer {
        const result = try self.bind_fn(self.context, cancel, self.deadline_utc_ns);
        if (result) |signer| if ((signer.retain_fn == null) != (signer.release_fn == null)) {
            if (signer.release_fn) |release_| release_(signer.context);
            return error.InvalidCcipSignerLifetime;
        };
        return result;
    }
};

pub const LookupSource = struct {
    context: *anyopaque,
    lookup_fn: *const fn (*anyopaque, Allocator, Address, protocol.Message, u64, ?*const std.atomic.Value(bool)) anyerror!Lookup,
};

pub fn nativeAddress(address: [32]u8) !Address {
    if (!std.mem.allEqual(u8, address[0..12], 0)) return error.InvalidNativeModuleAddress;
    return address[12..32].*;
}

pub const Handler = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, Address, protocol.Message) anyerror![]u8,
    fork_fn: ?*const fn (*anyopaque, Allocator, *@import("../evm/provider.zig").RpcClient, u64, *const std.atomic.Value(bool)) anyerror!Handler = null,
    native_fork_fn: ?*const fn (*anyopaque, Allocator, LookupSource, u64, *const std.atomic.Value(bool)) anyerror!Handler = null,
    deinit_fn: ?*const fn (*anyopaque) void = null,
    pub fn fork(self: Handler, a: Allocator, client: *@import("../evm/provider.zig").RpcClient, block_number: u64, cancel: *const std.atomic.Value(bool)) !Handler {
        const clone = self.fork_fn orelse return error.CcipHandlerForkUnsupported;
        return clone(self.context, a, client, block_number, cancel);
    }
    pub fn nativeFork(self: Handler, a: Allocator, source: LookupSource, block_number: u64, cancel: *const std.atomic.Value(bool)) !Handler {
        const clone = self.native_fork_fn orelse return error.CcipHandlerForkUnsupported;
        return clone(self.context, a, source, block_number, cancel);
    }
    pub fn deinit(self: *Handler) void {
        if (self.deinit_fn) |destroy| destroy(self.context);
        self.* = undefined;
    }
    pub fn fetch(self: Handler, ism: Address, message: protocol.Message) ![]u8 {
        return self.fetch_fn(self.context, ism, message);
    }
};

/// Stable, bounded signature entries; concurrent requests for the same digest
/// share both success and the in-flight failure. Different digests run in
/// parallel. Only successful signatures remain cached after their users leave.
pub const SignatureCache = struct {
    const Key = struct { signer: Address, hash: Hash };
    const Entry = struct {
        key: Key = undefined,
        state: enum { empty, pending, ready, failed } = .empty,
        signature: [65]u8 = undefined,
        failure: anyerror = error.SigningFailed,
        users: usize = 0,
        touched: u64 = 0,
    };
    allocator: Allocator,
    entries: []Entry,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    sequence: u64 = 0,

    pub fn init(allocator: Allocator, capacity: usize) !SignatureCache {
        if (capacity == 0 or capacity > 10000) return error.InvalidCacheCapacity;
        const entries = try allocator.alloc(Entry, capacity);
        @memset(entries, .{});
        return .{ .allocator = allocator, .entries = entries };
    }

    /// Every worker must be joined before deinit.
    pub fn deinit(self: *SignatureCache) void {
        self.allocator.free(self.entries);
        self.* = undefined;
    }

    fn release(entry: *Entry) void {
        entry.users -= 1;
        if (entry.users == 0 and entry.state == .failed) entry.state = .empty;
    }

    pub fn get(self: *SignatureCache, signer: Signer, hash: Hash, cancel: ?*const std.atomic.Value(bool)) ![65]u8 {
        const key: Key = .{ .signer = signer.address, .hash = hash };
        self.mutex.lock();
        self.sequence +|= 1;
        var candidate: ?*Entry = null;
        for (self.entries) |*entry| {
            if (entry.state != .empty and std.meta.eql(entry.key, key)) {
                entry.users += 1;
                entry.touched = self.sequence;
                while (entry.state == .pending) {
                    if (cancel) |flag| if (flag.load(.acquire)) {
                        release(entry);
                        self.mutex.unlock();
                        return error.RequestCancelled;
                    };
                    self.changed.timedWait(&self.mutex, 100 * std.time.ns_per_ms) catch {};
                }
                const failure = entry.failure;
                const failed = entry.state == .failed;
                const signature: [65]u8 = if (failed) @splat(0) else entry.signature;
                release(entry);
                self.mutex.unlock();
                if (failed) return failure;
                return signature;
            }
            if (entry.users == 0 and entry.state != .pending and (candidate == null or entry.state == .empty or entry.touched < candidate.?.touched)) candidate = entry;
        }
        const entry = candidate orelse {
            self.mutex.unlock();
            return error.SignatureCacheBusy;
        };
        entry.* = .{ .key = key, .state = .pending, .users = 1, .touched = self.sequence };
        self.mutex.unlock();
        const digest = @import("../protocol/checkpoint.zig").ethSignedMessageHash(hash);
        const result: anyerror![65]u8 = blk: {
            if (cancel) |flag| if (flag.load(.acquire)) break :blk error.RequestCancelled;
            const signature = signer.sign_digest(signer.context, digest, cancel) catch |err| break :blk err;
            const recovered = protocol.signature.recover(digest, signature) catch |err| break :blk err;
            if (!std.mem.eql(u8, &recovered, &signer.address)) break :blk error.WrongAuthenticationSigner;
            break :blk signature;
        };
        self.mutex.lock();
        if (result) |signature| {
            entry.signature = signature;
            entry.state = .ready;
        } else |err| {
            entry.failure = err;
            entry.state = .failed;
        }
        release(entry);
        self.changed.broadcast();
        self.mutex.unlock();
        return result;
    }
};

pub const PreparedRequest = struct {
    allocator: Allocator,
    url: []u8,
    body: ?[]u8,
    request: curl.Request,
    provider_signer: ?Signer = null,
    pub fn deinit(self: *PreparedRequest) void {
        if (self.provider_signer) |signer| signer.release();
        self.allocator.free(self.url);
        if (self.body) |body| self.allocator.free(body);
        self.* = undefined;
    }
};

pub const AsyncTransport = struct {
    context: *anyopaque,
    has_active_fn: *const fn (*anyopaque) bool,
    submit_fn: *const fn (*anyopaque, curl.Request) anyerror!void,
    poll_fn: *const fn (*anyopaque) anyerror!?curl.Response,
    cancel_fn: *const fn (*anyopaque) void,
};

pub fn prepare(allocator: Allocator, lookup: Lookup, template: []const u8, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, cancel: ?*const std.atomic.Value(bool)) !PreparedRequest {
    return prepareLazy(allocator, lookup, template, origin_tx_hash, cache, signer, null, cancel);
}

pub fn prepareLazy(allocator: Allocator, lookup: Lookup, template: []const u8, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, provider: ?SignerProvider, cancel: ?*const std.atomic.Value(bool)) !PreparedRequest {
    const sender = try abi.hexAlloc(allocator, &lookup.sender);
    defer allocator.free(sender);
    const data = try abi.hexAlloc(allocator, lookup.call_data);
    defer allocator.free(data);
    const with_sender = try std.mem.replaceOwned(u8, allocator, template, "{sender}", sender);
    defer allocator.free(with_sender);
    const url = try std.mem.replaceOwned(u8, allocator, with_sender, "{data}", data);
    errdefer allocator.free(url);
    const get = std.mem.indexOf(u8, template, "{data}") != null;
    var request: curl.Request = .{ .url = url, .method = if (get) .get else .post, .public_only = true, .max_response_bytes = max_response_bytes, .timeout_ms = 30000, .connect_timeout_ms = 30000, .cancel = cancel };
    // Syntactic/literal egress rejection precedes any KMS callback. The native
    // transport additionally validates every actual socket destination.
    try curl.validateRequest(request);
    var provider_signer: ?Signer = null;
    errdefer if (provider_signer) |value| value.release();
    var body: ?[]u8 = null;
    if (!get) {
        if (signer == null and provider != null) provider_signer = try provider.?.bind(cancel);
        const effective_signer = signer orelse provider_signer;
        const signature = if (effective_signer) |value| try (cache orelse return error.SignatureCacheRequired).get(value, requestHash(lookup.sender, lookup.call_data, template), cancel) else null;
        var signature_hex: [132]u8 = undefined;
        const signature_text = if (signature) |bytes| text: {
            signature_hex[0..2].* = "0x".*;
            signature_hex[2..132].* = std.fmt.bytesToHex(bytes, .lower);
            break :text signature_hex[0..132];
        } else null;
        body = try std.json.Stringify.valueAlloc(allocator, .{ .data = data, .sender = sender, .signature = signature_text, .origin_tx_hash = origin_tx_hash }, .{});
        request.body = body;
        request.headers = &.{.{ .name = "content-type", .value = "application/json" }};
    }
    return .{ .allocator = allocator, .url = url, .body = body, .request = request, .provider_signer = provider_signer };
}

pub const Response = union(enum) { ready: []u8, pending };
pub fn decodeResponse(allocator: Allocator, status: u16, body: []const u8) !Response {
    if (body.len > max_response_bytes) return error.ResponseTooLarge;
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{ .duplicate_field_behavior = .@"error" });
    defer parsed.deinit();
    const value = parsed.value;
    if (value != .object) return error.InvalidOffchainResponse;
    if (value.object.get("status")) |v| if (v == .string and std.ascii.eqlIgnoreCase(v.string, "pending")) return .pending;
    if (value.object.get("error")) |v| if (v == .string) {
        const lower = try std.ascii.allocLowerString(allocator, v.string);
        defer allocator.free(lower);
        if (std.mem.indexOf(u8, lower, "pending") != null or std.mem.eql(u8, lower, "cctp attestation not found")) return .pending;
    };
    if (status == 404) return error.OffchainNotFound;
    const data = value.object.get("data") orelse return error.InvalidOffchainResponse;
    if (data != .string or data.string.len < 2 or data.string.len % 2 != 0 or !std.mem.startsWith(u8, data.string, "0x")) return error.InvalidOffchainResponse;
    const result = try allocator.alloc(u8, (data.string.len - 2) / 2);
    errdefer allocator.free(result);
    _ = try abi.decodeHex(result, data.string);
    return .{ .ready = result };
}

/// Scheduler state only; no thread sleep, endpoint URL or signed request is
/// persisted. A pending server gets ten one-second retries before the next URL.
pub const Attempt = struct {
    url_index: usize = 0,
    pending_retries: u8 = 0,
    ready_at_ms: u64 = 0,
    done: bool = false,
    pub fn hardFailure(self: *Attempt) void {
        self.url_index += 1;
        self.pending_retries = 0;
        self.ready_at_ms = 0;
    }
    pub fn pending(self: *Attempt, now_ms: u64) void {
        if (self.pending_retries >= 10) return self.hardFailure();
        self.pending_retries += 1;
        self.ready_at_ms = now_ms +| 1000;
    }
    pub fn available(self: Attempt, now_ms: u64, urls_len: usize) bool {
        return !self.done and self.url_index < urls_len and now_ms >= self.ready_at_ms;
    }
};

pub const Step = union(enum) { ready: []u8, retry_at_ms: u64, exhausted };
pub const Session = struct {
    lookup: Lookup,
    ism: Address,
    message_id: Hash,
    attempt: Attempt = .{},

    pub fn init(lookup: Lookup, ism: Address, message_id: Hash) !Session {
        if (!std.mem.eql(u8, &lookup.sender, &ism)) return error.OffchainSenderMismatch;
        return .{ .lookup = lookup, .ism = ism, .message_id = message_id };
    }

    pub fn deinit(self: *Session) void {
        self.lookup.deinit();
        self.* = undefined;
    }

    /// One HTTP attempt per call. Caller schedules retry_at_ms on its owner
    /// loop and supplies cancellation to both network and signing workers.
    pub fn step(self: *Session, allocator: Allocator, native: *curl.Client, now_ms: u64, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, cancel: ?*const std.atomic.Value(bool)) !Step {
        return self.stepLazy(allocator, native, now_ms, origin_tx_hash, cache, signer, null, cancel);
    }

    pub fn stepLazy(self: *Session, allocator: Allocator, native: *curl.Client, now_ms: u64, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, provider: ?SignerProvider, cancel: ?*const std.atomic.Value(bool)) !Step {
        if (self.attempt.done or self.attempt.url_index >= self.lookup.urls.len) return .exhausted;
        if (!self.attempt.available(now_ms, self.lookup.urls.len)) return .{ .retry_at_ms = self.attempt.ready_at_ms };
        var request = prepareLazy(allocator, self.lookup, self.lookup.urls[self.attempt.url_index], origin_tx_hash, cache, signer, provider, cancel) catch |err| {
            if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
            self.attempt.hardFailure();
            return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
        };
        defer request.deinit();
        var response = native.send(allocator, request.request) catch |err| {
            if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
            self.attempt.hardFailure();
            return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
        };
        defer response.deinit();
        const outcome = decodeResponse(allocator, response.status, response.body) catch |err| {
            if (err == error.OutOfMemory) return err;
            self.attempt.hardFailure();
            return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
        };
        return switch (outcome) {
            .ready => |bytes| ready: {
                self.attempt.done = true;
                break :ready .{ .ready = bytes };
            },
            .pending => pending: {
                self.attempt.pending(now_ms);
                break :pending if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = self.attempt.ready_at_ms };
            },
        };
    }

    /// Submit once, then poll the retained native attempt. Pending polls never
    /// rebuild signed input or advance URL/retry state.
    pub fn stepAsync(self: *Session, allocator: Allocator, transport: AsyncTransport, now_ms: u64, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, cancel: ?*const std.atomic.Value(bool)) !Step {
        return self.stepAsyncLazy(allocator, transport, now_ms, origin_tx_hash, cache, signer, null, cancel);
    }

    pub fn stepAsyncLazy(self: *Session, allocator: Allocator, transport: AsyncTransport, now_ms: u64, origin_tx_hash: ?[]const u8, cache: ?*SignatureCache, signer: ?Signer, provider: ?SignerProvider, cancel: ?*const std.atomic.Value(bool)) !Step {
        if (self.attempt.done or self.attempt.url_index >= self.lookup.urls.len) return .exhausted;
        if (cancel) |flag| if (flag.load(.acquire)) {
            if (transport.has_active_fn(transport.context)) transport.cancel_fn(transport.context);
            return error.RequestCancelled;
        };
        if (!transport.has_active_fn(transport.context)) {
            if (!self.attempt.available(now_ms, self.lookup.urls.len)) return .{ .retry_at_ms = self.attempt.ready_at_ms };
            var request = prepareLazy(allocator, self.lookup, self.lookup.urls[self.attempt.url_index], origin_tx_hash, cache, signer, provider, cancel) catch |err| {
                if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
                self.attempt.hardFailure();
                return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
            };
            defer request.deinit();
            transport.submit_fn(transport.context, request.request) catch |err| {
                if (err == error.OutOfMemory or err == error.RequestCancelled or err == error.PendingReadIo or err == error.CcipSessionMemoryLimit) return err;
                if (err == error.HttpRuntimeSessionsFull or err == error.HttpRuntimeByteBudgetExceeded) return error.PendingReadIo;
                self.attempt.hardFailure();
                return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
            };
            return error.PendingReadIo;
        }
        var response = transport.poll_fn(transport.context) catch |err| {
            if (err == error.OutOfMemory or err == error.RequestCancelled or err == error.PendingReadIo) return err;
            self.attempt.hardFailure();
            return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
        } orelse return error.PendingReadIo;
        defer response.deinit();
        const outcome = decodeResponse(allocator, response.status, response.body) catch |err| {
            if (err == error.OutOfMemory) return err;
            self.attempt.hardFailure();
            return if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = now_ms };
        };
        return switch (outcome) {
            .ready => |bytes| ready: {
                self.attempt.done = true;
                break :ready .{ .ready = bytes };
            },
            .pending => pending: {
                self.attempt.pending(now_ms);
                break :pending if (self.attempt.url_index == self.lookup.urls.len) .exhausted else .{ .retry_at_ms = self.attempt.ready_at_ms };
            },
        };
    }
};

test "CCIP authentication hash matches production Rust and TypeScript fixture" {
    const expected = [_]u8{ 0x8f, 0xd3, 0x0d, 0x2b, 0x31, 0x8f, 0x7c, 0x31, 0xcc, 0x29, 0xcd, 0x3b, 0x14, 0xf5, 0xfe, 0x89, 0x13, 0x4a, 0x4f, 0x3b, 0x1c, 0xd6, 0x29, 0x56, 0x7d, 0xbb, 0x77, 0x84, 0x64, 0x63, 0xc9, 0x2b };
    try std.testing.expectEqualSlices(u8, &expected, &requestHash(@splat(3), &@as([32]u8, @splat(0x11)), "https://ccs.example/callCommitments/calldata"));
}

test "CCIP response pending shapes retry boundedly and bare404 fails immediately" {
    const allocator = std.testing.allocator;
    for ([_][]const u8{ "{\"status\":\"PeNdInG\"}", "{\"error\":\"still pending attestation\"}", "{\"error\":\"CCTP attestation not found\"}" }) |body| {
        try std.testing.expectEqual(.pending, try decodeResponse(allocator, 404, body));
        try std.testing.expectEqual(.pending, try decodeResponse(allocator, 200, body));
    }
    try std.testing.expectError(error.OffchainNotFound, decodeResponse(allocator, 404, "{\"data\":\"0x11\"}"));
    try std.testing.expectError(error.InvalidOffchainResponse, decodeResponse(allocator, 200, "{\"data\":\"11\"}"));
    try std.testing.expectError(error.InvalidOffchainResponse, decodeResponse(allocator, 200, "{\"data\":\"0x1\"}"));
    const ready = try decodeResponse(allocator, 500, "{\"data\":\"0x00ff\"}");
    defer allocator.free(ready.ready);
    try std.testing.expectEqualSlices(u8, &.{ 0, 255 }, ready.ready);
    var attempt: Attempt = .{};
    for (0..10) |i| {
        const now: u64 = @intCast(i * 1000);
        try std.testing.expect(attempt.available(now, 2));
        attempt.pending(now);
        try std.testing.expect(!attempt.available(now + 999, 2));
    }
    attempt.pending(10000);
    try std.testing.expectEqual(@as(usize, 1), attempt.url_index);
    try std.testing.expectEqual(@as(u8, 0), attempt.pending_retries);
    attempt.hardFailure();
    try std.testing.expect(!attempt.available(10000, 2));
}

fn fixture(allocator: Allocator) !Lookup {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, @embedFile("testing/ccip-lookup.json"), .{});
    defer parsed.deinit();
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(allocator);
    for (parsed.value.object.get("chunks").?.array.items) |chunk| try text.appendSlice(allocator, chunk.string);
    const bytes = try allocator.alloc(u8, (text.items.len - 2) / 2);
    defer allocator.free(bytes);
    _ = try abi.decodeHex(bytes, text.items);
    return decode(allocator, bytes);
}

test "CCIP OffchainLookup matches independent Foundry ABI and bounds every truncation" {
    const allocator = std.testing.allocator;
    var lookup = try fixture(allocator);
    defer lookup.deinit();
    try std.testing.expectEqualSlices(u8, &@as(Address, @splat(3)), &lookup.sender);
    try std.testing.expectEqualStrings("https://ccs.example/{sender}/{data}", lookup.urls[0]);
    try std.testing.expectEqualStrings("https://ccs.example/lookup", lookup.urls[1]);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0x11, 0xff }, lookup.call_data);
    try std.testing.expectEqualSlices(u8, &.{ 0x12, 0x34, 0x56, 0x78 }, &lookup.callback_function);
    try std.testing.expectEqualSlices(u8, &.{ 0xaa, 0xbb }, lookup.extra_data);
    for (0..lookup.encoded.len) |end| {
        if (decode(allocator, lookup.encoded[0..end])) |value| {
            var unexpected = value;
            unexpected.deinit();
            return error.AcceptedTruncatedLookup;
        } else |_| {}
    }
    const original = lookup.encoded[4 + 32 ..][0..32].*;
    @memset(lookup.encoded[4 + 32 ..][0..32], 255);
    try std.testing.expectError(error.InvalidOffchainLookup, decode(allocator, lookup.encoded));
    lookup.encoded[4 + 32 ..][0..32].* = original;
}

const TestSigner = struct {
    key: Hash = @splat(0x11),
    calls: usize = 0,
    pub fn interface(self: *TestSigner) !Signer {
        return .{ .context = self, .address = try protocol.signature.secretKeyAddress(self.key), .sign_digest = sign };
    }
    fn sign(context: *anyopaque, digest: Hash, _: ?*const std.atomic.Value(bool)) ![65]u8 {
        const self: *TestSigner = @ptrCast(@alignCast(context));
        self.calls += 1;
        return protocol.signature.signDigest(self.key, digest, null);
    }
};

test "CCIP GET skips signer POST caches verified signature and invalid URL never signs" {
    const allocator = std.testing.allocator;
    var lookup = try fixture(allocator);
    defer lookup.deinit();
    var signer: TestSigner = .{};
    var cache = try SignatureCache.init(allocator, 2);
    defer cache.deinit();
    var get = try prepare(allocator, lookup, lookup.urls[0], null, &cache, try signer.interface(), null);
    defer get.deinit();
    try std.testing.expectEqual(.get, get.request.method);
    try std.testing.expectEqual(@as(?[]u8, null), get.body);
    try std.testing.expectEqual(@as(usize, 0), signer.calls);
    try std.testing.expect(std.mem.endsWith(u8, get.url, "/0x0011ff"));
    for (0..2) |_| {
        var post = try prepare(allocator, lookup, lookup.urls[1], "0xaabb", &cache, try signer.interface(), null);
        defer post.deinit();
        try std.testing.expectEqual(.post, post.request.method);
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, post.body.?, .{});
        defer parsed.deinit();
        const signature_hex = parsed.value.object.get("signature").?.string;
        var signature: [65]u8 = undefined;
        _ = try abi.decodeHex(&signature, signature_hex);
        const digest = @import("../protocol/checkpoint.zig").ethSignedMessageHash(requestHash(lookup.sender, lookup.call_data, lookup.urls[1]));
        try std.testing.expectEqualSlices(u8, &(try signer.interface()).address, &try protocol.signature.recover(digest, signature));
        try std.testing.expectEqualStrings("0xaabb", parsed.value.object.get("origin_tx_hash").?.string);
    }
    try std.testing.expectEqual(@as(usize, 1), signer.calls);
    for ([_][]const u8{ "http://169.254.169.254/", "file:///etc/passwd", "https://user:pass@example.com/" }) |url|
        try std.testing.expectError(if (std.mem.startsWith(u8, url, "http://")) error.NonPublicDestination else error.InvalidHttpUrl, prepare(allocator, lookup, url, null, &cache, try signer.interface(), null));
    try std.testing.expectEqual(@as(usize, 1), signer.calls);
}

const ConcurrentSigner = struct {
    mutex: std.Thread.Mutex = .{},
    condition: std.Thread.Condition = .{},
    gate: bool = false,
    fail: bool = false,
    calls: std.atomic.Value(usize) = .init(0),
    cache: *SignatureCache,
    signer: Signer = undefined,
    successes: std.atomic.Value(usize) = .init(0),
    failures: std.atomic.Value(usize) = .init(0),

    fn sign(context: *anyopaque, digest: Hash, _: ?*const std.atomic.Value(bool)) ![65]u8 {
        const self: *ConcurrentSigner = @ptrCast(@alignCast(context));
        _ = self.calls.fetchAdd(1, .acq_rel);
        self.mutex.lock();
        while (!self.gate) self.condition.wait(&self.mutex);
        self.mutex.unlock();
        if (self.fail) return error.MockKmsUnavailable;
        return protocol.signature.signDigest(@splat(0x11), digest, null);
    }

    fn run(self: *ConcurrentSigner) void {
        _ = self.cache.get(self.signer, @splat(2), null) catch {
            _ = self.failures.fetchAdd(1, .acq_rel);
            return;
        };
        _ = self.successes.fetchAdd(1, .acq_rel);
    }
};

test "CCIP concurrent equal hashes coalesce KMS success and in-flight failure" {
    for ([_]bool{ false, true }) |fail| {
        var cache = try SignatureCache.init(std.testing.allocator, 2);
        defer cache.deinit();
        var state: ConcurrentSigner = .{ .cache = &cache, .fail = fail };
        state.signer = .{ .context = &state, .address = try protocol.signature.secretKeyAddress(@splat(0x11)), .sign_digest = ConcurrentSigner.sign };
        var threads: [4]std.Thread = undefined;
        var started: usize = 0;
        defer {
            state.mutex.lock();
            state.gate = true;
            state.condition.broadcast();
            state.mutex.unlock();
            for (threads[0..started]) |thread| thread.join();
        }
        for (&threads) |*thread| {
            thread.* = try std.Thread.spawn(.{}, ConcurrentSigner.run, .{&state});
            started += 1;
        }
        var timer = try std.time.Timer.start();
        var coalesced = false;
        while (timer.read() < 5 * std.time.ns_per_s) {
            cache.mutex.lock();
            for (cache.entries) |entry| if (entry.state == .pending and entry.users == threads.len) {
                coalesced = true;
            };
            cache.mutex.unlock();
            if (coalesced) break;
            std.Thread.yield() catch {};
        }
        try std.testing.expect(coalesced);
        state.mutex.lock();
        state.gate = true;
        state.condition.broadcast();
        state.mutex.unlock();
        for (threads) |thread| thread.join();
        started = 0;
        try std.testing.expectEqual(@as(usize, 1), state.calls.load(.acquire));
        try std.testing.expectEqual(@as(usize, if (fail) 4 else 0), state.failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, if (fail) 0 else 4), state.successes.load(.acquire));
        if (fail) {
            try std.testing.expectError(error.MockKmsUnavailable, cache.get(state.signer, @splat(2), null));
            try std.testing.expectEqual(@as(usize, 2), state.calls.load(.acquire));
        } else {
            _ = try cache.get(state.signer, @splat(2), null);
            try std.testing.expectEqual(@as(usize, 1), state.calls.load(.acquire));
        }
    }
}
