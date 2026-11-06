//! Native InvokeV3 account transactions and metadata, with persisted public
//! intent/signed bytes before broadcasting. The account and signer are distinct.
const std = @import("std");
const types = @import("types.zig");
const provider = @import("../../starknet/provider.zig");
const codec = @import("../../starknet/codec.zig");
const contracts = @import("../../starknet/contracts.zig");
const tx = @import("../../starknet/transaction.zig");
const crypto = @import("../../starknet/crypto.zig");
const rpc = @import("../../net/json_rpc.zig");
const protocol = @import("../../protocol/root.zig");
const Felt = codec.Felt;
pub const MetadataSource = contracts.Source;
/// Frozen scalar quote and authority provenance. Every member persists this same
/// ordered manifest; its outer Prepared still belongs to its own operation.
pub const BatchMember = struct {
    operation_id: types.Hash,
    origin: u32,
    origin_hook: ?types.Hash,
    generation: u64,
    source_intent_digest: types.Hash,
    gas_limit: u64,
    estimated_cost: u256,
    pub fn jsonStringify(self: BatchMember, writer: anytype) std.json.Stringify.Error!void {
        try writer.write(.{ .operation_id = std.fmt.bytesToHex(self.operation_id, .lower), .origin = self.origin, .origin_hook = if (self.origin_hook) |hook| std.fmt.bytesToHex(hook, .lower) else null, .generation = self.generation, .source_intent_digest = std.fmt.bytesToHex(self.source_intent_digest, .lower), .gas_limit = self.gas_limit, .estimated_cost = self.estimated_cost });
    }
};
pub const PreparedBatch = struct {
    allocator: std.mem.Allocator,
    members: []types.Prepared,
    gas_limit: u256,
    estimated_cost: u256,
    pub fn deinit(self: *PreparedBatch) void {
        for (self.members) |*member| member.deinit();
        self.allocator.free(self.members);
        self.* = undefined;
    }
};
pub const Starknet = struct {
    chain: contracts.Contracts,
    native: *crypto.Crypto,
    signer: tx.Signer,
    account: Felt,
    chain_id: Felt,
    encoding: tx.Encoding,
    reorg: provider.ReorgPeriod = .none,
    maximum_fee: u256,
    announce: ?Felt = null,
    fn authority(self: *const Starknet, context: types.Authority) !void {
        if (context.protocol != .starknet or context.destination != self.chain.domain or !std.mem.eql(u8, &context.mailbox, &self.chain.mailbox.toBytes()) or (try Felt.fromHex(context.chain_id)).value != self.chain_id.value) return error.DestinationAuthorityMismatch;
        _ = try self.target(context);
    }
    fn target(self: *const Starknet, context: types.Authority) !Felt {
        const address = if (context.kind == .process) self.chain.mailbox else self.announce orelse return error.MissingStarknetAnnounceContract;
        try context.expectTarget(address.toBytes());
        return address;
    }
    pub fn metadata(self: *Starknet, origin: anytype, address: Felt, message: protocol.Message) ![]u8 {
        const Origin = @TypeOf(origin.*);
        var source: contracts.Source(Origin) = .{ .chain = self.chain, .origin = origin };
        var builder: @import("../../relayer/metadata.zig").Builder(@TypeOf(source)) = .{ .allocator = self.chain.provider.allocator, .source = &source };
        return builder.build(address, message);
    }
    pub fn prepare(self: *Starknet, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        var call = try self.chain.process(message, metadata_bytes);
        defer call.deinit();
        return self.prepareCall(context, call.call);
    }
    pub fn prepareAnnouncement(self: *Starknet, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        var call = try self.chain.announcement(try self.target(context), validator, location, signature);
        defer call.deinit();
        return self.prepareCall(context, call.call);
    }
    fn prepareCall(self: *Starknet, context: types.Authority, call: tx.Call) !types.Prepared {
        const a = self.chain.provider.allocator;
        const quote = try self.chain.provider.prepareQuoted(self.native, self.signer, self.chain_id, self.account, &.{call}, self.encoding, self.maximum_fee);
        var transaction = quote.transaction;
        defer transaction.deinit();
        const budget = try std.math.add(u256, try tx.resourceBudget(transaction.bounds), transaction.tip);
        if (budget > self.maximum_fee) return error.StarknetFeeCapExceeded;
        const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = transaction.request(&.{}, false), .public_key = self.signer.public_key, .gas_limit = quote.estimate.l2_gas_consumed, .estimated_cost = budget }, .{});
        defer a.free(body);
        return types.Prepared.init(a, context, body, quote.estimate.l2_gas_consumed, budget);
    }
    /// Restage an unsigned scalar process at submission time. Signed recovery
    /// must use the exact persisted original intent and never call this method.
    pub fn refreshPrepared(self: *Starknet, input: *const types.Prepared) !types.Prepared {
        if (input.authority.kind != .process or hasBatch(input.body)) return error.StarknetBatchIneligible;
        var transaction = try self.restore(input);
        defer transaction.deinit();
        const a = self.chain.provider.allocator;
        const calls = try tx.decodeCalls(a, transaction.calldata, self.encoding, 1);
        defer a.free(calls);
        if (calls.len != 1) return error.StarknetBatchIneligible;
        try self.validateProcess(calls[0], input.authority.operation_id, input.authority.origin);
        return self.prepareCall(input.authority, calls[0]);
    }
    /// Upgrade ready scalar intents to one account multicall. This performs one
    /// fresh nonce/combined query estimate, never executable signing/broadcast.
    /// The caller must atomically journal ALL members before using sign().
    pub fn prepareBatch(self: *Starknet, inputs: []const *const types.Prepared, maximum_members: usize) !PreparedBatch {
        if (inputs.len < 2 or inputs.len > maximum_members or inputs.len > self.chain.provider.max_call_felts / 3) return error.StarknetBatchSize;
        const a = self.chain.provider.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const scratch = arena.allocator();
        const transactions = try scratch.alloc(tx.Transaction, inputs.len);
        var initialized: usize = 0;
        defer for (transactions[0..initialized]) |*transaction| transaction.deinit();
        const calls = try scratch.alloc(tx.Call, inputs.len);
        const manifest = try scratch.alloc(BatchMember, inputs.len);
        var ids: std.AutoHashMapUnmanaged(types.Hash, void) = .empty;
        var weight: u256 = 0;
        var calldata_length: usize = if (self.encoding == .modern) 1 else 2;
        for (inputs, 0..) |input, i| {
            if (input.authority.kind != .process or hasBatch(input.body)) return error.StarknetBatchIneligible;
            transactions[i] = try self.restore(input);
            initialized += 1;
            const decoded = try tx.decodeCalls(scratch, transactions[i].calldata, self.encoding, 1);
            if (decoded.len != 1) return error.StarknetBatchIneligible;
            try self.validateProcess(decoded[0], input.authority.operation_id, input.authority.origin);
            const entry = try ids.getOrPut(scratch, input.authority.operation_id);
            if (entry.found_existing) return error.StarknetBatchDuplicateMember;
            const gas = try rpc.integer(u64, try rpc.field(input.body, "gas_limit"));
            const cost = try rpc.integer(u256, try rpc.field(input.body, "estimated_cost"));
            if ((input.gas_limit != null and input.gas_limit.? != gas) or (input.estimated_cost != null and input.estimated_cost.? != cost)) return error.DestinationIntentChanged;
            weight = try std.math.add(u256, weight, gas);
            calls[i] = decoded[0];
            calldata_length = try std.math.add(usize, calldata_length, try std.math.add(usize, decoded[0].calldata.len, if (self.encoding == .modern) 3 else 4));
            if (calldata_length > self.chain.provider.max_call_felts) return error.StarknetCallTooLarge;
            manifest[i] = .{ .operation_id = input.authority.operation_id, .origin = input.authority.origin, .origin_hook = input.authority.origin_hook, .generation = input.authority.generation, .source_intent_digest = input.digest(), .gas_limit = gas, .estimated_cost = cost };
        }
        // Source's divide-failure fallback can charge the entire fee per member.
        // Keep zero-total candidates scalar instead of inventing a batch weight.
        if (weight == 0) return error.StarknetBatchZeroWeight;
        const quote = try self.chain.provider.prepareQuoted(self.native, self.signer, self.chain_id, self.account, calls, self.encoding, self.maximum_fee);
        var transaction = quote.transaction;
        defer transaction.deinit();
        const budget = try std.math.add(u256, try tx.resourceBudget(transaction.bounds), transaction.tip);
        if (budget > self.maximum_fee) return error.StarknetFeeCapExceeded;
        const members = try a.alloc(types.Prepared, inputs.len);
        var count: usize = 0;
        errdefer {
            for (members[0..count]) |*member| member.deinit();
            a.free(members);
        }
        for (inputs, manifest, 0..) |input, member, i| {
            const body = try std.json.Stringify.valueAlloc(scratch, .{ .transaction = transaction.request(&.{}, false), .public_key = self.signer.public_key, .gas_limit = member.gas_limit, .estimated_cost = member.estimated_cost, .batch_version = @as(u8, 1), .batch_members = manifest, .batch_gas_limit = quote.estimate.l2_gas_consumed, .batch_estimated_cost = budget }, .{});
            members[i] = try types.Prepared.init(a, input.authority, body, member.gas_limit, member.estimated_cost);
            count += 1;
        }
        return .{ .allocator = a, .members = members, .gas_limit = quote.estimate.l2_gas_consumed, .estimated_cost = budget };
    }
    fn validateProcess(self: *Starknet, call: tx.Call, id: types.Hash, origin: u32) !void {
        if (call.to.value != self.chain.mailbox.value or call.selector.value != codec.selector("process").value) return error.DestinationIntentChanged;
        const a = self.chain.provider.allocator;
        var decoder: codec.Decoder = .{ .input = call.calldata };
        const metadata_bytes = try decoder.bytes(a, types.Prepared.max_intent_bytes);
        defer a.free(metadata_bytes);
        const message = try decoder.message(a, types.Prepared.max_intent_bytes);
        defer a.free(message.body);
        try decoder.finish();
        if (message.origin != origin or message.destination != self.chain.domain or !std.mem.eql(u8, &message.id(), &id)) return error.DestinationIntentChanged;
    }
    fn batchMember(self: *Starknet, prepared: *const types.Prepared, transaction: tx.Transaction) !struct { own: BatchMember, total: u256 } {
        if (try rpc.integer(u8, try rpc.field(prepared.body, "batch_version")) != 1 or prepared.authority.kind != .process) return error.StarknetBatchIneligible;
        const value = try rpc.field(prepared.body, "batch_members");
        if (value != .array or value.array.items.len < 2 or value.array.items.len > self.chain.provider.max_call_felts / 3) return error.StarknetBatchSize;
        var arena = std.heap.ArenaAllocator.init(self.chain.provider.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const calls = try tx.decodeCalls(a, transaction.calldata, self.encoding, value.array.items.len);
        if (calls.len != value.array.items.len) return error.DestinationIntentChanged;
        var ids: std.AutoHashMapUnmanaged(types.Hash, void) = .empty;
        var own: ?BatchMember = null;
        var total: u256 = 0;
        for (value.array.items, calls) |item, call| {
            const member = try parseMember(item);
            if ((try ids.getOrPut(a, member.operation_id)).found_existing) return error.StarknetBatchDuplicateMember;
            try self.validateProcess(call, member.operation_id, member.origin);
            total = try std.math.add(u256, total, member.gas_limit);
            if (std.mem.eql(u8, &member.operation_id, &prepared.authority.operation_id)) {
                if (member.origin != prepared.authority.origin or member.generation != prepared.authority.generation or !std.meta.eql(member.origin_hook, prepared.authority.origin_hook)) return error.DestinationIntentChanged;
                own = member;
            }
        }
        if (total == 0) return error.StarknetBatchZeroWeight;
        const member = own orelse return error.DestinationIntentChanged;
        if ((prepared.gas_limit != null and prepared.gas_limit.? != member.gas_limit) or (prepared.estimated_cost != null and prepared.estimated_cost.? != member.estimated_cost)) return error.DestinationIntentChanged;
        if (try rpc.integer(u64, try rpc.field(prepared.body, "gas_limit")) != member.gas_limit or try rpc.integer(u256, try rpc.field(prepared.body, "estimated_cost")) != member.estimated_cost or try rpc.integer(u256, try rpc.field(prepared.body, "batch_estimated_cost")) != try std.math.add(u256, try tx.resourceBudget(transaction.bounds), transaction.tip) or try rpc.integer(u64, try rpc.field(prepared.body, "batch_gas_limit")) > transaction.bounds.l2_gas.max_amount) return error.DestinationIntentChanged;
        return .{ .own = member, .total = total };
    }
    /// Checks the complete ordered group as well as each intrinsic intent. The
    /// runtime additionally validates source_intent_digest against its old state.
    pub fn validateBatch(self: *Starknet, members: []const types.Prepared) !void {
        if (members.len < 2) return error.StarknetBatchSize;
        var arena = std.heap.ArenaAllocator.init(self.chain.provider.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const first = &members[0];
        const manifest = try rpc.field(first.body, "batch_members");
        if (manifest != .array or manifest.array.items.len != members.len) return error.DestinationIntentChanged;
        const common = [_][]const u8{ "transaction", "public_key", "batch_version", "batch_members", "batch_gas_limit", "batch_estimated_cost" };
        var expected: [common.len][]const u8 = undefined;
        for (common, 0..) |name, i| expected[i] = try std.json.Stringify.valueAlloc(a, try rpc.field(first.body, name), .{});
        for (members, manifest.array.items) |*prepared, member| {
            var transaction = try self.restore(prepared);
            defer transaction.deinit();
            if (!std.mem.eql(u8, &(try parseMember(member)).operation_id, &prepared.authority.operation_id)) return error.DestinationIntentChanged;
            for (common, expected) |name, bytes| {
                if (!std.mem.eql(u8, bytes, try std.json.Stringify.valueAlloc(a, try rpc.field(prepared.body, name), .{}))) return error.DestinationIntentChanged;
            }
        }
    }
    /// Canonical/finality evidence remains shared; only actual expenditure is
    /// apportioned. u512 avoids overflow even for a maximal u256 actual fee.
    pub fn memberReceipt(self: *Starknet, prepared: *const types.Prepared, whole: types.Receipt) !types.Receipt {
        if (whole.identity != .hash256) return error.DestinationIntentChanged;
        var transaction = try self.restore(prepared);
        defer transaction.deinit();
        if (!std.mem.eql(u8, &whole.identity.hash256, &(try transaction.hash(self.native, false)).toBytes())) return error.DestinationIntentChanged;
        const member = try self.batchMember(prepared, transaction);
        var result = whole;
        if (whole.expenditure) |spent| result.expenditure = .{ .gas_used = share(spent.gas_used, member.own.gas_limit, member.total), .tokens_used = share(spent.tokens_used, member.own.gas_limit, member.total) };
        return result;
    }
    fn restore(self: *Starknet, prepared: *const types.Prepared) !tx.Transaction {
        try prepared.validate();
        try self.authority(prepared.authority);
        const object = try rpc.field(prepared.body, "transaction");
        if ((try provider.felt(try rpc.field(prepared.body, "public_key"))).value != self.signer.public_key.value or !std.mem.eql(u8, try rpc.string(try rpc.field(object, "type")), "INVOKE") or (try provider.felt(try rpc.field(object, "version"))).value != 3 or (try provider.felt(try rpc.field(object, "sender_address"))).value != self.account.value) return error.DestinationIntentChanged;
        for ([_][]const u8{ "paymaster_data", "account_deployment_data", "signature" }) |name| {
            const value = try rpc.field(object, name);
            if (value != .array or value.array.items.len != 0) return error.UnsupportedStarknetTransaction;
        }
        for ([_][]const u8{ "nonce_data_availability_mode", "fee_data_availability_mode" }) |name| if (!std.mem.eql(u8, try rpc.string(try rpc.field(object, name)), "L1")) return error.UnsupportedStarknetTransaction;
        const raw = try provider.feltArray(self.chain.provider.allocator, try rpc.field(object, "calldata"), self.chain.provider.max_call_felts);
        errdefer self.chain.provider.allocator.free(raw);
        const bounds = try rpc.field(object, "resource_bounds");
        const actual = tx.Bounds{ .l1_gas = try resource(try rpc.field(bounds, "l1_gas")), .l2_gas = try resource(try rpc.field(bounds, "l2_gas")), .l1_data_gas = try resource(try rpc.field(bounds, "l1_data_gas")) };
        const tip = try (try provider.felt(try rpc.field(object, "tip"))).integer(u64);
        if (try std.math.add(u256, try tx.resourceBudget(actual), tip) > self.maximum_fee) return error.StarknetFeeCapExceeded;
        const transaction: tx.Transaction = .{ .allocator = self.chain.provider.allocator, .calldata = raw, .chain_id = self.chain_id, .sender = self.account, .nonce = try provider.felt(try rpc.field(object, "nonce")), .bounds = actual, .tip = tip };
        if (hasBatch(prepared.body)) _ = try self.batchMember(prepared, transaction);
        return transaction;
    }
    pub fn sign(self: *Starknet, prepared: *const types.Prepared, persistence: types.Persistence) !types.Signed {
        var transaction = try self.restore(prepared);
        defer transaction.deinit();
        try persistence.intent(prepared);
        const signature = try transaction.sign(self.native, self.signer, false);
        const a = self.chain.provider.allocator;
        const bytes = try std.json.Stringify.valueAlloc(a, transaction.request(&signature.signature, false), .{});
        defer a.free(bytes);
        var signed = try types.Signed.init(a, .{ .hash256 = signature.hash.toBytes() }, bytes);
        errdefer signed.deinit();
        try persistence.signed(prepared, &signed);
        return signed;
    }
    pub fn broadcast(self: *Starknet, prepared: *const types.Prepared, signed: *const types.Signed, persistence: types.Persistence) !void {
        var validated = try self.signedTransaction(prepared, signed);
        defer validated.transaction.deinit();
        try persistence.signed(prepared, signed);
        _ = try self.chain.provider.broadcast(self.native, validated.transaction, validated.signature);
    }
    pub fn validateSigned(self: *Starknet, prepared: *const types.Prepared, signed: *const types.Signed) !void {
        var validated = try self.signedTransaction(prepared, signed);
        validated.transaction.deinit();
    }
    /// An announcement retirement proof must refer to this exact announced
    /// validator/location/signature, rather than merely any valid Invoke nonce.
    pub fn validateAnnouncementSigned(self: *Starknet, prepared: *const types.Prepared, signed: *const types.Signed, validator: [20]u8, location: []const u8, signature: [65]u8) !Felt {
        if (prepared.authority.kind != .announcement) return error.AnnouncementAuthorityMismatch;
        var validated = try self.signedTransaction(prepared, signed);
        defer validated.transaction.deinit();
        const target_address = try self.target(prepared.authority);
        var expected = try self.chain.announcement(target_address, validator, location, signature);
        defer expected.deinit();
        const calldata = try tx.encodeCalls(self.chain.provider.allocator, &.{expected.call}, self.encoding);
        defer self.chain.provider.allocator.free(calldata);
        if (calldata.len != validated.transaction.calldata.len) return error.AnnouncementAuthorityMismatch;
        for (calldata, validated.transaction.calldata) |wanted, actual| if (wanted.value != actual.value) return error.AnnouncementAuthorityMismatch;
        return target_address;
    }
    fn signedTransaction(self: *Starknet, prepared: *const types.Prepared, signed: *const types.Signed) !struct { transaction: tx.Transaction, signature: tx.Signed } {
        if (signed.identity != .hash256) return error.WrongDestinationIdentity;
        var transaction = try self.restore(prepared);
        errdefer transaction.deinit();
        const hash = try transaction.hash(self.native, false);
        if (!std.mem.eql(u8, &hash.toBytes(), &signed.identity.hash256)) return error.DestinationIntentChanged;
        var parsed = try std.json.parseFromSlice(rpc.Value, self.chain.provider.allocator, signed.bytes, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        const object = parsed.value;
        const signatures = try rpc.field(object, "signature");
        if (signatures != .array or signatures.array.items.len != 2) return error.InvalidStarknetSignature;
        const signature: tx.Signed = .{ .hash = hash, .public_key = self.signer.public_key, .signature = .{ try provider.felt(signatures.array.items[0]), try provider.felt(signatures.array.items[1]) }, .query_only = false };
        try transaction.validateSigned(self.native, signature);
        const expected = try std.json.Stringify.valueAlloc(self.chain.provider.allocator, transaction.request(&signature.signature, false), .{});
        defer self.chain.provider.allocator.free(expected);
        if (!std.mem.eql(u8, expected, signed.bytes)) return error.DestinationIntentChanged;
        return .{ .transaction = transaction, .signature = signature };
    }
    /// Consensus-bound account nonce consumption. Mailbox completion alone
    /// cannot retire a retained signed account nonce after a reorg.
    pub fn nonceProof(self: *Starknet, prepared: *const types.Prepared, signed: *const types.Signed, at: ?types.RetirementProof, require_absence: bool) !?types.RetirementProof {
        var validated = try self.signedTransaction(prepared, signed);
        defer validated.transaction.deinit();
        const transaction = validated.transaction;
        if (prepared.authority.kind == .process and !hasBatch(prepared.body)) {
            const calls = try tx.decodeCalls(self.chain.provider.allocator, transaction.calldata, self.encoding, 1);
            defer self.chain.provider.allocator.free(calls);
            if (calls.len != 1) return error.DestinationIntentChanged;
            try self.validateProcess(calls[0], prepared.authority.operation_id, prepared.authority.origin);
        }
        const finalized_height = try self.chain.provider.height(self.reorg);
        const height = if (at) |proof| proof.finalized_height else finalized_height;
        if (height > finalized_height) return null;
        const before = self.chain.provider.header(.{ .number = height }) catch |err| {
            if (err == error.UnconfirmedStarknetBlock) return null;
            return err;
        };
        if (at) |proof| {
            if (proof.reason != .starknet_nonce_superseded or !types.Identity.eql(proof.identity, signed.identity) or proof.nonce_account == null or !std.mem.eql(u8, &proof.nonce_account.?, &transaction.sender.toBytes()) or proof.nonce_boundary == null or !std.mem.eql(u8, &proof.nonce_boundary.?, &transaction.nonce.toBytes()) or proof.finalized_block_hash == null or !std.mem.eql(u8, &proof.finalized_block_hash.?, &before.hash.toBytes()) or proof.nonce_observed == null) return error.InvalidStarknetNonceProof;
        }
        const observed = try self.chain.provider.nonce(transaction.sender, .{ .number = height });
        if (observed.value <= transaction.nonce.value) return null;
        if (at) |proof| if (!std.mem.eql(u8, &proof.nonce_observed.?, &observed.toBytes())) return error.InvalidStarknetNonceProof;
        // Any present result (including a pending receipt) excludes retirement.
        // Only the protocol's typed transaction-not-found code establishes this
        // absence; provider errors and malformed responses propagate unchanged.
        if (try self.chain.provider.receiptEnvelope(try Felt.fromBytes(signed.identity.hash256))) |response| {
            var present = response;
            present.deinit();
            return null;
        }
        if (require_absence) {
            if (prepared.authority.kind != .process) return error.ProcessOperationRequired;
            var pinned = self.chain;
            pinned.block = .{ .number = height };
            if (try pinned.delivered(prepared.authority.operation_id)) return null;
        }
        const after = try self.chain.provider.header(.{ .number = height });
        if (after.hash.value != before.hash.value) return error.NoncanonicalStarknetReceipt;
        return .{ .kind = prepared.authority.kind, .target = prepared.authority.target, .identity = signed.identity, .intent_digest = prepared.digest(), .generation = prepared.authority.generation, .reason = .starknet_nonce_superseded, .finalized_height = height, .finalized_block_hash = before.hash.toBytes(), .boundary = 0, .observed = 0, .nonce_account = transaction.sender.toBytes(), .nonce_boundary = transaction.nonce.toBytes(), .nonce_observed = observed.toBytes(), .absence_checked = require_absence };
    }
    pub fn reconcile(self: *Starknet, identity: types.Identity) !?types.Receipt {
        if (identity != .hash256) return error.WrongDestinationIdentity;
        const actual = try self.chain.provider.canonicalReceipt(try Felt.fromBytes(identity.hash256)) orelse return null;
        return .{ .identity = identity, .block_hash = actual.block_hash.toBytes(), .height = actual.block_number, .success = actual.success, .finalized = actual.block_number <= try self.chain.provider.height(self.reorg), .expenditure = .{ .gas_used = actual.actual_fee, .tokens_used = actual.actual_fee } };
    }
};
fn hasBatch(body: rpc.Value) bool {
    return body == .object and (body.object.contains("batch_members") or body.object.contains("batch_version"));
}
fn hashValue(value: rpc.Value) !types.Hash {
    const text = try rpc.string(value);
    if (text.len != 64) return error.InvalidDestinationIntent;
    var hash: types.Hash = undefined;
    _ = std.fmt.hexToBytes(&hash, text) catch return error.InvalidDestinationIntent;
    return hash;
}
fn parseMember(value: rpc.Value) !BatchMember {
    const hook = try rpc.field(value, "origin_hook");
    return .{ .operation_id = try hashValue(try rpc.field(value, "operation_id")), .origin = try rpc.integer(u32, try rpc.field(value, "origin")), .origin_hook = if (hook == .null) null else try hashValue(hook), .generation = try rpc.integer(u64, try rpc.field(value, "generation")), .source_intent_digest = try hashValue(try rpc.field(value, "source_intent_digest")), .gas_limit = try rpc.integer(u64, try rpc.field(value, "gas_limit")), .estimated_cost = try rpc.integer(u256, try rpc.field(value, "estimated_cost")) };
}
fn share(fee: u256, weight: u64, total: u256) u256 {
    return @intCast(@as(u512, fee) * weight / total);
}
fn resource(value: rpc.Value) !tx.Resource {
    return .{ .max_amount = try (try provider.felt(try rpc.field(value, "max_amount"))).integer(u64), .max_price_per_unit = try (try provider.felt(try rpc.field(value, "max_price_per_unit"))).integer(u128) };
}

const Journal = struct {
    intents: usize = 0,
    signed_count: usize = 0,
    fail_intent: bool = false,
    fn intent(context: *anyopaque, _: types.Hash, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        if (self.fail_intent) return error.FixturePersistenceFailed;
        self.intents += 1;
    }
    fn signed(context: *anyopaque, _: types.Hash, identity: types.Identity, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        try std.testing.expect(self.intents > 0 and identity == .hash256);
        self.signed_count += 1;
    }
    fn interface(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
};
test "Starknet destination restores canonical Invoke intent and persists native signed hash before broadcast" {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch return error.SkipZigTest;
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var secret: [32]u8 = .{0} ** 32;
    secret[31] = 17;
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = secret };
    defer local.deinit();
    const signer = try local.interface();
    var steps = [_]@import("../../cloud/testing.zig").Step{.{ .method = .POST, .suffix = "/rpc", .response = "" }};
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &steps };
    var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, network.transport(), &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    var destination: Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = signer, .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000 };
    const context: types.Authority = .{ .protocol = .starknet, .origin = 100, .destination = 200, .mailbox = (try Felt.init(2)).toBytes(), .chain_id = "0x1", .operation_id = .{7} ** 32 };
    var transaction = try tx.Transaction.init(a, destination.chain_id, destination.account, try Felt.init(5), .{ .l1_gas = .{ .max_amount = 2, .max_price_per_unit = 3 } }, &.{.{ .to = destination.chain.mailbox, .selector = codec.selector("process"), .calldata = &.{} }}, .modern);
    defer transaction.deinit();
    const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = transaction.request(&.{}, false), .public_key = signer.public_key }, .{});
    defer a.free(body);
    var prepared = try types.Prepared.init(a, context, body, 1, 6);
    defer prepared.deinit();
    var journal: Journal = .{ .fail_intent = true };
    try std.testing.expectError(error.FixturePersistenceFailed, destination.sign(&prepared, journal.interface()));
    journal.fail_intent = false;
    var signed = try destination.sign(&prepared, journal.interface());
    defer signed.deinit();
    const response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 1, .result = .{ .transaction_hash = try Felt.fromBytes(signed.identity.hash256) } }, .{});
    defer a.free(response);
    steps[0].response = response;
    try destination.broadcast(&prepared, &signed, journal.interface());
    try std.testing.expectEqual(@as(usize, 2), journal.signed_count);
    signed.bytes[0] = '[';
    try std.testing.expectError(error.SyntaxError, destination.broadcast(&prepared, &signed, journal.interface()));
    try network.expectDone();
    // Instantiate full preparation/reconciliation too: wrong authority rejects
    // before either operation can issue network requests.
    var wrong = context;
    wrong.destination = 201;
    try std.testing.expectError(error.DestinationAuthorityMismatch, destination.prepare(wrong, .{}, ""));
    try std.testing.expectError(error.WrongDestinationIdentity, destination.reconcile(.{ .signature512 = .{0} ** 64 }));
}

test "Starknet batch fee allocation generated floor conservation seed 0x6261746368666565 cases 1024" {
    var generator = std.Random.DefaultPrng.init(0x6261746368666565);
    const random = generator.random();
    for (0..1024) |case| {
        var weights: [32]u64 = undefined;
        const count = 2 + random.uintLessThan(usize, 31);
        var total: u256 = 0;
        for (weights[0..count], 0..) |*weight, i| {
            weight.* = if (i == 0) 1 else if (case % 3 == 0 and i % 2 == 1) 0 else random.int(u64);
            total += weight.*;
        }
        if (case == 0) {
            @memset(weights[0..count], std.math.maxInt(u64));
            total = @as(u256, std.math.maxInt(u64)) * count;
        }
        const fee: u256 = switch (case) {
            0 => std.math.maxInt(u256),
            1 => 0,
            2 => 1,
            else => random.int(u256),
        };
        var sum: u512 = 0;
        for (weights[0..count]) |weight| {
            const allocated = share(fee, weight, total);
            sum += allocated;
            // Independently characterize a floor by its bounding interval;
            // conservation catches accidentally charging a full fee per member.
            const numerator = @as(u512, fee) * weight;
            try std.testing.expect(@as(u512, allocated) * total <= numerator);
            try std.testing.expect((@as(u512, allocated) + 1) * total > numerator);
            if (weight == 0) try std.testing.expectEqual(@as(u256, 0), allocated);
        }
        try std.testing.expect(sum <= fee);
        try std.testing.expect(@as(u512, fee) - sum < count);
    }
}
test {
    _ = @import("starknet_batch_testing.zig");
}
