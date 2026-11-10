//! Source-accurate relayer administrative HTTP API.
//!
//! Route availability mirrors Rust's conditional router: absent owner callbacks
//! mean the route is not installed. Network-capable callbacks execute only on
//! the parent HTTP worker pool and receive its stable cancellation token.
const std = @import("std");
const http = @import("../http.zig");
const json = @import("json.zig");
const query = @import("query.zig");
const settings = @import("../../settings/types.zig");
const protocol = @import("../../protocol/root.zig");
const relay_policy = @import("../../agents/relay_policy.zig");
const regex = @import("../regex.zig");
const matching = @import("../matching.zig");
const runtime_denylist = @import("../runtime_denylist.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);

pub const MessageInput = struct {
    message: protocol.Message,
    supplied_id: ?json.Hash = null,
    supplied_id_text: ?[]const u8 = null,
    dispatched_block_number: u64,
};
pub const MessageList = struct { messages: []protocol.Message = &.{} };

pub const MessageDb = struct {
    context: *anyopaque,
    contains_fn: *const fn (context: *anyopaque, domain: u32) bool,
    list_fn: *const fn (context: *anyopaque, allocator: A, domain: u32, nonce_start: u32, nonce_end: u32, cancel: Cancel) anyerror!MessageList,
    insert_fn: *const fn (context: *anyopaque, message: MessageInput, cancel: Cancel) anyerror!void,
    by_id_fn: *const fn (context: *anyopaque, allocator: A, domain: u32, id: json.Hash, cancel: Cancel) anyerror!?protocol.Message,
};

pub const MerkleInput = struct {
    chain: u32,
    insertion_block_number: u64,
    leaf_index: u32,
    message_id: json.Hash,
};
pub const MerkleInsertion = struct { insertion_block_number: ?u64, leaf_index: u32, message_id: json.Hash };
pub const MerkleList = struct { insertions: []MerkleInsertion = &.{} };
pub const MerkleDb = struct {
    context: *anyopaque,
    contains_chain: *const fn (context: *anyopaque, chain: u32) bool,
    list_fn: *const fn (context: *anyopaque, allocator: A, domain: u32, start: u32, end: u32, cancel: Cancel) anyerror!MerkleList,
    insert_fn: *const fn (context: *anyopaque, insertion: MerkleInput, cancel: Cancel) anyerror!void,
};

pub const ProofDb = struct {
    context: *anyopaque,
    contains_fn: *const fn (context: *anyopaque, domain: u32) bool,
    proof_fn: *const fn (context: *anyopaque, domain: u32, leaf_index: u32, root_index: u32, cancel: Cancel) anyerror!protocol.Proof,
};

pub const QueueOwner = struct {
    context: *anyopaque,
    /// Response owns its allocator and complete source-sorted queue JSON. Its
    /// allocator context must survive response.deinit (joined by HTTP stop).
    render_fn: *const fn (context: *anyopaque, allocator: A, destination_domain: u32, cancel: Cancel) anyerror!http.Response,
};

pub const RetryResult = struct { evaluated: usize = 0, matched: u64 = 0, failed: u64 = 0 };
pub const RetryOwner = struct {
    context: *anyopaque,
    /// Broadcasts synchronously to every queue actor, waits for all responses,
    /// and returns real persistence failures. The matching list is request-scoped.
    retry_fn: *const fn (context: *anyopaque, allocator: A, uuid: []const u8, pattern: settings.MatchingList, cancel: Cancel) anyerror!RetryResult,
};

pub const CachedSigners = struct {
    context: *anyopaque,
    /// Returns request-scoped cached origin transaction signers. An empty slice is
    /// a cache miss, matching Rust.
    lookup_fn: *const fn (context: *anyopaque, allocator: A, message_id: json.Hash, cancel: Cancel) anyerror![]const json.Hash,
};

pub const ReprocessOwner = struct {
    context: *anyopaque,
    /// Creates and enqueues the manual retry only after all policy gates pass.
    /// Returns Rust's `PendingMessage { ... }` Debug representation, request-scoped.
    enqueue_fn: *const fn (context: *anyopaque, allocator: A, message: protocol.Message, cancel: Cancel) anyerror![]u8,
};

pub const GasRule = struct { policy: json.GasPolicy, matching_list: settings.MatchingList };
pub const GasDomainRules = struct { domain: []const u8, rules: []GasRule };
pub const GasOwner = struct {
    context: *anyopaque,
    add_fn: *const fn (context: *anyopaque, allocator: A, rule: GasRule, cancel: Cancel) anyerror!void,
    list_fn: *const fn (context: *anyopaque, allocator: A, cancel: Cancel) anyerror![]GasDomainRules,
    remove_fn: *const fn (context: *anyopaque, index: usize, cancel: Cancel) anyerror!void,
};

pub const NonceOwner = struct {
    context: *anyopaque,
    contains_fn: *const fn (context: *anyopaque, domain: u32) bool,
    overwrite_fn: *const fn (context: *anyopaque, domain: u32, nonce: ?u64, cancel: Cancel) anyerror!void,
};

pub const EnvironmentValue = union(enum) { absent, value: []const u8 };
pub const EnvironmentOwner = struct {
    context: *anyopaque,
    get_fn: *const fn (context: *anyopaque, allocator: A, name: []const u8, cancel: Cancel) anyerror!EnvironmentValue,
    set_fn: *const fn (context: *anyopaque, allocator: A, name: []const u8, value: ?[]const u8, cancel: Cancel) anyerror!EnvironmentValue,
};

pub const DenylistRefreshBinder = struct {
    context: *anyopaque,
    bind_fn: *const fn (context: *anyopaque, cancel: Cancel) anyerror!void,
    unbind_fn: *const fn (context: *anyopaque, cancel: Cancel) void,
};

pub const Admin = struct {
    messages: ?MessageDb = null,
    merkle: ?MerkleDb = null,
    proofs: ?ProofDb = null,
    queue: ?QueueOwner = null,
    retry: ?RetryOwner = null,
    policy: ?*relay_policy.Policy = null,
    regex_engine: ?*regex.Engine = null,
    origin_signers: ?CachedSigners = null,
    reprocess: ?ReprocessOwner = null,
    gas: ?GasOwner = null,
    denylist: ?*runtime_denylist.RuntimeDenylist = null,
    /// Rust's denylist Clock is injected; manual refresh uses this same callback.
    denylist_clock: ?runtime_denylist.Clock = null,
    /// Mandatory for manual refresh: binds the HTTP cancel token to actual I/O.
    denylist_refresh: ?DenylistRefreshBinder = null,
    nonce: ?NonceOwner = null,
    /// Must be set only when the process toggle was exactly "true".
    environment: ?EnvironmentOwner = null,

    pub fn handler(self: *Admin) http.Handler {
        return .{ .context = self, .handle_fn = respond };
    }
};

fn respond(context: *anyopaque, a: A, request: http.Request, cancel: Cancel) anyerror!http.Response {
    if (cancel.load(.acquire)) return error.Cancelled;
    const self: *Admin = @ptrCast(@alignCast(context));
    const path = request.path;

    if (std.mem.eql(u8, path, "/messages")) {
        if (self.messages == null) return notFound(a);
        if (std.mem.eql(u8, request.method, "GET")) return listMessages(self, a, request, cancel);
        if (std.mem.eql(u8, request.method, "POST")) return insertMessages(self, a, request, cancel);
        return methodNotAllowed(a, "GET,POST");
    }
    if (std.mem.eql(u8, path, "/merkle_tree_insertions")) {
        if (self.merkle == null) return notFound(a);
        if (std.mem.eql(u8, request.method, "GET")) return listMerkle(self, a, request, cancel);
        if (std.mem.eql(u8, request.method, "POST")) return insertMerkle(self, a, request, cancel);
        return methodNotAllowed(a, "GET,POST");
    }
    if (std.mem.eql(u8, path, "/list_operations")) {
        if (self.queue == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "GET")) return methodNotAllowed(a, "GET");
        return listOperations(self, a, request, cancel);
    }
    if (std.mem.eql(u8, path, "/message_retry")) {
        if (self.retry == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "POST")) return methodNotAllowed(a, "POST");
        return messageRetry(self, a, request, cancel);
    }
    if (std.mem.eql(u8, path, "/reprocess_message")) {
        if (self.reprocess == null or self.messages == null or self.policy == null or self.origin_signers == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "POST")) return methodNotAllowed(a, "POST");
        return reprocessMessage(self, a, request, cancel);
    }
    if (std.mem.eql(u8, path, "/igp_rules")) {
        if (self.gas == null) return notFound(a);
        if (std.mem.eql(u8, request.method, "GET")) return listGasRules(self, a, cancel);
        if (std.mem.eql(u8, request.method, "POST")) return addGasRule(self, a, request, cancel);
        return methodNotAllowed(a, "GET,POST");
    }
    if (std.mem.startsWith(u8, path, "/igp_rules/")) {
        if (self.gas == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "DELETE")) return methodNotAllowed(a, "DELETE");
        return removeGasRule(self, a, path["/igp_rules/".len..], cancel);
    }
    if (std.mem.eql(u8, path, "/merkle_proofs")) {
        if (self.proofs == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "GET")) return methodNotAllowed(a, "GET");
        return merkleProof(self, a, request, cancel);
    }
    if (std.mem.eql(u8, path, "/runtime_denylist")) {
        if (self.denylist == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "GET")) return methodNotAllowed(a, "GET");
        return denylistSummary(a, self.denylist.?);
    }
    if (std.mem.eql(u8, path, "/runtime_denylist/refresh")) {
        if (self.denylist == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "POST")) return methodNotAllowed(a, "POST");
        const clock = self.denylist_clock orelse return plain(a, 502, "Runtime denylist refresh failed; see relayer logs", null);
        const binder = self.denylist_refresh orelse return plain(a, 502, "Runtime denylist refresh failed; see relayer logs", null);
        return denylistRefresh(a, self.denylist.?, clock, binder, cancel);
    }
    if (std.mem.eql(u8, path, "/evm/overwrite_upper_nonce")) {
        if (self.nonce == null) return notFound(a);
        if (!std.mem.eql(u8, request.method, "POST")) return methodNotAllowed(a, "POST");
        return overwriteNonce(self, a, request, cancel);
    }
    if (std.mem.eql(u8, path, "/environment_variable")) {
        if (self.environment == null) return notFound(a);
        if (std.mem.eql(u8, request.method, "GET")) return environmentVariable(self, a, request, cancel, true);
        if (std.mem.eql(u8, request.method, "POST")) return environmentVariable(self, a, request, cancel, false);
        return methodNotAllowed(a, "GET,POST");
    }
    return notFound(a);
}

fn listMessages(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var params = query.parse(a, request.query orelse "") catch return queryRejection(a);
    defer params.deinit();
    const domain = query.unsigned(params.get("domain_id") orelse "", u32) catch return queryRejection(a);
    const start = query.unsigned(params.get("nonce_start") orelse "", u32) catch return queryRejection(a);
    const end = query.unsigned(params.get("nonce_end") orelse "", u32) catch return queryRejection(a);
    if (end <= start) return adminError(a, 400, "nonce_end less than nonce_start");
    const owner = self.messages.?;
    if (!owner.contains_fn(owner.context, domain)) return adminError(a, 404, "No db found for chain");
    const found = owner.list_fn(owner.context, arena.allocator(), domain, start, end, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to fetch message");
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"messages\":[") catch |err| return allocationOnly(err);
    for (found.messages, 0..) |message, index| {
        if (index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        out.writer.writeAll("{\"message_id\":\"") catch |err| return allocationOnly(err);
        json.writeUnprefixedHash(&out.writer, message.id()) catch |err| return allocationOnly(err);
        out.writer.writeAll("\",\"message\":") catch |err| return allocationOnly(err);
        json.writeMessage(&out.writer, message) catch |err| return allocationOnly(err);
        out.writer.writeByte('}') catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("]}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn insertMessages(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const array = value.object.get("messages") orelse return dataRejection(a);
    if (array != .array) return dataRejection(a);
    const inputs = try arena.allocator().alloc(MessageInput, array.array.items.len);
    for (array.array.items, inputs) |item, *input| {
        if (item != .object) return dataRejection(a);
        const object = item.object;
        const supplied = object.get("message_id");
        input.* = .{
            .message = json.parseMessage(object.get("message") orelse return dataRejection(a), arena.allocator()) catch return dataRejection(a),
            .supplied_id_text = if (supplied) |id| switch (id) {
                .null => null,
                .string => |text| text,
                else => return dataRejection(a),
            } else null,
            .dispatched_block_number = parseUnsignedField(object.get("dispatched_block_number"), u64) catch return dataRejection(a),
        };
    }
    const owner = self.messages.?;
    var inserted: u64 = 0;
    var skipped = std.array_list.Managed(MessageInput).init(a);
    defer skipped.deinit();
    for (inputs) |*input| {
        if (input.supplied_id_text) |text| {
            input.supplied_id = json.parseHash(text) catch return adminError(a, 400, "Failed to parse message_id");
            if (!std.mem.eql(u8, &input.supplied_id.?, &input.message.id())) return adminError(a, 400, "Provided message does not match provided message_id");
        }
        if (!owner.contains_fn(owner.context, input.message.origin)) {
            try skipped.append(input.*);
            continue;
        }
        owner.insert_fn(owner.context, input.*, cancel) catch |err| {
            if (err == error.OutOfMemory) return err;
            return adminError(a, 500, "Failed to upsert message");
        };
        inserted +%= 1;
    }
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"count\":") catch |err| return allocationOnly(err);
    out.writer.print("{d}", .{inserted}) catch |err| return allocationOnly(err);
    out.writer.writeAll(",\"skipped\":[") catch |err| return allocationOnly(err);
    for (skipped.items, 0..) |input, position| {
        if (position != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        writeMessageInput(&out.writer, input) catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("]}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn writeMessageInput(w: *std.Io.Writer, input: MessageInput) !void {
    try w.writeAll("{\"message\":");
    try json.writeMessage(w, input.message);
    try w.writeAll(",\"message_id\":");
    if (input.supplied_id) |id| {
        try w.writeByte('"');
        try json.writePrefixedHash(w, id);
        try w.writeByte('"');
    } else try w.writeAll("null");
    try w.writeAll(",\"dispatched_block_number\":");
    try w.print("{d}}}", .{input.dispatched_block_number});
}

fn listMerkle(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var params = query.parse(a, request.query orelse "") catch return queryRejection(a);
    defer params.deinit();
    const domain = query.unsigned(params.get("domain_id") orelse "", u32) catch return queryRejection(a);
    const start = query.unsigned(params.get("leaf_index_start") orelse "", u32) catch return queryRejection(a);
    const end = query.unsigned(params.get("leaf_index_end") orelse "", u32) catch return queryRejection(a);
    if (end <= start) return adminError(a, 400, "leaf_index_end less than leaf_index_start");
    const owner = self.merkle.?;
    if (!owner.contains_chain(owner.context, domain)) return adminError(a, 404, "No db found for chain");
    const found = owner.list_fn(owner.context, arena.allocator(), domain, start, end, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to fetch merkle tree insertion");
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"merkle_tree_insertions\":[") catch |err| return allocationOnly(err);
    for (found.insertions, 0..) |item, index| {
        if (index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        out.writer.writeAll("{\"insertion_block_number\":") catch |err| return allocationOnly(err);
        if (item.insertion_block_number) |height| out.writer.print("{d}", .{height}) catch |err| return allocationOnly(err) else out.writer.writeAll("null") catch |err| return allocationOnly(err);
        out.writer.writeAll(",\"leaf_index\":") catch |err| return allocationOnly(err);
        out.writer.print("{d}", .{item.leaf_index}) catch |err| return allocationOnly(err);
        out.writer.writeAll(",\"message_id\":\"") catch |err| return allocationOnly(err);
        json.writePrefixedHash(&out.writer, item.message_id) catch |err| return allocationOnly(err);
        out.writer.writeAll("\"}") catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("]}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn insertMerkle(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const array = value.object.get("merkle_tree_insertions") orelse return dataRejection(a);
    if (array != .array) return dataRejection(a);
    const inputs = try arena.allocator().alloc(MerkleInput, array.array.items.len);
    for (array.array.items, inputs) |item, *input| {
        if (item != .object) return dataRejection(a);
        const object = item.object;
        const raw_id = object.get("message_id") orelse return dataRejection(a);
        if (raw_id != .string) return dataRejection(a);
        input.* = .{
            .chain = parseUnsignedField(object.get("chain"), u32) catch return dataRejection(a),
            .insertion_block_number = parseUnsignedField(object.get("insertion_block_number"), u64) catch return dataRejection(a),
            .leaf_index = parseUnsignedField(object.get("leaf_index"), u32) catch return dataRejection(a),
            .message_id = json.parseHash(raw_id.string) catch return dataRejection(a),
        };
    }
    const owner = self.merkle.?;
    var inserted: u64 = 0;
    var skipped = std.array_list.Managed(usize).init(a);
    defer skipped.deinit();
    for (inputs, 0..) |input, index| {
        if (!owner.contains_chain(owner.context, input.chain)) {
            try skipped.append(index);
            continue;
        }
        owner.insert_fn(owner.context, input, cancel) catch |err| {
            if (err == error.OutOfMemory) return err;
            return adminError(a, 500, "Failed to store merkle tree insertion");
        };
        inserted +%= 1;
    }
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"count\":") catch |err| return allocationOnly(err);
    out.writer.print("{d}", .{inserted}) catch |err| return allocationOnly(err);
    out.writer.writeAll(",\"skipped\":[") catch |err| return allocationOnly(err);
    for (skipped.items, 0..) |index, position| {
        if (position != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        const item = inputs[index];
        out.writer.print("{{\"chain\":{d},\"insertion_block_number\":{d},\"leaf_index\":{d},\"message_id\":\"", .{ item.chain, item.insertion_block_number, item.leaf_index }) catch |err| return allocationOnly(err);
        json.writePrefixedHash(&out.writer, item.message_id) catch |err| return allocationOnly(err);
        out.writer.writeAll("\"}") catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("]}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

pub const QueueRenderFailureCode = enum {
    QUEUE_VIEW_UNAVAILABLE,
    QUEUE_VIEW_CHANGED,
    PROCESSOR_CAPACITY_UNAVAILABLE,
    REQUEST_CANCELLED,
    OTHER,
};

pub fn queueRenderFailureCode(err: anyerror) QueueRenderFailureCode {
    return switch (err) {
        error.QueueViewUnavailable => .QUEUE_VIEW_UNAVAILABLE,
        error.QueueViewChanged => .QUEUE_VIEW_CHANGED,
        error.ProcessorCapacityUnavailable => .PROCESSOR_CAPACITY_UNAVAILABLE,
        error.RequestCancelled => .REQUEST_CANCELLED,
        else => .OTHER,
    };
}

fn noteQueueRenderFailure(err: anyerror, domain: u32) void {
    // Python's monotonic clock uses CLOCK_MONOTONIC; Instant uses BOOTTIME on Linux.
    const ts = std.posix.clock_gettime(.MONOTONIC) catch return;
    const seconds = std.math.cast(u64, ts.sec) orelse return;
    const nanos = std.math.cast(u64, ts.nsec) orelse return;
    if (nanos >= std.time.ns_per_s) return;
    const whole = std.math.mul(u64, seconds, std.time.ns_per_s) catch return;
    const observed = std.math.add(u64, whole, nanos) catch return;
    const pid = std.math.cast(u32, std.posix.system.getpid()) orelse return;
    if (observed == 0 or pid == 0 or pid > std.math.maxInt(i32)) return;
    std.log.warn("admin queue render failure code={s} domain={d} pid={d} observed_monotonic_ns={d}", .{ @tagName(queueRenderFailureCode(err)), domain, pid, observed });
}

fn listOperations(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var params = query.parse(a, request.query orelse "") catch return queryRejection(a);
    defer params.deinit();
    const domain = query.unsigned(params.get("destination_domain") orelse "", u32) catch return queryRejection(a);
    const owner = self.queue.?;
    return owner.render_fn(owner.context, a, domain, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        noteQueueRenderFailure(err, domain);
        return plain(a, 500, "Error formatting queue", null);
    };
}

fn messageRetry(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    const pattern = json.parseMatching(arena.allocator(), value) catch return dataRejection(a);
    validateMatching(arena.allocator(), pattern, self.regex_engine) catch return dataRejection(a);
    var uuid: [16]u8 = undefined;
    std.crypto.random.bytes(&uuid);
    uuid[6] = (uuid[6] & 0x0f) | 0x40;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    var uuid_text: [36]u8 = undefined;
    _ = std.fmt.bufPrint(&uuid_text, "{x:0>2}{x:0>2}{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}", .{ uuid[0], uuid[1], uuid[2], uuid[3], uuid[4], uuid[5], uuid[6], uuid[7], uuid[8], uuid[9], uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15] }) catch return error.UuidFormattingFailed;
    const owner = self.retry.?;
    const result = owner.retry_fn(owner.context, a, &uuid_text, pattern, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return plain(a, 500, "Failed to send retry request to the queue", null);
    };
    if (result.failed != 0) {
        const body = try std.fmt.allocPrint(a, "Failed to persist manual retry for {d} matching operations", .{result.failed});
        return plainOwned(a, 500, body, null);
    }
    const body = try std.fmt.allocPrint(a, "{{\"uuid\":\"{s}\",\"evaluated\":{d},\"matched\":{d}}}", .{ uuid_text, result.evaluated, result.matched });
    return jsonOwnedResponse(a, 200, body);
}

fn reprocessMessage(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const object = value.object;
    const domain = parseUnsignedField(object.get("origin_id"), u32) catch return dataRejection(a);
    const id_value = object.get("message_id") orelse return dataRejection(a);
    if (id_value != .string) return dataRejection(a);
    const id = json.parseHash(id_value.string) catch return adminError(a, 400, "Failed to parse message_id");
    const db = self.messages.?;
    if (!db.contains_fn(db.context, domain)) return adminError(a, 404, "No db found for chain");
    const found = db.by_id_fn(db.context, arena.allocator(), domain, id, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to fetch message");
    } orelse return adminError(a, 404, "Message not found");
    if (try policyRejection(arena.allocator(), self, found, cancel)) |message| return adminError(a, 403, message);
    const owner = self.reprocess.?;
    const pending = owner.enqueue_fn(owner.context, arena.allocator(), found, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        if (err == error.MessageContextNotFound) return adminError(a, 404, "Message context not found");
        if (err == error.QueueNotFound) return adminError(a, 404, "Queue not found");
        return adminError(a, 500, "Failed to fetch message");
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"pending_message\":") catch |err| return allocationOnly(err);
    json.writeString(&out.writer, pending) catch |err| return allocationOnly(err);
    out.writer.writeByte('}') catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn policyRejection(a: A, self: *Admin, message: protocol.Message, cancel: Cancel) !?[]const u8 {
    var decision = try self.policy.?.check(message);
    defer decision.deinit();
    if (decision.denial) |denial| {
        return switch (denial) {
            .not_whitelisted => "Message not whitelisted",
            .message_blacklisted => "Message blacklisted",
            .address_blacklisted => "Message involves a blacklisted address",
            .runtime_denylisted => "Message matches the runtime denylist",
        };
    }
    const cache = self.origin_signers orelse return "Message's origin transaction signer matches the runtime denylist";
    const signers = try cache.lookup_fn(cache.context, a, message.id(), cancel);
    if (signers.len == 0) return null;
    var signer_decision = try self.policy.?.checkOriginSigners(signers);
    defer signer_decision.deinit();
    if (signer_decision.denial != null) return "Message's origin transaction signer matches the runtime denylist";
    return null;
}

fn validateMatching(a: A, list: settings.MatchingList, engine: ?*regex.Engine) !void {
    var matcher = try matching.Matcher.init(a, list, engine);
    defer matcher.deinit();
}

fn listGasRules(self: *Admin, a: A, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const owner = self.gas.?;
    const domains = owner.list_fn(owner.context, arena.allocator(), cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to list IGP rules");
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"policies\":{") catch |err| return allocationOnly(err);
    for (domains, 0..) |domain, domain_index| {
        if (domain_index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        json.writeString(&out.writer, domain.domain) catch |err| return allocationOnly(err);
        out.writer.writeAll(":[") catch |err| return allocationOnly(err);
        for (domain.rules, 0..) |rule, index| {
            if (index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
            out.writer.writeAll("{\"policy\":") catch |err| return allocationOnly(err);
            json.writeGasPolicy(&out.writer, rule.policy) catch |err| return allocationOnly(err);
            out.writer.writeAll(",\"matching_list\":[") catch |err| return allocationOnly(err);
            for (rule.matching_list, 0..) |element, element_index| {
                if (element_index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
                out.writer.writeByte('"') catch |err| return allocationOnly(err);
                json.writeMatchingRuleDebug(&out.writer, element) catch |err| return allocationOnly(err);
                out.writer.writeByte('"') catch |err| return allocationOnly(err);
            }
            out.writer.writeAll("]}") catch |err| return allocationOnly(err);
        }
        out.writer.writeByte(']') catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("}}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn addGasRule(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const object = value.object;
    const rule: GasRule = .{
        .policy = json.parseGasPolicy(object.get("policy") orelse return dataRejection(a)) catch return dataRejection(a),
        .matching_list = json.parseMatching(arena.allocator(), object.get("matching_list") orelse return dataRejection(a)) catch return dataRejection(a),
    };
    validateMatching(arena.allocator(), rule.matching_list, self.regex_engine) catch return dataRejection(a);
    const owner = self.gas.?;
    owner.add_fn(owner.context, a, rule, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to add IGP rule");
    };
    return jsonResponse(a, 200, "{}");
}

fn removeGasRule(self: *Admin, a: A, path_index: []const u8, cancel: Cancel) !http.Response {
    if (path_index.len == 0) return adminError(a, 400, "Invalid path parameter");
    const index = std.fmt.parseInt(usize, path_index, 10) catch return adminError(a, 400, "Invalid path parameter");
    const owner = self.gas.?;
    owner.remove_fn(owner.context, index, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to remove IGP rule");
    };
    return jsonResponse(a, 200, "{}");
}

fn merkleProof(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var params = query.parse(a, request.query orelse "") catch return queryRejection(a);
    defer params.deinit();
    const domain = query.unsigned(params.get("domain_id") orelse "", u32) catch return queryRejection(a);
    const leaf = query.unsigned(params.get("leaf_index") orelse "", u32) catch return queryRejection(a);
    const root = query.unsigned(params.get("root_index") orelse "", u32) catch return queryRejection(a);
    const owner = self.proofs.?;
    if (!owner.contains_fn(owner.context, domain)) {
        const body = try std.fmt.allocPrint(a, "Domain {d} does not exist", .{domain});
        return adminError(a, 404, body);
    }
    const proof = owner.proof_fn(owner.context, domain, leaf, root, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, @errorName(err));
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"proof\":{\"leaf\":\"") catch |err| return allocationOnly(err);
    json.writePrefixedHash(&out.writer, proof.leaf) catch |err| return allocationOnly(err);
    out.writer.print("\",\"index\":{d},\"path\":[", .{proof.index}) catch |err| return allocationOnly(err);
    for (proof.path, 0..) |hash, index| {
        if (index != 0) out.writer.writeByte(',') catch |err| return allocationOnly(err);
        out.writer.writeByte('"') catch |err| return allocationOnly(err);
        json.writePrefixedHash(&out.writer, hash) catch |err| return allocationOnly(err);
        out.writer.writeByte('"') catch |err| return allocationOnly(err);
    }
    out.writer.writeAll("]},\"root\":\"") catch |err| return allocationOnly(err);
    json.writeUnprefixedHash(&out.writer, proof.root()) catch |err| return allocationOnly(err);
    out.writer.writeAll("\"}") catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn denylistSummary(a: A, list: *runtime_denylist.RuntimeDenylist) !http.Response {
    const summary = list.summary();
    const body = try std.fmt.allocPrint(a, "{{\"version\":{d},\"messageRules\":{d},\"addressRules\":{d}}}", .{ summary.version, summary.message_rules, summary.address_rules });
    return jsonOwnedResponse(a, 200, body);
}

fn denylistRefresh(a: A, list: *runtime_denylist.RuntimeDenylist, clock: runtime_denylist.Clock, binder: DenylistRefreshBinder, cancel: Cancel) !http.Response {
    try binder.bind_fn(binder.context, cancel);
    defer binder.unbind_fn(binder.context, cancel);
    _ = list.refresh(clock) catch return plain(a, 502, "Runtime denylist refresh failed; see relayer logs", null);
    return denylistSummary(a, list);
}

fn overwriteNonce(self: *Admin, a: A, request: http.Request, cancel: Cancel) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const object = value.object;
    const domain = parseUnsignedField(object.get("domain_id"), u32) catch return dataRejection(a);
    const raw_nonce = object.get("new_upper_nonce") orelse std.json.Value{ .null = {} };
    const nonce: ?u64 = if (raw_nonce == .null) null else parseUnsignedField(raw_nonce, u64) catch return dataRejection(a);
    const owner = self.nonce.?;
    if (!owner.contains_fn(owner.context, domain)) {
        const body = try std.fmt.allocPrint(a, "Domain {d} does not exist", .{domain});
        return adminError(a, 404, body);
    }
    owner.overwrite_fn(owner.context, domain, nonce, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return adminError(a, 500, "Failed to overwrite upper nonce: command failed");
    };
    return jsonResponse(a, 200, "null");
}

fn environmentVariable(self: *Admin, a: A, request: http.Request, cancel: Cancel, get: bool) !http.Response {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = parseJsonBody(arena.allocator(), request) catch |err| return bodyRejection(a, err);
    if (value != .object) return dataRejection(a);
    const object = value.object;
    const name_value = object.get("name") orelse return dataRejection(a);
    if (name_value != .string) return dataRejection(a);
    const value_field = object.get("value") orelse std.json.Value{ .null = {} };
    if (value_field != .string and value_field != .null) return dataRejection(a);
    const owner = self.environment.?;
    const result = if (get) owner.get_fn(owner.context, arena.allocator(), name_value.string, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return plain(a, 500, @errorName(err), null);
    } else owner.set_fn(owner.context, arena.allocator(), name_value.string, if (value_field == .string) value_field.string else null, cancel) catch |err| {
        if (err == error.OutOfMemory) return err;
        return plain(a, 500, @errorName(err), null);
    };
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"name\":") catch |err| return allocationOnly(err);
    json.writeString(&out.writer, name_value.string) catch |err| return allocationOnly(err);
    out.writer.writeAll(",\"value\":") catch |err| return allocationOnly(err);
    switch (result) {
        .absent => out.writer.writeAll("null") catch |err| return allocationOnly(err),
        .value => |text| json.writeString(&out.writer, text) catch |err| return allocationOnly(err),
    }
    const action: []const u8 = if (get) "got" else if (result == .absent) "unset" else "set";
    out.writer.writeAll(",\"message\":") catch |err| return allocationOnly(err);
    json.writeString(&out.writer, action) catch |err| return allocationOnly(err);
    out.writer.writeByte('}') catch |err| return allocationOnly(err);
    return json.response(&out, a, 200, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn parseJsonBody(a: A, request: http.Request) !std.json.Value {
    const content_type = request.header("content-type") orelse return error.MissingJsonContentType;
    var iterator = std.mem.splitScalar(u8, content_type, ';');
    const mime = std.mem.trim(u8, iterator.first(), " \t");
    if (!std.ascii.eqlIgnoreCase(mime, "application/json")) return error.MissingJsonContentType;
    const parsed = try std.json.parseFromSlice(std.json.Value, a, request.body, .{});
    return parsed.value;
}

fn parseUnsignedField(value: ?std.json.Value, comptime T: type) !T {
    const raw = value orelse return error.InvalidJsonFieldValue;
    return switch (raw) {
        .integer => |number| std.math.cast(T, number) orelse error.InvalidJsonFieldValue,
        .number_string => |text| std.fmt.parseInt(T, text, 10) catch error.InvalidJsonFieldValue,
        else => error.InvalidJsonFieldValue,
    };
}

fn allocationOnly(err: anyerror) anyerror {
    return if (err == error.OutOfMemory) err else error.OutOfMemory;
}

fn queryRejection(a: A) !http.Response {
    return plain(a, 400, "Failed to deserialize query string", null);
}
fn bodyRejection(a: A, err: anyerror) !http.Response {
    return switch (err) {
        error.MissingJsonContentType => plain(a, 415, "Expected request with `Content-Type: application/json`", null),
        error.OutOfMemory => err,
        else => plain(a, 400, "Failed to deserialize the JSON body", null),
    };
}
fn dataRejection(a: A) !http.Response {
    return plain(a, 422, "Failed to deserialize the JSON body", null);
}

fn adminError(a: A, status: u16, message: []const u8) !http.Response {
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    out.writer.writeAll("{\"message\":") catch |err| return allocationOnly(err);
    json.writeString(&out.writer, message) catch |err| return allocationOnly(err);
    out.writer.writeByte('}') catch |err| return allocationOnly(err);
    return json.response(&out, a, status, &.{.{ .name = "content-type", .value = "application/json" }});
}

fn jsonResponse(a: A, status: u16, body: []const u8) !http.Response {
    return http.Response.init(a, status, &.{.{ .name = "content-type", .value = "application/json" }}, body);
}

fn jsonOwnedResponse(a: A, status: u16, body: []const u8) !http.Response {
    defer a.free(body);
    return http.Response.init(a, status, &.{.{ .name = "content-type", .value = "application/json" }}, body);
}

fn plain(a: A, status: u16, body: []const u8, content_type: ?[]const u8) !http.Response {
    return http.Response.init(a, status, &.{.{ .name = "content-type", .value = content_type orelse "text/plain; charset=utf-8" }}, body);
}

fn plainOwned(a: A, status: u16, body: []const u8, content_type: ?[]const u8) !http.Response {
    defer a.free(body);
    return plain(a, status, body, content_type);
}

fn methodNotAllowed(a: A, allow: []const u8) !http.Response {
    return http.Response.init(a, 405, &.{.{ .name = "allow", .value = allow }}, "");
}

fn notFound(a: A) !http.Response {
    return http.Response.init(a, 404, &.{}, "");
}
