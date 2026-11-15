//! Finality-bound EVM stream reads. Cursor gaps are handled separately; this
//! layer validates chain identity, event ABI, canonical log blocks and a stable
//! range-end fence before returning an owned batch for storage.
const std = @import("std");
const rpc = @import("provider.zig");
const abi = @import("codecs.zig");
const protocol = @import("../protocol/root.zig");
const objects = @import("../storage/objects.zig");
const native_store = @import("../agents/store.zig");
const sequence = @import("../runtime/sequence_cursor.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
pub const Stream = native_store.Stream;
pub const Config = struct {
    chain_id: u256,
    domain: u32,
    mailbox: abi.Address,
    hook: abi.Address,
    paymaster: abi.Address,
    reorg_period: objects.ReorgPeriod,
};
pub const CountTip = struct { count: ?u32, tip: u32, block_hash: Hash };
pub const Batch = struct {
    allocator: Allocator,
    stream: Stream,
    logs: []rpc.Log,
    through: rpc.BlockHeader,
    domain: u32,

    pub fn deinit(self: *Batch) void {
        for (self.logs) |*log| log.deinit();
        self.allocator.free(self.logs);
        self.* = undefined;
    }

    /// Cursor position advances only after this succeeds. Partial native-store
    /// failures are safe to replay: message nonces and payment log identities
    /// deduplicate the corresponding effects.
    pub fn store(self: *const Batch, database: *native_store.Store) ![]sequence.Log {
        return self.storeObserved(database, null);
    }
    pub fn storeObserved(self: *const Batch, database: *native_store.Store, observer: ?@import("../runtime/indexing_observer.zig").Observer) ![]sequence.Log {
        var offset: usize = 0;
        return self.storeObservedFrom(database, observer, &offset);
    }
    /// A queue-capacity yield retains this row offset until notification succeeds.
    /// Replayed earlier rows still contribute cursor positions without republishing.
    pub fn storeObservedFrom(self: *const Batch, database: *native_store.Store, observer: ?@import("../runtime/indexing_observer.zig").Observer, offset: *usize) ![]sequence.Log {
        var positions: std.ArrayList(sequence.Log) = .empty;
        errdefer positions.deinit(self.allocator);
        try positions.ensureTotalCapacity(self.allocator, self.logs.len);
        for (self.logs, 0..) |log, position| {
            const write = position >= offset.*;
            const event = try log.event();
            var transaction: [64]u8 = @splat(0);
            transaction[32..64].* = log.transaction_hash;
            switch (self.stream) {
                .dispatch => {
                    if (event != .dispatch) return error.UnexpectedStreamEvent;
                    const message = try protocol.Message.decode(event.dispatch.message);
                    if (message.origin != self.domain) return error.WrongMessageOrigin;
                    if (write) if (try database.storeMessage(message, log.block_number, transaction)) if (observer) |sink| sink.notify(.{ .stored = .{ .stream = self.stream } });
                    positions.appendAssumeCapacity(.{ .sequence = message.nonce, .block = std.math.cast(u32, log.block_number) orelse return error.IndexHeightOutOfRange });
                },
                .insertion => {
                    if (event != .insertion) return error.UnexpectedStreamEvent;
                    if (write) if (try database.storeInsertion(.{ .leaf_index = event.insertion.index, .message_id = event.insertion.message_id }, log.block_number)) if (observer) |sink| sink.notify(.{ .stored = .{ .stream = self.stream } });
                    positions.appendAssumeCapacity(.{ .sequence = event.insertion.index, .block = std.math.cast(u32, log.block_number) orelse return error.IndexHeightOutOfRange });
                },
                .gas => {
                    if (event != .gas_payment) return error.UnexpectedStreamEvent;
                    const payment = event.gas_payment;
                    if (write) if (try database.storePayment(.{ .message_id = payment.message_id, .destination = payment.destination, .payment = payment.payment, .gas_amount = payment.gas_amount }, .{ .transaction_id = transaction, .log_index = log.log_index })) if (observer) |sink| sink.notify(.{ .stored = .{ .stream = self.stream } });
                },
                .delivery => return error.UnsequencedStream,
            }
            offset.* = @max(offset.*, position + 1);
        }
        return positions.toOwnedSlice(self.allocator);
    }
};

pub const Indexer = struct {
    allocator: Allocator,
    client: *rpc.RpcClient,
    config: Config,
    chain_checked: bool = false,

    pub fn init(allocator: Allocator, client: *rpc.RpcClient, config: Config) !Indexer {
        _ = try tag(config.reorg_period);
        return .{ .allocator = allocator, .client = client, .config = config };
    }

    pub fn check(self: *Indexer) !void {
        try self.client.checkChain(self.config.chain_id);
        self.chain_checked = true;
    }

    pub fn finalized(self: *Indexer) !rpc.BlockHeader {
        if (!self.chain_checked) return error.ChainNotChecked;
        return switch (self.config.reorg_period) {
            .none => self.client.blockHeader(.latest),
            .blocks => |depth| self.client.blockHeader(.{ .number = (try self.client.blockNumber()) -| depth }),
            .tag => self.client.blockHeader((try tag(self.config.reorg_period)).?),
        };
    }

    pub fn countTip(self: *Indexer, stream: Stream) !CountTip {
        const head = try self.finalized();
        const value: ?u32 = switch (stream) {
            .dispatch => value: {
                const bytes = try self.client.ethCall(self.config.mailbox, &abi.selector("nonce()"), .{ .number = head.number });
                defer self.allocator.free(bytes);
                break :value try abi.uintWord(u32, bytes);
            },
            .insertion => try self.client.count(self.config.hook, .{ .number = head.number }),
            .gas, .delivery => null,
        };
        if (!std.mem.eql(u8, &(try self.client.blockHeader(.{ .number = head.number })).hash, &head.hash)) return error.IndexingReorg;
        return .{ .count = value, .tip = std.math.cast(u32, head.number) orelse return error.IndexHeightOutOfRange, .block_hash = head.hash };
    }

    /// Stream count at `head`, pinned to its block hash (EIP-1898): the value
    /// is exactly that block's state. It is canonical only once a later fence
    /// at `head.number` matches `head.hash` (the trailing fence of the fetch it
    /// plans, or `verifyHead`), so no separate post-count header is read.
    pub fn countAt(self: *Indexer, stream: Stream, head: rpc.BlockHeader) !?u32 {
        if (!self.chain_checked) return error.ChainNotChecked;
        const target, const selector = switch (stream) {
            .dispatch => .{ self.config.mailbox, abi.selector("nonce()") },
            .insertion => .{ self.config.hook, abi.selector("count()") },
            .gas, .delivery => return null,
        };
        const to = try abi.hexAlloc(self.allocator, &target);
        defer self.allocator.free(to);
        const data = try abi.hexAlloc(self.allocator, &selector);
        defer self.allocator.free(data);
        const pinned = try abi.hexAlloc(self.allocator, &head.hash);
        defer self.allocator.free(pinned);
        var response = try self.client.call("eth_call", .{ .{ .to = to, .data = data }, .{ .blockHash = pinned } });
        defer response.deinit();
        const text = try rpc.string(response.value());
        if (text.len != 66 or !std.mem.startsWith(u8, text, "0x")) return error.InvalidRpcResult;
        var word: [32]u8 = undefined;
        _ = try abi.decodeHex(&word, text);
        return try abi.uintWord(u32, &word);
    }

    /// Fence: `head` is still the canonical header at its height.
    pub fn verifyHead(self: *Indexer, head: rpc.BlockHeader) !void {
        if (!std.mem.eql(u8, &(try self.client.blockHeader(.{ .number = head.number })).hash, &head.hash)) return error.IndexingReorg;
    }

    pub fn fetch(self: *Indexer, stream: Stream, range: sequence.Range, finalized_height: u64) !Batch {
        return self.fetchFenced(stream, range, finalized_height, .{});
    }

    pub const Fencing = struct {
        /// A header at `range.to` this same endpoint already returned and
        /// hash-fenced (for example the checkpoint round head). It replaces the
        /// leading fence read; the trailing fence after eth_getLogs is always read.
        leading: ?rpc.BlockHeader = null,
        /// Validator insertion stream only. Logs at or below this height skip
        /// the per-block header read and carry unknown (all-zero) provenance.
        /// Sound only when every resulting leaf is bound by a Merkle root that a
        /// quorum read at a fenced head >= this height before anything is signed
        /// (Service.authorize); a non-canonical leaf then fails closed.
        root_checked_through: ?u64 = null,
    };

    pub fn fetchFenced(self: *Indexer, stream: Stream, range: sequence.Range, finalized_height: u64, fencing: Fencing) !Batch {
        if (!self.chain_checked) return error.ChainNotChecked;
        if (range.from > range.to or range.to > finalized_height) return error.RangeBeyondFinality;
        if (fencing.root_checked_through != null and stream != .insertion) return error.UnsupportedRootCheckedStream;
        const leading = fencing.leading;
        if (leading) |known| if (known.number != range.to) return error.InvalidLeadingFence;
        const address = switch (stream) {
            .dispatch, .delivery => self.config.mailbox,
            .insertion => self.config.hook,
            .gas => self.config.paymaster,
        };
        const topic = switch (stream) {
            .dispatch => abi.dispatch_topic,
            .insertion => abi.insertion_topic,
            .gas => abi.gas_payment_topic,
            .delivery => abi.process_id_topic,
        };
        const fence = leading orelse try self.client.blockHeader(.{ .number = range.to });
        var response = try self.client.getLogs(address, range.from, range.to, topic);
        defer response.deinit();
        var logs: std.ArrayList(rpc.Log) = .empty;
        errdefer {
            for (logs.items) |*log| log.deinit();
            logs.deinit(self.allocator);
        }
        for (response.value().array.items) |value| {
            var log = try rpc.Log.parse(self.allocator, value);
            errdefer log.deinit();
            _ = try log.event();
            try logs.append(self.allocator, log);
        }
        std.mem.sort(rpc.Log, logs.items, {}, less);
        var unique: usize = 0;
        for (0..logs.items.len) |position| {
            const log = logs.items[position];
            if (unique > 0) {
                const previous = logs.items[unique - 1];
                if (previous.block_number == log.block_number and previous.log_index == log.log_index) {
                    if (!sameLog(previous, log)) return error.ConflictingDuplicateLog;
                    self.allocator.free(log.data);
                    logs.items[position].data = &.{};
                    continue;
                }
            }
            // Moving a Log does not duplicate ownership: mark the old slot as
            // empty immediately so the failure cleanup cannot double free it.
            if (unique != position) {
                logs.items[unique] = log;
                logs.items[position].data = &.{};
            }
            unique += 1;
        }
        logs.shrinkRetainingCapacity(unique);
        var header: ?rpc.BlockHeader = null;
        for (logs.items) |*log| {
            // The leading fence and its committed parent hash prove membership
            // for the last two heights (the trailing fence below proves the
            // fence stayed canonical across eth_getLogs); deeper heights read
            // their own header after eth_getLogs unless root-checked.
            const canonical = if (log.block_number == fence.number)
                std.mem.eql(u8, &log.block_hash, &fence.hash)
            else if (log.block_number +| 1 == fence.number)
                std.mem.eql(u8, &log.block_hash, &fence.parent_hash)
            else if (fencing.root_checked_through != null and log.block_number <= fencing.root_checked_through.?) blk: {
                // Unverified block identity is never recorded as provenance.
                log.block_hash = @splat(0);
                break :blk true;
            } else blk: {
                if (header == null or header.?.number != log.block_number) header = try self.client.blockHeader(.{ .number = log.block_number });
                break :blk log.matchesHeader(header.?);
            };
            if (!canonical) return error.NoncanonicalLog;
            if (stream == .dispatch) {
                const message = try protocol.Message.decode((try log.event()).dispatch.message);
                if (message.origin != self.config.domain) return error.WrongMessageOrigin;
            }
        }
        if (!std.mem.eql(u8, &(try self.client.blockHeader(.{ .number = range.to })).hash, &fence.hash)) return error.IndexingReorg;
        return .{ .allocator = self.allocator, .stream = stream, .logs = try logs.toOwnedSlice(self.allocator), .through = fence, .domain = self.config.domain };
    }
};

fn tag(period: objects.ReorgPeriod) !?rpc.BlockRef {
    if (period != .tag) return null;
    return try rpc.BlockRef.fromTag(period.tag);
}

fn less(_: void, a: rpc.Log, b: rpc.Log) bool {
    return if (a.block_number != b.block_number) a.block_number < b.block_number else a.log_index < b.log_index;
}
fn sameLog(a: rpc.Log, b: rpc.Log) bool {
    return std.mem.eql(u8, &a.address, &b.address) and a.topic_count == b.topic_count and
        std.mem.eql(Hash, a.topics[0..a.topic_count], b.topics[0..b.topic_count]) and std.mem.eql(u8, a.data, b.data) and
        std.mem.eql(u8, &a.block_hash, &b.block_hash) and std.mem.eql(u8, &a.transaction_hash, &b.transaction_hash) and a.transaction_index == b.transaction_index;
}

test "EVM indexer refuses invalid tags and unverified chain reads before I/O" {
    const allocator = std.testing.allocator;
    var client = try rpc.RpcClient.init(allocator, "http://127.0.0.1:1", .{});
    defer client.deinit();
    const config: Config = .{ .chain_id = 1, .domain = 1, .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(3), .reorg_period = .{ .tag = "finalized" } };
    var indexer = try Indexer.init(allocator, &client, config);
    try std.testing.expectError(error.ChainNotChecked, indexer.finalized());
    try std.testing.expectError(error.ChainNotChecked, indexer.countTip(.dispatch));
    try std.testing.expectError(error.ChainNotChecked, indexer.fetch(.dispatch, .{ .from = 1, .to = 2 }, 2));
    var invalid = config;
    invalid.reorg_period = .{ .tag = "anything" };
    try std.testing.expectError(error.InvalidEvmReorgTag, Indexer.init(allocator, &client, invalid));
}
