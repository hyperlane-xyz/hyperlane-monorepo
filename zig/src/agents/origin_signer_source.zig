//! Concrete eight-protocol origin signer lookup over borrowed Resources+Store.
//! Construction performs no I/O. Each call is serialized by this dedicated
//! source and returns an owned signer slice. The public deadline is absolute
//! Unix UTC nanoseconds; current receipt clients receive a monotonic deadline
//! computed from the same elapsed budget.
const std = @import("std");
const chain_source = @import("chain_source.zig");
const native_store = @import("store.zig");
const signers = @import("origin_signers.zig");
const protocol = @import("../protocol/root.zig");
const enrich = @import("scraper/enrichment.zig");
const receipts_evm = @import("scraper/receipts_evm.zig");
const receipts_cosmos = @import("scraper/receipts_cosmos.zig");
const receipts_radix = @import("scraper/receipts_radix.zig");
const receipts_starknet = @import("scraper/receipts_starknet.zig");
const common = @import("scraper/receipts_common.zig");
const rpc = @import("../evm/provider.zig");
const abi = @import("../evm/codecs.zig");
const tron_rpc = @import("../tron/rpc.zig");
const json_rpc = @import("../net/json_rpc.zig");
const A = std.mem.Allocator;
const Hash = signers.Hash;

pub const Provenance = struct {
    context: *anyopaque,
    block_fn: *const fn (*anyopaque, protocol.Message) anyerror!u64,
    transaction_fn: *const fn (*anyopaque, Hash) anyerror!?[64]u8,

    pub fn block(self: Provenance, message: protocol.Message) !u64 {
        return self.block_fn(self.context, message);
    }
    pub fn transaction(self: Provenance, id: Hash) !?[64]u8 {
        return self.transaction_fn(self.context, id);
    }

    pub fn fromStore(store: *native_store.Store) Provenance {
        return .{ .context = store, .block_fn = storeBlock, .transaction_fn = storeTransaction };
    }
    fn storeBlock(context: *anyopaque, message: protocol.Message) !u64 {
        const store: *native_store.Store = @ptrCast(@alignCast(context));
        var canonical = (try store.messageByNonce(message.nonce)) orelse return error.StaleCanonicalMessage;
        defer canonical.deinit();
        if (!std.mem.eql(u8, &canonical.value.id(), &message.id())) return error.StaleCanonicalMessage;
        return (try store.messageBlock(message.nonce)) orelse error.CanonicalMessageMissing;
    }
    fn storeTransaction(context: *anyopaque, id: Hash) !?[64]u8 {
        const store: *native_store.Store = @ptrCast(@alignCast(context));
        return store.dispatchedTransaction(id);
    }
};

pub const Source = struct {
    resources: *chain_source.Resources,
    provenance: Provenance,
    mutex: std.Thread.Mutex = .{},

    pub fn init(resources: *chain_source.Resources, store: *native_store.Store) Source {
        return .{ .resources = resources, .provenance = Provenance.fromStore(store) };
    }

    /// Test/custom provenance still supplies canonical DB facts, not RPC discovery.
    pub fn initProvenance(resources: *chain_source.Resources, provenance: Provenance) Source {
        return .{ .resources = resources, .provenance = provenance };
    }

    pub fn interface(self: *Source) signers.Lookup {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn fetch(context: *anyopaque, allocator: A, message: protocol.Message, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) ![]Hash {
        const self: *Source = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        var budget = try signers.WaitBudget.init(deadline_ns);
        const block = try self.provenance.block(message);
        var hash = try self.provenance.transaction(message.id());
        if (hash == null or std.mem.allEqual(u8, &hash.?, 0)) {
            if (self.resources.chain.protocol != .sealevel) return error.DispatchHashNotStored;
            hash = null;
        }
        const fetch_deadline = (try receipts_evm.nowNs()) +| (try budget.remaining());
        const owner = self.resources;
        const previous_cancel = owner.cancel;
        owner.setCancellation(cancel);
        defer owner.setCancellation(previous_cancel);
        return switch (owner.clients) {
            .ethereum => |client| evm(allocator, client, hash orelse return error.DispatchHashNotStored, block, fetch_deadline),
            .sealevel => |client| sealevel(allocator, client, owner.chain.contracts.mailbox, owner.chain.domain, message.nonce, hash, fetch_deadline),
            .cosmos => |clients| cosmos(allocator, clients.tendermint, &owner.chain, hash orelse return error.DispatchHashNotStored, block, fetch_deadline),
            .radix => |client| radix(allocator, client, &owner.http, hash orelse return error.DispatchHashNotStored, block, fetch_deadline),
            .tron => |client| tron(allocator, client, &owner.http, hash orelse return error.DispatchHashNotStored, block, fetch_deadline),
            .starknet => |factory| starknet(allocator, &factory.provider, &owner.http, hash orelse return error.DispatchHashNotStored, block, fetch_deadline),
            .aleo => |factory| aleo(allocator, factory, &owner.http, hash orelse return error.DispatchHashNotStored, fetch_deadline),
        };
    }
};

fn one(allocator: A, sender: Hash) ![]Hash {
    const result = try allocator.alloc(Hash, 1);
    result[0] = sender;
    return result;
}

fn nativeHash(hash: [64]u8) !struct { full: [64]u8, short: [32]u8 } {
    if (!std.mem.allEqual(u8, hash[0..32], 0)) return error.UnsupportedOriginTransactionHash;
    return .{ .full = hash, .short = hash[32..64].* };
}

fn transactionMeta(value: std.json.Value, hash: [64]u8, expected_block: u64) !enrich.Meta {
    const actual_hash = try abi.fixedHex(32, try rpc.string(try json_rpc.field(value, "hash")));
    const block_hash = try abi.fixedHex(32, try rpc.string(try json_rpc.field(value, "blockHash")));
    const block = try abi.quantity(try rpc.string(try json_rpc.field(value, "blockNumber")));
    const native = try nativeHash(hash);
    if (!std.mem.eql(u8, &actual_hash, &native.short) or block != expected_block) return error.OriginTransactionIdentityMismatch;
    return .{ .block_number = block, .block_hash = block_hash, .tx_hash = native.full };
}

fn evmSender(value: std.json.Value) !Hash {
    const raw = try abi.fixedHex(20, try rpc.string(try json_rpc.field(value, "from")));
    var sender: Hash = .{0} ** 32;
    @memcpy(sender[12..], &raw);
    return sender;
}

fn evm(allocator: A, client: *rpc.RpcClient, hash: [64]u8, expected_block: u64, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    const text = try abi.hexAlloc(allocator, &native.short);
    defer allocator.free(text);
    const saved = client.options;
    defer client.options = saved;
    client.options.owner_deadline_ns = @min(saved.owner_deadline_ns orelse deadline_ns, deadline_ns);
    client.options.timeout_ms = @min(client.options.timeout_ms, try common.milliseconds(deadline_ns));
    client.options.connect_timeout_ms = @min(client.options.connect_timeout_ms, client.options.timeout_ms);
    var transaction = try client.call("eth_getTransactionByHash", .{text});
    defer transaction.deinit();
    if (transaction.value() == .null) return allocator.alloc(Hash, 0);
    const meta = try transactionMeta(transaction.value(), hash, expected_block);
    client.options.timeout_ms = @min(saved.timeout_ms, try common.milliseconds(deadline_ns));
    client.options.connect_timeout_ms = @min(saved.connect_timeout_ms, client.options.timeout_ms);
    var receipt = try client.call("eth_getTransactionReceipt", .{text});
    defer receipt.deinit();
    _ = try common.milliseconds(deadline_ns);
    if (receipt.value() == .null) return one(allocator, try evmSender(transaction.value()));
    var decoded = try receipts_evm.decodePair(allocator, meta, transaction.value(), receipt.value());
    defer decoded.deinit();
    return one(allocator, decoded.value.sender);
}

fn sealevel(allocator: A, client: *@import("../sealevel/provider.zig").Client, program: Hash, domain: u32, nonce: u32, hash: ?[64]u8, deadline_ns: u64) ![]Hash {
    const saved = client.deadline_ns;
    client.deadline_ns = deadline_ns;
    defer client.deadline_ns = saved;
    const mailbox: @import("../sealevel/mailbox.zig").Mailbox = .{ .client = client, .program = program, .domain = domain };
    // The SVM implementation allocates with its RPC allocator by contract.
    const keys = (try @import("../sealevel/signers.zig").fetchTxSignersBySequence(client, mailbox, nonce, hash)) orelse return client.rpc_client.allocator.alloc(Hash, 0);
    if (client.rpc_client.allocator.ptr == allocator.ptr and client.rpc_client.allocator.vtable == allocator.vtable) return keys;
    defer client.rpc_client.allocator.free(keys);
    return allocator.dupe(Hash, keys);
}

fn cosmos(allocator: A, client: @import("../cosmos/tendermint.zig").Client, chain: *const @import("../settings/types.zig").Chain, hash: [64]u8, expected_block: u64, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    const saved = client.rpc_client.options;
    defer client.rpc_client.options = saved;
    client.rpc_client.options.owner_deadline_ns = @min(saved.owner_deadline_ns orelse deadline_ns, deadline_ns);
    client.rpc_client.options.timeout_ms = @min(client.rpc_client.options.timeout_ms, try common.milliseconds(deadline_ns));
    client.rpc_client.options.connect_timeout_ms = @min(client.rpc_client.options.connect_timeout_ms, client.rpc_client.options.timeout_ms);
    var response = try client.tx(native.short, false);
    defer response.deinit();
    const height = try @import("../cosmos/types.zig").uint(try @import("../cosmos/types.zig").field(response.value(), "height"));
    if (height != expected_block) return error.OriginTransactionIdentityMismatch;
    const connection = switch (chain.connection) {
        .cosmos => |value| value,
        .cosmosnative => |value| value,
        else => return error.WrongOriginSignerProtocol,
    };
    const config: receipts_cosmos.Config = .{ .native = chain.protocol == .cosmosnative, .bech32_prefix = connection.bech32_prefix, .gas_denom = connection.gas_price.denom, .native_denom = chain.native_token.denom, .native_decimals = chain.native_token.decimals };
    var decoded = try receipts_cosmos.decode(allocator, .{ .block_number = height, .block_hash = .{0} ** 32, .tx_hash = native.full }, response.value(), config);
    defer decoded.deinit();
    _ = try common.milliseconds(deadline_ns);
    return one(allocator, decoded.value.sender);
}

fn radixBlockHash(height: u64) Hash {
    var hash: Hash = .{0} ** 32;
    std.mem.writeInt(u64, hash[24..], height, .big);
    return hash;
}

fn radix(allocator: A, client: @import("../radix/provider.zig").Client, http_owner: *@import("../cloud/http.zig").HttpTransport, hash: [64]u8, expected_block: u64, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    var mutable = client;
    var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = http_owner, .deadline_ns = deadline_ns };
    const saved = mutable.transport;
    try transport.verify(saved);
    mutable.transport = transport.interface();
    defer mutable.transport = saved;
    var response = try mutable.committed(native.short);
    defer response.deinit();
    const transaction = try @import("../cosmos/types.zig").field(response.value(), "transaction");
    const height = try @import("../cosmos/types.zig").uint(try @import("../cosmos/types.zig").field(transaction, "state_version"));
    if (height != expected_block) return error.OriginTransactionIdentityMismatch;
    var decoded = try receipts_radix.decode(allocator, .{ .block_number = height, .block_hash = radixBlockHash(height), .tx_hash = native.full }, response.value(), mutable.network);
    defer decoded.deinit();
    _ = try common.milliseconds(deadline_ns);
    return one(allocator, decoded.value.sender);
}

fn tron(allocator: A, provider: *@import("../tron/provider.zig").Provider, http_owner: *@import("../cloud/http.zig").HttpTransport, hash: [64]u8, expected_block: u64, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    const text = try abi.hexAlloc(allocator, &native.short);
    defer allocator.free(text);
    var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = http_owner, .deadline_ns = deadline_ns };
    const saved = provider.jsonrpc.transport;
    try transport.verify(saved);
    provider.jsonrpc.transport = transport.interface();
    defer provider.jsonrpc.transport = saved;
    var transaction = try provider.jsonrpc.call("eth_getTransactionByHash", .{text});
    defer transaction.deinit();
    if (tron_rpc.result(transaction) == .null) return allocator.alloc(Hash, 0);
    const meta = try transactionMeta(tron_rpc.result(transaction), hash, expected_block);
    var receipt = try provider.jsonrpc.call("eth_getTransactionReceipt", .{text});
    defer receipt.deinit();
    _ = try common.milliseconds(deadline_ns);
    if (tron_rpc.result(receipt) == .null) return one(allocator, try evmSender(tron_rpc.result(transaction)));
    var decoded = try receipts_evm.decodePair(allocator, meta, tron_rpc.result(transaction), tron_rpc.result(receipt));
    defer decoded.deinit();
    return one(allocator, decoded.value.sender);
}

fn starknet(allocator: A, provider: *@import("../starknet/provider.zig").Provider, http_owner: *@import("../cloud/http.zig").HttpTransport, hash: [64]u8, expected_block: u64, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    const felt = try @import("../starknet/codec.zig").Felt.fromBytes(native.short);
    var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = http_owner, .deadline_ns = deadline_ns };
    const saved = provider.client.transport;
    try transport.verify(saved);
    provider.client.transport = transport.interface();
    defer provider.client.transport = saved;
    var transaction = try provider.client.call("starknet_getTransactionByHash", .{ .transaction_hash = felt });
    defer transaction.deinit();
    const receipt = (try provider.canonicalReceipt(felt)) orelse return error.OriginTransactionUnavailable;
    if (receipt.block_number != expected_block) return error.OriginTransactionIdentityMismatch;
    var decoded = try receipts_starknet.decode(allocator, .{ .block_number = receipt.block_number, .block_hash = receipt.block_hash.toBytes(), .tx_hash = native.full }, transaction.value(), receipt);
    defer decoded.deinit();
    _ = try common.milliseconds(deadline_ns);
    return one(allocator, decoded.value.sender);
}

fn aleo(allocator: A, factory: *@import("scraper/aleo.zig").Factory, http_owner: *@import("../cloud/http.zig").HttpTransport, hash: [64]u8, deadline_ns: u64) ![]Hash {
    const native = try nativeHash(hash);
    var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = http_owner, .deadline_ns = deadline_ns };
    const saved = factory.provider.client.transport;
    try transport.verify(saved);
    factory.provider.client.transport = transport.interface();
    defer factory.provider.client.transport = saved;
    const id = try factory.provider.native.idText(allocator, .transaction, native.short);
    defer allocator.free(id);
    // Rust get_transaction uses the non-optional route: HTTP404 is an error,
    // not a sanctioned empty result.
    var response = try factory.provider.client.get(&.{ "transaction", id }, &.{});
    defer response.deinit();
    const wire = try std.json.Stringify.valueAlloc(allocator, response.value(), .{});
    defer allocator.free(wire);
    var decoder = factory.decoder;
    decoder.limits.timeout_ms = @min(decoder.limits.timeout_ms, try common.milliseconds(deadline_ns));
    var info = try decoder.transactionInfo(allocator, wire);
    defer info.deinit();
    if (!std.mem.eql(u8, &try factory.provider.native.id(.transaction, try json_rpc.string(try json_rpc.field(info.value, "id"))), &native.short)) return error.OriginTransactionIdentityMismatch;
    const value = try json_rpc.field(info.value, "sender");
    if (value != .array or value.array.items.len != 32) return error.InvalidAleoTransactionMetadata;
    var sender: Hash = undefined;
    for (value.array.items, &sender) |item, *byte| byte.* = try json_rpc.integer(u8, item);
    _ = try common.milliseconds(deadline_ns);
    return one(allocator, sender);
}
