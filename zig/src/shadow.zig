//! Bounded read-only EVM capture. There is no signing, storage-lease acquisition,
//! checkpoint publication, or transaction submission path in this driver.
const std = @import("std");
const evm = @import("evm/root.zig");
const protocol = @import("protocol/root.zig");
const Curl = @import("net/curl.zig");

pub const Config = struct {
    rpc_url: []const u8,
    chain_id: u64,
    domain: u32,
    mailbox: []const u8,
    merkle_tree_hook: ?[]const u8 = null,
    from_block: u64,
    to_block: ?u64 = null,
    max_blocks: u64 = 16,
    /// Uses the finalized tag unless an explicit depth is configured. No
    /// fallback to latest when an RPC doesn't implement finalized.
    confirmations: ?u64 = null,
    curl_library: []const u8 = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4",
};
pub const CapturedMessage = struct { block: u64, transaction: [32]u8, log_index: u64, id: [32]u8, encoded_hex: []const u8 };
pub const CapturedInsertion = struct { block: u64, transaction: [32]u8, log_index: u64, index: u32, message_id: [32]u8 };
pub const Report = struct {
    schema_version: u8 = 1,
    mode: []const u8 = "read-only EVM capture; not whole-agent parity",
    chain_id: u64,
    domain: u32,
    from_block: u64,
    to_block: u64,
    finalized_height: u64,
    headers: []const evm.BlockHeader,
    messages: []const CapturedMessage,
    insertions: []const CapturedInsertion,
    messages_sha256: [32]u8,
    allocator: std.mem.Allocator,

    pub fn deinit(self: *Report) void {
        for (self.messages) |message| self.allocator.free(message.encoded_hex);
        self.allocator.free(self.messages);
        self.allocator.free(self.insertions);
        self.allocator.free(self.headers);
        self.* = undefined;
    }

    pub fn jsonStringify(self: Report, writer: anytype) !void {
        // Allocator internals and endpoint credentials never enter artifacts.
        try writer.write(.{
            .schema_version = self.schema_version,
            .mode = self.mode,
            .chain_id = self.chain_id,
            .domain = self.domain,
            .from_block = self.from_block,
            .to_block = self.to_block,
            .finalized_height = self.finalized_height,
            .headers = self.headers,
            .messages = self.messages,
            .insertions = self.insertions,
            .messages_sha256 = self.messages_sha256,
        });
    }
};

pub fn capture(allocator: std.mem.Allocator, config: Config) !Report {
    if (config.from_block == 0 or config.max_blocks == 0 or config.max_blocks > 2000) return error.InvalidCaptureRange;
    const mailbox = try evm.codecs.fixedHex(20, config.mailbox);
    const hook = if (config.merkle_tree_hook) |text| try evm.codecs.fixedHex(20, text) else null;
    var transport = try Curl.Client.init(allocator, config.curl_library);
    defer transport.deinit();
    var client = try evm.RpcClient.init(allocator, config.rpc_url, .{ .native_transport = &transport });
    defer client.deinit();
    try client.checkChain(config.chain_id);
    const frontier = if (config.confirmations) |depth|
        try client.blockHeader(.{ .number = try client.confirmedHead(depth) })
    else
        try client.blockHeader(.finalized);
    if (frontier.number < config.from_block) return error.CaptureAheadOfFinality;
    const to = @min(frontier.number, @min(config.to_block orelse std.math.maxInt(u64), config.from_block +| (config.max_blocks - 1)));
    if (to < config.from_block) return error.InvalidCaptureRange;
    const headers = try allocator.alloc(evm.BlockHeader, @intCast(to - config.from_block + 1));
    errdefer allocator.free(headers);
    const anchor = try client.blockHeader(.{ .number = config.from_block - 1 });
    var previous_hash = anchor.hash;
    for (headers, config.from_block..) |*header, number| {
        header.* = try client.blockHeader(.{ .number = number });
        if (!std.mem.eql(u8, &header.parent_hash, &previous_hash)) return error.NoncanonicalCapture;
        previous_hash = header.hash;
    }
    var messages: std.ArrayList(CapturedMessage) = .empty;
    errdefer {
        for (messages.items) |message| allocator.free(message.encoded_hex);
        messages.deinit(allocator);
    }
    var insertions: std.ArrayList(CapturedInsertion) = .empty;
    errdefer insertions.deinit(allocator);
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var dispatches = try client.getLogs(mailbox, config.from_block, to, evm.codecs.dispatch_topic);
    defer dispatches.deinit();
    const logs = try parseLogs(allocator, dispatches.value());
    defer freeLogs(allocator, logs);
    var nonce: ?u32 = null;
    for (logs) |log| {
        try authenticateLog(log, headers, config.from_block);
        const dispatch = (try log.event()).dispatch;
        const message = try protocol.Message.decode(dispatch.message);
        if (message.origin != config.domain) return error.WrongMessageOrigin;
        if (message.version != 3) return error.UnsupportedMessageVersion;
        if (nonce) |previous| {
            if (previous == std.math.maxInt(u32) or message.nonce != previous + 1) return error.MissingDispatch;
        }
        nonce = message.nonce;
        const encoded_hex = try evm.codecs.hexAlloc(allocator, dispatch.message);
        errdefer allocator.free(encoded_hex);
        try messages.append(allocator, .{ .block = log.block_number, .transaction = log.transaction_hash, .log_index = log.log_index, .id = message.id(), .encoded_hex = encoded_hex });
        hasher.update(dispatch.message);
    }
    if (hook) |address| {
        var response = try client.getLogs(address, config.from_block, to, evm.codecs.insertion_topic);
        defer response.deinit();
        const leaves = try parseLogs(allocator, response.value());
        defer freeLogs(allocator, leaves);
        var index: ?u32 = null;
        for (leaves) |log| {
            try authenticateLog(log, headers, config.from_block);
            const leaf = (try log.event()).insertion;
            if (index) |previous| {
                if (previous == std.math.maxInt(u32) or leaf.index != previous + 1) return error.MissingInsertion;
            }
            index = leaf.index;
            try insertions.append(allocator, .{ .block = log.block_number, .transaction = log.transaction_hash, .log_index = log.log_index, .index = leaf.index, .message_id = leaf.message_id });
        }
    }
    // Bind completion to the same branch inspected before all log reads.
    const after = try client.blockHeader(.{ .number = to });
    if (!std.mem.eql(u8, &after.hash, &headers[headers.len - 1].hash)) return error.CaptureReorg;
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const owned_messages = try messages.toOwnedSlice(allocator);
    errdefer {
        for (owned_messages) |message| allocator.free(message.encoded_hex);
        allocator.free(owned_messages);
    }
    return .{ .allocator = allocator, .chain_id = config.chain_id, .domain = config.domain, .from_block = config.from_block, .to_block = to, .finalized_height = frontier.number, .headers = headers, .messages = owned_messages, .insertions = try insertions.toOwnedSlice(allocator), .messages_sha256 = digest };
}

fn authenticateLog(log: evm.Log, headers: []const evm.BlockHeader, from: u64) !void {
    if (log.block_number < from or log.block_number - from >= headers.len) return error.LogOutsideCapture;
    if (!log.matchesHeader(headers[@intCast(log.block_number - from)])) return error.NoncanonicalLog;
}

fn lessThan(_: void, left: evm.Log, right: evm.Log) bool {
    if (left.block_number != right.block_number) return left.block_number < right.block_number;
    return left.log_index < right.log_index;
}

fn parseLogs(allocator: std.mem.Allocator, value: std.json.Value) ![]evm.Log {
    if (value != .array) return error.InvalidLogBatch;
    const logs = try allocator.alloc(evm.Log, value.array.items.len);
    var initialized: usize = 0;
    errdefer {
        for (logs[0..initialized]) |*log| log.deinit();
        allocator.free(logs);
    }
    for (value.array.items, logs) |raw, *log| {
        log.* = try evm.Log.parse(allocator, raw);
        initialized += 1;
    }
    std.mem.sort(evm.Log, logs, {}, lessThan);
    for (logs, 0..) |log, i| {
        if (i == 0) continue;
        const previous = logs[i - 1];
        if (log.block_number == previous.block_number) {
            if (log.log_index == previous.log_index) return error.DuplicateLog;
            if (log.transaction_index < previous.transaction_index) return error.InvalidLogOrdering;
        }
    }
    return logs;
}

fn freeLogs(allocator: std.mem.Allocator, logs: []evm.Log) void {
    for (logs) |*log| log.deinit();
    allocator.free(logs);
}

test "invalid capture configurations fail before network requests" {
    const config: Config = .{ .rpc_url = "http://127.0.0.1:1", .chain_id = 1, .domain = 1, .mailbox = "0x00", .from_block = 0 };
    try std.testing.expectError(error.InvalidCaptureRange, capture(std.testing.allocator, config));
    var invalid = config;
    invalid.from_block = 1;
    invalid.max_blocks = 2001;
    try std.testing.expectError(error.InvalidCaptureRange, capture(std.testing.allocator, invalid));
}
