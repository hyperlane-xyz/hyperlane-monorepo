//! Executable integration fixture. Static public test key; loopback Anvil only.
//! Tests actual Solidity contracts and the same durable/protocol/source code.
const std = @import("std");
const agents = @import("agents");
const evm = agents.evm;
const protocol = agents.protocol;
const fixture_key: [32]u8 = @splat(0x11);
const Config = struct {
    rpc_url: []const u8,
    origin_domain: u32,
    destination_domain: u32,
    origin_hook: []const u8,
    origin_mailbox: []const u8,
    destination_mailbox: []const u8,
    state_dir: []const u8,
    messages: []const []const u8,
    message_index: usize,
    reserve_only: bool = false,
    ccip_ism: ?[]const u8 = null,
};

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const args = try std.process.argsAlloc(allocator);
    if (args.len != 2) return error.ExpectedFixtureConfig;
    const config_bytes = try std.fs.cwd().readFileAlloc(allocator, args[1], 1024 * 1024);
    const parsed = try std.json.parseFromSlice(Config, allocator, config_bytes, .{});
    const config = parsed.value;
    if (!std.mem.startsWith(u8, config.rpc_url, "http://127.0.0.1:")) return error.LoopbackFixtureOnly;
    if (config.message_index >= config.messages.len or config.messages.len > 1024) return error.InvalidFixtureMessages;
    var client = try evm.RpcClient.init(allocator, config.rpc_url, .{});
    defer client.deinit();
    try client.checkChain(31337);
    const hook = try evm.codecs.fixedHex(20, config.origin_hook);
    var hook_hash: [32]u8 = @splat(0);
    hook_hash[12..32].* = hook;
    const mailbox = try evm.codecs.fixedHex(20, config.destination_mailbox);
    const origin_mailbox = try evm.codecs.fixedHex(20, config.origin_mailbox);
    const signer = try protocol.signature.secretKeyAddress(fixture_key);
    const leaves = try allocator.alloc([32]u8, config.messages.len);
    const messages = try allocator.alloc(protocol.Message, config.messages.len);
    var tree = protocol.IncrementalMerkle.init();
    var parent = try std.fs.cwd().openDir(config.state_dir, .{});
    defer parent.close();
    var store = try agents.storage.LocalStore.open(allocator, parent, "checkpoints", .{ .read_only = false, .signer = signer });
    defer store.deinit();
    for (config.messages, 0..) |hex, index| {
        const raw = if (std.mem.startsWith(u8, hex, "0x")) hex[2..] else hex;
        const bytes = try allocator.alloc(u8, raw.len / 2);
        _ = try std.fmt.hexToBytes(bytes, raw);
        messages[index] = try protocol.Message.decode(bytes);
        if (messages[index].origin != config.origin_domain or messages[index].destination != config.destination_domain) return error.WrongFixtureDomain;
        leaves[index] = messages[index].id();
        try tree.ingest(leaves[index]);
        const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = hook_hash, .mailbox_domain = config.origin_domain, .root = tree.root(), .index = @intCast(index), .message_id = leaves[index] };
        _ = try store.signAndWriteCheckpoint(checkpoint, fixture_key, null, 0);
    }
    const onchain = try client.latestCheckpoint(hook, .latest);
    if (onchain.index != leaves.len - 1 or !std.mem.eql(u8, &onchain.root, &tree.root())) return error.OnchainMerkleMismatch;
    var indexer = try evm.indexer.Indexer.init(allocator, &client, .{ .chain_id = 31337, .domain = config.origin_domain, .mailbox = origin_mailbox, .hook = hook, .paymaster = @splat(0), .reorg_period = .none });
    try indexer.check();
    const dispatch_tip = try indexer.countTip(.dispatch);
    const insertion_tip = try indexer.countTip(.insertion);
    if (dispatch_tip.count != @as(?u32, @intCast(messages.len)) or insertion_tip.count != @as(?u32, @intCast(leaves.len))) return error.IndexedCountMismatch;
    var dispatch_batch = try indexer.fetch(.dispatch, .{ .from = 0, .to = dispatch_tip.tip }, dispatch_tip.tip);
    defer dispatch_batch.deinit();
    var insertion_batch = try indexer.fetch(.insertion, .{ .from = 0, .to = insertion_tip.tip }, insertion_tip.tip);
    defer insertion_batch.deinit();
    if (dispatch_batch.logs.len != messages.len or insertion_batch.logs.len != leaves.len) return error.IndexedBatchMismatch;
    for (dispatch_batch.logs, messages) |log, expected| {
        const actual = try protocol.Message.decode((try log.event()).dispatch.message);
        if (!std.mem.eql(u8, &actual.id(), &expected.id())) return error.IndexedMessageMismatch;
    }
    for (insertion_batch.logs, leaves, 0..) |log, expected, index| {
        const actual = (try log.event()).insertion;
        if (actual.index != index or !std.mem.eql(u8, &actual.message_id, &expected)) return error.IndexedLeafMismatch;
    }
    try store.writeLatestIndex(onchain.index);
    const stores = [_]agents.evm_metadata_source.CheckpointStore{.{ .validator = signer, .store = &store }};
    var origin: agents.evm_metadata_source.LocalOrigin = .{ .allocator = allocator, .leaves = leaves, .stores = &stores };
    const Source = agents.evm_metadata_source.Source(agents.evm_metadata_source.LocalOrigin);
    const block_number = try client.blockNumber();
    var source: Source = .{ .allocator = allocator, .client = &client, .block_number = block_number, .origin = &origin };
    var builder: agents.metadata_builder.Builder(Source) = .{ .allocator = allocator, .source = &source };
    const message = messages[config.message_index];
    if (config.ccip_ism) |ccip_address| {
        const address = try evm.codecs.fixedHex(20, ccip_address);
        if (try source.moduleType(address) != .ccip_read) return error.WrongCcipModule;
        var lookup = try source.offchainLookup(address, message);
        defer lookup.deinit();
        const encoded = try message.encodeAlloc(allocator);
        defer allocator.free(encoded);
        if (!std.mem.eql(u8, lookup.extra_data, encoded) or lookup.urls.len != 1 or lookup.call_data.len != 0 or
            !std.mem.eql(u8, &lookup.callback_function, &evm.codecs.selector("verify(bytes,bytes)"))) return error.CcipRevertMismatch;
        var request = try agents.ccip_read.prepare(allocator, lookup, lookup.urls[0], null, null, null, null);
        defer request.deinit();
        if (request.request.method != .get or request.request.body != null or !request.request.public_only) return error.CcipRequestMismatch;
    }
    const id = message.id();
    const context_bytes = try std.json.Stringify.valueAlloc(allocator, .{ .chain_id = 31337, .origin_domain = config.origin_domain, .destination_domain = config.destination_domain, .mailbox = mailbox, .origin_hook = hook, .signer = signer }, .{});
    var context_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(context_bytes, &context_hash, .{});
    const path = try std.fmt.allocPrint(allocator, "op-{d}.wal", .{config.message_index});
    var operation = try agents.durable_relayer.DurableOperation.open(allocator, parent, path, id, .{ .confirm_delay_ms = 0 }, false, context_hash);
    defer operation.close();
    if (operation.operation.stage == .delivered) {
        if (!try client.delivered(mailbox, id, .latest)) return error.DurableDeliveryMismatch;
        return emit(allocator, .{ .stage = "already_delivered", .id = id });
    }
    if (operation.operation.transaction == null) {
        _ = try operation.apply(.{ .tick = .{ .now_ms = 0 } });
        if (!std.mem.allEqual(u8, message.recipient[0..12], 0)) return error.InvalidEvmRecipient;
        const ism = try client.recipientIsm(mailbox, message.recipient[12..32].*, .{ .number = block_number });
        const metadata = try builder.build(ism, message);
        _ = try source.verify(ism, message, metadata);
        _ = try operation.apply(.{ .prepared = .{ .generation = operation.operation.generation, .gas_allowed = true, .metadata_valid = true } });
        const encoded = try message.encodeAlloc(allocator);
        const calldata = try evm.codecs.processCalldata(allocator, metadata, encoded);
        const from = try evm.codecs.hexAlloc(allocator, &signer);
        const to = try evm.codecs.hexAlloc(allocator, &mailbox);
        const data = try evm.codecs.hexAlloc(allocator, calldata);
        var nonce_response = try client.call("eth_getTransactionCount", .{ from, "pending" });
        defer nonce_response.deinit();
        var gas_response = try client.call("eth_estimateGas", .{.{ .from = from, .to = to, .data = data }});
        defer gas_response.deinit();
        const transaction: evm.transaction.Transaction = .{ .eip1559 = .{
            .chain_id = 31337,
            .nonce = try quantity(nonce_response.value()),
            .max_priority_fee_per_gas = 1_000_000_000,
            .max_fee_per_gas = 5_000_000_000,
            .gas_limit = try quantity(gas_response.value()),
            .to = mailbox,
            .data = calldata,
        } };
        var signed = try transaction.sign(allocator, fixture_key, null);
        defer signed.deinit();
        _ = try operation.recordTransaction(operation.operation.generation, signed.bytes);
    }
    const transaction_id = operation.operation.transaction orelse return error.MissingFixtureTransaction;
    if (config.reserve_only) return emit(allocator, .{ .stage = "reserved", .id = id, .transaction = transaction_id });
    const tx_hex = try evm.codecs.hexAlloc(allocator, &transaction_id);
    var receipt = try client.call("eth_getTransactionReceipt", .{tx_hex});
    defer receipt.deinit();
    if (receipt.value() == .null) {
        _ = try operation.apply(.{ .rebroadcast = .{ .transaction = transaction_id } });
        const raw = try evm.codecs.hexAlloc(allocator, operation.transaction_bytes orelse return error.MissingDurableBytes);
        var response = try client.call("eth_sendRawTransaction", .{raw});
        defer response.deinit();
        if (response.value() != .string or !std.mem.eql(u8, &try evm.codecs.fixedHex(32, response.value().string), &transaction_id)) return error.TransactionIdMismatch;
        _ = try operation.apply(.{ .broadcast_result = .{ .transaction = transaction_id, .accepted = true } });
    }
    var confirmed = false;
    for (0..50) |_| {
        if (try client.delivered(mailbox, id, .latest)) {
            confirmed = true;
            break;
        }
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    if (!confirmed) return error.DeliveryNotObserved;
    _ = try operation.apply(.{ .delivery_observed = .{ .transaction = transaction_id, .finalized = true, .delivered = true, .now_ms = 1 } });
    try emit(allocator, .{ .stage = "delivered", .id = id, .transaction = transaction_id, .metadata_source_errors = builder.diagnostics.storage_errors });
}

fn quantity(value: std.json.Value) !u64 {
    if (value != .string) return error.InvalidFixtureQuantity;
    return evm.codecs.quantity(value.string);
}
fn emit(allocator: std.mem.Allocator, value: anytype) !void {
    const output = try std.json.Stringify.valueAlloc(allocator, value, .{});
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
