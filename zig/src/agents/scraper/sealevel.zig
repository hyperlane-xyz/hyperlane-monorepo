//! Concrete sequence indexers over finalized Sealevel PDA accounts. The generic
//! adapter supplies complete-block paging and derives insertions from dispatch.
const std = @import("std");
const src = @import("source.zig");
const generic = @import("generic.zig");
const p = @import("../../sealevel/provider.zig");
const accounts = @import("../../sealevel/accounts.zig");
const mailbox = @import("../../sealevel/mailbox.zig");
const borsh = @import("../../sealevel/borsh.zig");
const solana = @import("../../altvm/solana.zig");
const b58 = @import("../../altvm/base58.zig");
const rpc = @import("../../evm/provider.zig");
const meta = @import("../../sealevel/log_meta.zig");
pub const Adapter = struct {
    allocator: std.mem.Allocator,
    client: *p.Client,
    contracts: src.Contracts,
    domain: u32,
    max_transaction_version: u8 = 0,
    igp_program: ?[32]u8 = null,
    generic_source: generic.Adapter,
    base: src.Source,
    contexts: [3]Context,
    blocks: std.AutoHashMapUnmanaged(u64, rpc.RpcResponse) = .{},
    block_bytes: usize = 0,
    max_block_bytes: usize = 64 * 1024 * 1024,
    pub fn init(allocator: std.mem.Allocator, client: *p.Client, contracts: src.Contracts, domain: u32, chunk: u32) !*Adapter {
        if (client.commitment != .finalized) return error.FinalizedSvmScraperRequired;
        if (chunk == 0) return error.InvalidScraperChunk;
        const self = try allocator.create(Adapter);
        errdefer allocator.destroy(self);
        self.* = .{ .allocator = allocator, .client = client, .contracts = contracts, .domain = domain, .generic_source = undefined, .base = undefined, .contexts = undefined };
        for (&self.contexts, 0..) |*context, index| context.* = .{ .owner = self, .kind = @enumFromInt(index) };
        self.generic_source = .{ .allocator = allocator, .provider = .{ .context = self, .latest_fn = latest, .header_fn = header, .unavailable_fn = unavailable }, .streams = .{ self.contexts[0].interface(), self.contexts[1].interface(), self.contexts[2].interface(), null }, .contracts = contracts, .sequence_mode = true, .derive_insertions = true, .chunk = chunk };
        self.base = try self.generic_source.interface();
        return self;
    }
    pub fn fromChain(allocator: std.mem.Allocator, client: *p.Client, chain: *const @import("../../settings/types.zig").Chain) !*Adapter {
        if (chain.protocol != .sealevel or chain.connection != .sealevel) return error.WrongScraperProtocol;
        if (chain.index.mode != .sequence) return error.SvmSequenceIndexRequired;
        const self = try init(allocator, client, .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster }, chain.domain, chain.index.chunk);
        self.max_transaction_version = chain.connection.sealevel.max_supported_transaction_version;
        return self;
    }
    pub fn deinit(self: *Adapter) void {
        self.clearBlocks();
        self.blocks.deinit(self.allocator);
        self.generic_source.deinit();
        const a = self.allocator;
        a.destroy(self);
    }
    fn igpProgram(self: *Adapter) ![32]u8 {
        if (self.igp_program) |program| return program;
        var response = try self.client.account(self.contracts.paymaster);
        defer response.deinit();
        const account = response.account orelse return error.MissingSvmIgp;
        if (account.executable) return error.ExecutableSvmIgp;
        self.igp_program = account.owner;
        return account.owner;
    }
    fn clearBlocks(self: *Adapter) void {
        var it = self.blocks.valueIterator();
        while (it.next()) |value| value.deinit();
        self.blocks.clearRetainingCapacity();
        self.block_bytes = 0;
    }
    pub fn interface(self: *Adapter) src.Source {
        var value = self.base;
        value.begin_fn = begin;
        value.cancel_fn = bindCancellation;
        return value;
    }
    fn bindCancellation(context: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        const base: *generic.Adapter = @ptrCast(@alignCast(context));
        const self: *Adapter = @ptrCast(@alignCast(base.provider.context));
        self.client.rpc_client.options.cancel = cancel;
    }
    fn begin(context: *anyopaque) !void {
        const base: *generic.Adapter = @ptrCast(@alignCast(context));
        const self: *Adapter = @ptrCast(@alignCast(base.provider.context));
        self.clearBlocks();
        try self.base.beginCycle();
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn latest(context: *anyopaque) !u64 {
        return cast(context).client.slot();
    }
    fn unavailable(err: anyerror) bool {
        return err == error.SvmBlockUnavailable;
    }
    fn getBlock(self: *Adapter, slot: u64, full: bool) !rpc.RpcResponse {
        var response = self.client.rpc_client.call("getBlock", .{ slot, .{ .encoding = "json", .transactionDetails = if (full) @as([]const u8, "full") else "none", .rewards = false, .commitment = "finalized", .maxSupportedTransactionVersion = self.max_transaction_version } }) catch |err| {
            if (err == error.RpcError) if (self.client.rpc_client.last_rpc_error_code) |code| if (code == -32001 or code == -32004 or code == -32007 or code == -32009) return error.SvmBlockUnavailable;
            return err;
        };
        errdefer response.deinit();
        if (response.value() == .null) return error.SvmBlockUnavailable;
        if (response.value() != .object) return error.InvalidSvmResponse;
        return response;
    }
    fn fullBlock(self: *Adapter, slot: u64) !std.json.Value {
        if (self.blocks.get(slot)) |cached| return cached.value();
        var response = try self.getBlock(slot, true);
        errdefer response.deinit();
        if (response.bytes.len > self.max_block_bytes -| self.block_bytes) return error.SvmBlockCacheLimit;
        try self.blocks.put(self.allocator, slot, response);
        self.block_bytes += response.bytes.len;
        return response.value();
    }
    fn header(context: *anyopaque, slot: u64) !src.Header {
        const self = cast(context);
        var block = try self.getBlock(slot, false);
        defer block.deinit();
        return .{ .height = slot, .hash = try p.decodeKey(self.allocator, try p.string(try p.field(block.value(), "blockhash"))), .parent = try p.decodeKey(self.allocator, try p.string(try p.field(block.value(), "previousBlockhash"))), .timestamp = try p.uint(try p.field(block.value(), "blockTime")) };
    }
    fn resolve(self: *Adapter, event: src.Event, pda: [32]u8, program: [32]u8, kind: meta.Kind) !src.Event {
        const block = self.fullBlock(event.block_number) catch |err| {
            if (unavailable(err)) return event;
            return err;
        };
        var at = event.block_number;
        var found = meta.find(self.allocator, block, program, pda, kind) catch |err| blk: {
            if (err == error.SvmNoTransactions) break :blk null;
            if (err == error.SvmAmbiguousTransaction) return event;
            return err;
        };
        var actual = block;
        if (found == null and at > 0) {
            at -= 1;
            actual = self.fullBlock(at) catch |err| {
                if (unavailable(err)) return event;
                return err;
            };
            found = meta.find(self.allocator, actual, program, pda, kind) catch |err| {
                if (err == error.SvmNoTransactions or err == error.SvmAmbiguousTransaction) return event;
                return err;
            };
        }
        if (found) |identity| {
            var result = event;
            result.block_number = at;
            result.block_hash = try p.decodeKey(self.allocator, try p.string(try p.field(actual, "blockhash")));
            result.tx_hash = if (std.mem.allEqual(u8, &identity.hash, 0)) null else identity.hash;
            result.tx_index = identity.index;
            // Rust advanced LogMeta uses the authenticated stream position,
            // independent of the creating instruction's transaction index.
            if (kind != .gas) result.log_index = event.sequence orelse return error.MissingSvmEventSequence;
            return result;
        }
        return event;
    }
    const Context = struct {
        owner: *Adapter,
        kind: meta.Kind,
        fn cast(context: *anyopaque) *Context {
            return @ptrCast(@alignCast(context));
        }
        fn interface(self: *Context) generic.Stream {
            return .{ .context = self, .tip_fn = tip, .fetch_fn = fetch };
        }
        fn tip(context: *anyopaque) !src.Tip {
            const self = Context.cast(context);
            const owner = self.owner;
            const contract: mailbox.Mailbox = .{ .client = owner.client, .program = owner.contracts.mailbox, .domain = owner.domain };
            return switch (self.kind) {
                .dispatch => blk: {
                    const value = try contract.outbox();
                    break :blk .{ .count = value.value.tree.count, .tip = value.slot };
                },
                .delivery => blk: {
                    const value = try contract.inbox();
                    break :blk .{ .count = std.math.cast(u32, value.value.processed_count) orelse return error.SvmSequenceOverflow, .tip = value.slot };
                },
                .gas => blk: {
                    const program = try owner.igpProgram();
                    const key = try solana.findProgramAddress(&.{ "hyperlane_igp", "-", "program_data" }, program);
                    var response = try owner.client.account(key.key);
                    defer response.deinit();
                    const account = response.account orelse return error.MissingSvmIgpProgramData;
                    if (account.executable or !std.mem.eql(u8, &account.owner, &program)) return error.WrongAccountOwner;
                    var reader: borsh.Reader = .{ .bytes = account.data };
                    try reader.initialized();
                    try reader.discriminator("PRGMDATA");
                    const bump = try reader.uint(u8);
                    if (bump != key.bump) return error.WrongAccountAddress;
                    const count = try reader.uint(u64);
                    break :blk .{ .count = std.math.cast(u32, count) orelse return error.SvmSequenceOverflow, .tip = response.slot };
                },
            };
        }
        fn fetch(context: *anyopaque, allocator: std.mem.Allocator, from: u32, through: u32) !src.Batch {
            const self = Context.cast(context);
            if (from > through or through - from >= 100000) return error.InvalidSvmSequenceRange;
            var arena = std.heap.ArenaAllocator.init(allocator);
            errdefer arena.deinit();
            const a = arena.allocator();
            var output: std.ArrayList(src.Event) = .empty;
            var sequence = from;
            while (true) {
                try output.append(a, try self.one(a, sequence));
                if (sequence == through) break;
                sequence += 1;
            }
            const owned = try output.toOwnedSlice(a);
            return .{ .arena = arena, .events = owned, .through = through };
        }
        fn one(self: *Context, a: std.mem.Allocator, sequence: u32) !src.Event {
            const owner = self.owner;
            var event: src.Event = undefined;
            var key: [32]u8 = undefined;
            var program = owner.contracts.mailbox;
            if (self.kind == .dispatch) {
                const contract: mailbox.Mailbox = .{ .client = owner.client, .program = program, .domain = owner.domain };
                var dispatch = (try contract.dispatchedByNonce(sequence)) orelse return error.MissingDispatchedSequence;
                defer dispatch.deinit();
                var message = dispatch.value.message;
                message.body = try a.dupe(u8, message.body);
                key = dispatch.key;
                event = .{ .block_number = dispatch.value.slot, .block_hash = .{0} ** 32, .address = owner.contracts.mailbox, .tx_hash = null, .log_index = 0, .sequence = sequence, .data = .{ .dispatch = message } };
            } else {
                if (self.kind == .gas) program = try owner.igpProgram();
                const discriminator = try b58.encode(a, if (self.kind == .delivery) "PROCESSD" else "GASPAYMT");
                var bytes: [8]u8 = undefined;
                std.mem.writeInt(u64, &bytes, sequence, .little);
                const encoded = try b58.encode(a, &bytes);
                const Filter = struct { memcmp: struct { offset: usize, bytes: []const u8 } };
                const filters = [_]Filter{ .{ .memcmp = .{ .offset = 1, .bytes = discriminator } }, .{ .memcmp = .{ .offset = 9, .bytes = encoded } } };
                var response = try owner.client.programAccounts(program, &filters);
                defer response.deinit();
                const values = try p.field(response.value(), "value");
                if (values.array.items.len != 1) return error.MissingOrDuplicateSvmSequence;
                const raw = values.array.items[0];
                key = try p.decodeKey(a, try p.string(try p.field(raw, "pubkey")));
                var account = try p.decodeAccount(a, try p.field(raw, "account"));
                defer account.deinit();
                if (account.executable) return error.ExecutableMailboxAccount;
                const context_slot = try p.uint(try p.field(try p.field(response.value(), "context"), "slot"));
                if (self.kind == .delivery) {
                    const value = try accounts.ProcessedMessage.decode(account.data);
                    try value.verify(program, key, account.owner);
                    if (value.sequence != sequence or value.slot > context_slot) return error.WrongSvmEventSequence;
                    event = .{ .block_number = value.slot, .block_hash = .{0} ** 32, .address = owner.contracts.mailbox, .tx_hash = null, .log_index = 0, .sequence = sequence, .data = .{ .delivery = value.message_id } };
                } else {
                    const value = try accounts.GasPayment.decode(account.data);
                    try value.verify(program, key, account.owner);
                    if (value.sequence != sequence or value.slot > context_slot) return error.WrongSvmEventSequence;
                    event = .{ .block_number = value.slot, .block_hash = .{0} ** 32, .address = owner.contracts.paymaster, .tx_hash = null, .log_index = sequence, .sequence = sequence, .data = .{ .gas = .{ .message_id = value.message_id, .destination = value.destination, .gas = value.gas_amount, .payment = if (std.mem.eql(u8, &value.igp, &owner.contracts.paymaster)) value.payment else 0 } } };
                }
            }
            return owner.resolve(event, key, program, self.kind);
        }
    };
};

// Tests keep the actual configured Resources/Pool fixture outside production
// while exercising this private advanced-metadata fallback. Empty in binaries.
pub const NativeTests = if (@import("builtin").is_test) struct {
    pub fn resolve(adapter: *Adapter, event: src.Event, pda: [32]u8, program: [32]u8, kind: meta.Kind) !src.Event {
        return adapter.resolve(event, pda, program, kind);
    }
} else struct {};

test "scraper Sealevel concrete sequence factory requires finalized clients before indexing" {
    var client: p.Client = undefined;
    client.commitment = .confirmed;
    try std.testing.expectError(error.FinalizedSvmScraperRequired, Adapter.init(std.testing.allocator, &client, undefined, 1, 1));
}

const PrunedFixture = struct {
    fn fetch(_: *anyopaque, a: std.mem.Allocator, body: []const u8, _: rpc.Options) !rpc.WireResponse {
        var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer parsed.deinit();
        const bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":null}}", .{parsed.value.object.get("id").?.integer});
        return .{ .bytes = bytes, .len = bytes.len };
    }
};
test "scraper Sealevel pruned canonical transaction metadata remains absent rather than an enrichable zero signature" {
    const a = std.testing.allocator;
    var context: u8 = 0;
    var client = try p.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &context, .fetch_fn = PrunedFixture.fetch } });
    defer client.deinit();
    const contracts: src.Contracts = .{ .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(3) };
    const adapter = try Adapter.init(a, &client, contracts, 1000, 1);
    defer adapter.deinit();
    const missing: src.Event = .{ .block_number = 10, .block_hash = @splat(0), .address = contracts.mailbox, .tx_hash = null, .sequence = 1, .log_index = 0, .data = .{ .delivery = @splat(4) } };
    const actual = try adapter.resolve(missing, @splat(5), contracts.mailbox, .delivery);
    try std.testing.expect(actual.tx_hash == null);
    try std.testing.expectEqual(@as(u64, 10), actual.block_number);
    try std.testing.expectEqual(@as(u64, 0), actual.log_index);
}

const PositionFixture = struct {
    fn cache(a: std.mem.Allocator, adapter: *Adapter, slot: u64, block: std.json.Value) !void {
        const body = try std.json.Stringify.valueAlloc(a, block, .{});
        defer a.free(body);
        const hash = try b58.encode(a, &(@as([32]u8, @splat(0x19))));
        defer a.free(hash);
        const wire = if (block.object.contains("blockhash"))
            try std.fmt.allocPrint(a, "{{\"result\":{s}}}", .{body})
        else
            try std.fmt.allocPrint(a, "{{\"result\":{s},\"blockhash\":\"{s}\"}}}}", .{ body[0 .. body.len - 1], hash });
        errdefer a.free(wire);
        var parsed = try std.json.parseFromSlice(std.json.Value, a, wire, .{});
        errdefer parsed.deinit();
        try adapter.blocks.put(a, slot, .{ .allocator = a, .bytes = wire, .parsed = parsed });
        adapter.block_bytes += wire.len;
    }
};

test "scraper Sealevel advanced metadata retains authenticated nonzero event sequences at the resolved transaction" {
    const a = std.testing.allocator;
    const fixture = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("fixtures/svm-meta-production.json.gz"), .{});
    defer fixture.deinit();
    const blocks = try p.field(fixture.value, "blocks");
    const cases = try p.field(fixture.value, "cases");
    // Exact production Rust relevance fixtures: dispatch at tx0 and a delivery
    // at tx33 after reverted siblings. The event position is its authenticated
    // sequence, independent of that transaction index or instruction position.
    for ([_]usize{ 0, 7 }, [_]u32{ 7, 42 }) |case_index, sequence| {
        const case = cases.array.items[case_index];
        const block = try p.field(blocks, try p.string(try p.field(case, "block")));
        const program = try p.decodeKey(a, try p.string(try p.field(case, "program")));
        const pda = try p.decodeKey(a, try p.string(try p.field(case, "pda")));
        const kind = std.meta.stringToEnum(meta.Kind, try p.string(try p.field(case, "kind"))).?;
        var context: u8 = 0;
        var client = try p.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &context, .fetch_fn = PrunedFixture.fetch } });
        defer client.deinit();
        const contracts: src.Contracts = .{ .mailbox = program, .hook = @splat(2), .paymaster = @splat(3) };
        const adapter = try Adapter.init(a, &client, contracts, 1000, 1);
        defer adapter.deinit();
        try PositionFixture.cache(a, adapter, 10, block);
        const event: src.Event = .{ .block_number = 10, .block_hash = @splat(0), .address = program, .tx_hash = null, .sequence = sequence, .log_index = 0, .data = if (kind == .dispatch) .{ .dispatch = .{ .version = 3, .nonce = sequence, .origin = 1000, .sender = @splat(1), .destination = 2000, .recipient = @splat(2), .body = "" } } else .{ .delivery = @splat(4) } };
        const resolved = try adapter.resolve(event, pda, program, kind);
        try std.testing.expect(resolved.tx_hash != null);
        try std.testing.expectEqual(try p.uint(try p.field(case, "index")), resolved.tx_index);
        try std.testing.expectEqual(@as(u64, sequence), resolved.log_index);
        try std.testing.expectEqual(@as(?u32, sequence), resolved.sequence);
        // Solaxy's authenticated PDA can report one slot after its creating
        // transaction. Resolve still retains the same event sequence.
        const empty = try std.json.parseFromSlice(std.json.Value, a, "{\"transactions\":[]}", .{});
        defer empty.deinit();
        try PositionFixture.cache(a, adapter, 11, empty.value);
        const shifted = try adapter.resolve(.{ .block_number = 11, .block_hash = event.block_hash, .address = event.address, .tx_hash = null, .sequence = event.sequence, .log_index = event.log_index, .data = event.data }, pda, program, kind);
        try std.testing.expectEqual(@as(u64, 10), shifted.block_number);
        try std.testing.expectEqual(resolved.tx_hash, shifted.tx_hash);
        try std.testing.expectEqual(@as(u64, sequence), shifted.log_index);
    }
}
