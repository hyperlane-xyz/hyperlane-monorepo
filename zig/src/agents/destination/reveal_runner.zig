//! One bounded UR workflow step. The caller holds Factory's monotonic HTTP/KMS
//! scope; no worker, sleep, credential discovery or hidden broadcast is created.
const std = @import("std");
const reveal = @import("reveal.zig");
const queue = @import("reveal_queue.zig");
const types = @import("types.zig");
const operation = @import("operation.zig");
const svm = @import("sealevel.zig");
const provider = @import("../../sealevel/provider.zig");
const tx = @import("../../sealevel/transaction.zig");
const sol = @import("../../altvm/solana.zig");
const protocol = @import("../../protocol/root.zig");
const abi = @import("../../evm/codecs.zig");
const rpc = @import("../../net/json_rpc.zig");
const Store = @import("../store.zig").Store;
const A = std.mem.Allocator;
const Pending = struct { slot: u64, exists: bool, commit_time: i64 = 0 };
fn hard(err: anyerror) bool {
    return @import("../../relayer/metadata.zig").hardFailure(err) or @import("../origin_signers.zig").isControlError(err) or switch (err) {
        error.StaleRevealQueueRow, error.StaleNativeOperationOwner, error.RevealContextChanged, error.OperationContextChanged, error.DestinationAuthorityMismatch => true,
        else => false,
    };
}
fn pending(client: *provider.Client, commit: reveal.Commit, commitment: provider.Commitment, minimum: u64) !Pending {
    const saved = client.commitment;
    const saved_min = client.minimum_slot;
    defer {
        client.commitment = saved;
        client.minimum_slot = saved_min;
    }
    client.commitment = commitment;
    client.minimum_slot = @max(saved_min orelse 0, minimum);
    var response = try client.account((try commit.pending()).key);
    defer response.deinit();
    const account = response.account orelse return .{ .slot = response.slot, .exists = false };
    if (account.executable) return error.ExecutablePendingSwap;
    return .{ .slot = response.slot, .exists = true, .commit_time = try reveal.pendingCommitTime(commit, account.owner, account.data) };
}
fn native(owner: anytype) svm.Sealevel {
    var result = owner.backend.sealevel;
    result.submitter = .rpc; // Source reveals use direct RPC, including Jito destinations.
    result.submit_clients = &.{};
    result.reveal_target = owner.resources.chain.connection.sealevel.ur_reveal.?.program_id;
    return result;
}
fn backoff(failures: u32) u64 {
    return @min(@as(u64, 600000), @as(u64, 30000) << @intCast(@min(@as(u32, 5), failures -| 1)));
}
fn fetch(owner: anytype, loaded: *queue.Loaded, commit: reveal.Commit) !reveal.Ccs {
    const config = owner.resources.chain.connection.sealevel.ur_reveal.?;
    const signer = owner.ccs_digest orelse return error.MissingCcsSigner;
    const a = owner.allocator;
    const digest = try reveal.authenticationHash(a, config.ccs_url, commit, signer.address, owner.options.allow_fixture_transport);
    const signature = if (loaded.value().signature_hex) |text| try abi.fixedHex(65, text) else blk: {
        // Loaded is a complete, already-synchronous public enqueue record.
        // Persist the signature before forwarding it to the configured CCS.
        const signed = try owner.signCcs(digest);
        try loaded.setSignature(signed);
        try loaded.save();
        break :blk signed;
    };
    if (!std.mem.eql(u8, &try protocol.signature.recover(digest, signature), &signer.address)) return error.CcsSignerMismatch;
    var request = try reveal.prepareRead(a, config.ccs_url, commit, signer.address, signature, owner.options.allow_fixture_transport);
    defer request.deinit();
    // Preserve Source's per-CCS 30s cap inside the caller's possibly shorter
    // absolute job budget, and restore this exclusive HTTP owner afterward.
    const http = &owner.resources.http;
    const timeout = http.timeout_ms;
    const connect_timeout = http.connect_timeout_ms;
    defer {
        http.timeout_ms = timeout;
        http.connect_timeout_ms = connect_timeout;
    }
    http.timeout_ms = @min(http.timeout_ms, 30000);
    http.connect_timeout_ms = @min(http.connect_timeout_ms, http.timeout_ms);
    http.last_native_physical_timeout = false;
    defer http.last_native_physical_timeout = false;
    var response = http.interface().send(a, request.request) catch |err| return owner.ccsFailure(err);
    defer response.deinit();
    if (response.status == 404) return error.CcsNotReady;
    if (response.status < 200 or response.status >= 300) return error.CcsHttpFailure;
    return reveal.Ccs.parse(a, commit, response.bytes);
}
fn complete(owner: anytype, loaded: *queue.Loaded, now: operation.Times) !void {
    if (loaded.value().followup_hex) |following| {
        loaded.value().message_hex = following;
        loaded.value().followup_hex = null;
        loaded.value().mode = .reveal;
        loaded.value().phase = .pda_wait;
        loaded.value().cycle = try std.math.add(u64, loaded.value().cycle, 1);
        loaded.value().wait_count = 0;
        loaded.value().token_count = 0;
        loaded.value().failures = 0;
        loaded.value().send_attempts = 0;
        loaded.value().confirm_polls = 0;
        var message = try loaded.message();
        defer message.deinit();
        const id = queue.operationId(loaded.route, loaded.value().cycle, message.value.id());
        loaded.value().operation_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &id);
        loaded.value().boot_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &owner.reveal_boot);
    } else loaded.value().phase = .done;
    loaded.value().request_close = false;
    loaded.schedule(now.unix_ms, 0);
    try loaded.save();
}
fn unsignedWire(compiled: sol.Compiled, out: []u8) ![]const u8 {
    var writer: sol.Writer = .{ .out = out };
    try writer.shortvec(compiled.signer_count);
    for (0..compiled.signer_count) |_| try writer.bytes(&(.{0} ** 64));
    try writer.bytes(compiled.bytes);
    return out[0..writer.pos];
}
fn prepare(owner: anytype, loaded: *queue.Loaded, commit: reveal.Commit, authority: types.Authority, now: operation.Times) !?types.Prepared {
    const a = owner.allocator;
    const client = owner.backend.sealevel.chain.client;
    const saved = client.commitment;
    const saved_min = client.minimum_slot;
    defer {
        client.commitment = saved;
        client.minimum_slot = saved_min;
    }
    client.commitment = .confirmed;
    client.minimum_slot = @max(saved_min orelse 0, loaded.value().minimum_slot);
    const present = try pending(client, commit, .confirmed, loaded.value().minimum_slot);
    if (!present.exists) {
        const finalized = try pending(client, commit, .finalized, loaded.value().minimum_slot);
        if (!finalized.exists) return null;
        return error.PendingSwapPropagation;
    }
    loaded.value().minimum_slot = @max(loaded.value().minimum_slot, present.slot);
    var ccs = try fetch(owner, loaded, commit);
    defer ccs.deinit();
    var instructions: reveal.Instructions = undefined;
    var units: u32 = reveal.reveal_units;
    if (loaded.value().mode == .duplicate_close) {
        if (now.unix_ms / 1000 < @as(u64, @intCast(present.commit_time)) +| reveal.close_expiry_seconds) return error.RevealCloseNotExpired;
        if (ccs.accounts.len <= 14) return error.RevealCloseAccountsUnavailable;
        instructions = try reveal.closeInstructions(a, commit, owner.backend.sealevel.signer.payer, .{ .mint = ccs.accounts[14].key, .token = ccs.accounts[11].key });
        units = reveal.close_units;
    } else {
        var pool: ?reveal.Pool = null;
        if (ccs.accounts.len > 23) {
            var response = try client.account(ccs.accounts[5].key);
            defer response.deinit();
            const account = response.account orelse return error.RevealPoolUnavailable;
            if (account.executable) return error.WrongRevealPoolOwner;
            pool = try reveal.Pool.decode(ccs.accounts[5].key, account.owner, account.data);
            client.minimum_slot = @max(client.minimum_slot orelse 0, response.slot);
        }
        instructions = try reveal.build(a, commit, ccs, owner.backend.sealevel.signer.payer, pool);
        errdefer instructions.deinit();
        if (instructions.values.len == 4) {
            // Never unwrap a pre-existing fee-payer wSOL position for a route.
            const key = try reveal.associated(owner.backend.sealevel.signer.payer, reveal.wsol, reveal.token_program);
            var response = try client.account(key);
            defer response.deinit();
            if (response.account) |account| if (try reveal.tokenBalance(account.owner, reveal.token_program, reveal.wsol, owner.backend.sealevel.signer.payer, account.data) != 0) return error.UnsafeRevealWsolBalance;
        }
        var message: [sol.packet_limit]u8 = undefined;
        const compiled = try sol.compileLegacy(owner.backend.sealevel.signer.payer, .{0} ** 32, instructions.values, &message);
        if (compiled.signer_count != 1) return error.UnconfiguredRevealSigner;
        var wire: [sol.packet_limit]u8 = undefined;
        const simulation = client.simulate(try unsignedWire(compiled, &wire), .replace_blockhash);
        if (simulation) |result| {
            var simulated = result;
            defer simulated.deinit();
            if (!try simulated.succeeded()) {
                const current = try pending(client, commit, .confirmed, loaded.value().minimum_slot);
                if (!current.exists) {
                    const finalized = try pending(client, commit, .finalized, loaded.value().minimum_slot);
                    if (!finalized.exists) {
                        instructions.deinit();
                        return null;
                    }
                    return error.PendingSwapPropagation;
                }
                if (now.unix_ms / 1000 < @as(u64, @intCast(current.commit_time)) +| reveal.close_expiry_seconds) return error.RevealCloseNotExpired;
                const close = instructions.close orelse return error.RevealCloseAccountsUnavailable;
                const closing = try reveal.closeInstructions(a, commit, owner.backend.sealevel.signer.payer, close);
                instructions.deinit();
                instructions = closing;
                units = reveal.close_units;
            }
        } else |err| {
            if (hard(err)) return err;
            // Actual Rust path attempts Reveal on inconclusive simulation RPC.
        }
    }
    defer instructions.deinit();
    var probe_message: [sol.packet_limit]u8 = undefined;
    const probe = try sol.compileLegacy(owner.backend.sealevel.signer.payer, .{0} ** 32, instructions.values, &probe_message);
    if (probe.signer_count != 1) return error.UnconfiguredRevealSigner;
    var probe_wire: [sol.packet_limit]u8 = undefined;
    const price = owner.backend.sealevel.oracle.fee(a, try unsignedWire(probe, &probe_wire)) catch |err| blk: {
        if (hard(err)) return err;
        break :blk 0;
    };
    const lease = try client.latestBlockhash();
    var budget = tx.BudgetInstructions.init(owner.backend.sealevel.signer.payer, .{ .compute_units = units, .compute_unit_price_micro_lamports = price }, .rpc);
    const first = budget.instructions(.rpc, instructions.values[0]);
    var full: [6]sol.Instruction = undefined;
    full[0..2].* = first[0..2].*;
    if (instructions.values.len > 4) return error.InvalidRevealInstructionCount;
    @memcpy(full[2..][0..instructions.values.len], instructions.values);
    var output: [sol.packet_limit]u8 = undefined;
    const compiled = try sol.compileLegacy(owner.backend.sealevel.signer.payer, lease.hash, full[0 .. 2 + instructions.values.len], &output);
    var encoded_wire: [sol.packet_limit]u8 = undefined;
    _ = try unsignedWire(compiled, &encoded_wire); // Full signature packet bound.
    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(compiled.bytes.len));
    defer a.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, compiled.bytes);
    var quoted = try client.call("getFeeForMessage", .{ encoded, .{ .commitment = "confirmed", .minContextSlot = lease.context_slot } });
    defer quoted.deinit();
    const quote = quoted.value();
    const quote_slot = try rpc.integer(u64, try rpc.field(try rpc.field(quote, "context"), "slot"));
    if (quote_slot < lease.context_slot) return error.StaleSvmContext;
    const raw_fee = try rpc.field(quote, "value");
    if (raw_fee == .null) return error.SvmFeeQuoteUnavailable;
    const fee = try rpc.integer(u64, raw_fee);
    const priority: u128 = (@as(u128, units) * price + 999999) / 1000000;
    if (fee < priority) return error.InconsistentSvmFeeQuote;
    if (fee > owner.backend.sealevel.maximum_fee) return error.SvmFeeCapExceeded;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const body = try std.json.Stringify.valueAlloc(temporary, .{ .message = try abi.hexAlloc(temporary, compiled.bytes), .payer = try abi.hexAlloc(temporary, &owner.backend.sealevel.signer.payer), .blockhash = try abi.hexAlloc(temporary, &lease.hash), .last_valid_block_height = lease.last_valid_block_height, .context_slot = lease.context_slot, .gas_limit = units, .fee = fee, .tip_lamports = @as(u64, 0), .maximum_fee = owner.backend.sealevel.maximum_fee, .submitter = "rpc", .action = if (units == reveal.close_units) "close" else "reveal", .pending = try abi.hexAlloc(temporary, &(try commit.pending()).key) }, .{});
    return try types.Prepared.init(a, authority, body, units, fee);
}

fn wait(owner: anytype, loaded: *queue.Loaded, now: operation.Times, err: anyerror) !usize {
    if (hard(err)) return err;
    if (err == error.CcsNotReady and loaded.value().ccs_wait_count < 9) {
        loaded.value().ccs_wait_count += 1;
        loaded.schedule(now.unix_ms, 5000);
    } else if (loaded.value().phase == .pda_wait) {
        loaded.schedule(now.unix_ms, 5000);
    } else if (loaded.value().phase == .tokens) {
        loaded.value().ccs_wait_count = 0;
        loaded.value().token_count +|= 1;
        if (loaded.value().token_count >= 360) {
            loaded.value().phase = .exhausted;
            loaded.value().boot_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &owner.reveal_boot);
        }
        loaded.schedule(now.unix_ms, 5000);
    } else {
        loaded.value().ccs_wait_count = 0;
        loaded.value().failures +|= 1;
        loaded.schedule(now.unix_ms, backoff(loaded.value().failures));
    }
    try loaded.save();
    return 1;
}
pub fn tick(owner: anytype, store: *Store, clock: anytype, now: operation.Times) !usize {
    const a = owner.allocator;
    var loaded = try queue.next(a, store, owner.resources.chain.domain) orelse return 0;
    defer loaded.deinit();
    var message = try loaded.message();
    defer message.deinit();
    const config = owner.resources.chain.connection.sealevel.ur_reveal.?;
    const commit = reveal.Commit.message(config.program_id, message.value) orelse return error.InvalidRevealQueueMessage;
    if (message.value.destination != owner.resources.chain.domain or !std.mem.eql(u8, &loaded.route, &try queue.routeId(message.value.destination, commit))) return error.InvalidRevealQueueMessage;
    const op_id = try abi.fixedHex(32, loaded.value().operation_hex);
    if (!std.mem.eql(u8, &op_id, &queue.operationId(loaded.route, loaded.value().cycle, message.value.id()))) return error.InvalidRevealQueueIdentity;
    const base_authority = try owner.authorityFor(message.value.origin, op_id, 0, .reveal);
    const context = try owner.contextFor(base_authority);
    if (!std.mem.eql(u8, &context, &try abi.fixedHex(32, loaded.value().context_hex))) return error.RevealContextChanged;
    if (loaded.value().phase == .exhausted) {
        if (std.mem.eql(u8, &owner.reveal_boot, &try abi.fixedHex(32, loaded.value().boot_hex))) return 0;
        // Match source restart recovery without losing exhausted work on disk.
        loaded.value().phase = if (loaded.value().mode == .reveal) .pda_wait else .prepare;
        loaded.value().wait_count = 0;
        loaded.value().token_count = 0;
        loaded.value().failures = 0;
        loaded.value().ccs_wait_count = 0;
        loaded.value().boot_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &owner.reveal_boot);
        loaded.schedule(now.unix_ms, 0);
        try loaded.save();
        return 1;
    }
    if (!loaded.due(now.unix_ms)) return 0;
    return step(owner, &loaded, commit, message.value, context, op_id, clock, now) catch |err| try wait(owner, &loaded, now, err);
}
fn step(owner: anytype, loaded: *queue.Loaded, commit: reveal.Commit, message: protocol.Message, context: [32]u8, op_id: [32]u8, _: anytype, now: operation.Times) !usize {
    const a = owner.allocator;
    const client = owner.backend.sealevel.chain.client;
    if (loaded.value().request_close and (loaded.value().phase == .pda_wait or loaded.value().phase == .tokens)) {
        try promoteClose(loaded, message, now);
        return 1;
    }
    switch (loaded.value().phase) {
        .pda_wait => {
            const current = try pending(client, commit, .confirmed, loaded.value().minimum_slot);
            if (current.exists) {
                loaded.value().minimum_slot = @max(loaded.value().minimum_slot, current.slot);
                loaded.value().phase = .tokens;
                loaded.value().wait_count = 0;
                loaded.schedule(now.unix_ms, 0);
            } else {
                const saved = client.commitment;
                const saved_min = client.minimum_slot;
                defer {
                    client.commitment = saved;
                    client.minimum_slot = saved_min;
                }
                client.commitment = .finalized;
                client.minimum_slot = @max(saved_min orelse 0, loaded.value().minimum_slot);
                var history = try client.signatures((try commit.pending()).key, 1, null);
                defer history.deinit();
                const list = history.value();
                if (list != .array) return error.InvalidRevealHistory;
                if (list.array.items.len != 0) {
                    const finalized = try pending(client, commit, .finalized, loaded.value().minimum_slot);
                    if (!finalized.exists) {
                        try complete(owner, loaded, now);
                        return 1;
                    }
                }
                loaded.value().wait_count +|= 1;
                if (loaded.value().wait_count >= 5) {
                    loaded.value().phase = .exhausted;
                    loaded.value().boot_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &owner.reveal_boot);
                }
                loaded.schedule(now.unix_ms, 5000);
            }
            try loaded.save();
            return 1;
        },
        .tokens => {
            const current = try pending(client, commit, .confirmed, loaded.value().minimum_slot);
            if (!current.exists) {
                const finalized = try pending(client, commit, .finalized, loaded.value().minimum_slot);
                if (!finalized.exists) {
                    try complete(owner, loaded, now);
                    return 1;
                }
                return error.PendingSwapPropagation;
            }
            loaded.value().minimum_slot = @max(loaded.value().minimum_slot, current.slot);
            var ccs = try fetch(owner, loaded, commit);
            defer ccs.deinit();
            loaded.value().ccs_wait_count = 0;
            if (ccs.accounts.len <= 14) return error.RevealCloseAccountsUnavailable;
            const saved = client.commitment;
            const saved_min = client.minimum_slot;
            defer {
                client.commitment = saved;
                client.minimum_slot = saved_min;
            }
            client.commitment = .confirmed;
            client.minimum_slot = @max(saved_min orelse 0, loaded.value().minimum_slot);
            const pda = (try commit.pending()).key;
            const mint = ccs.accounts[14].key;
            const token = ccs.accounts[11].key;
            var account = try client.account(try reveal.associated(pda, mint, token));
            defer account.deinit();
            const balance = if (account.account) |value| try reveal.tokenBalance(value.owner, token, mint, pda, value.data) else 0;
            if (balance != 0) {
                loaded.value().phase = .prepare;
                loaded.value().minimum_slot = @max(loaded.value().minimum_slot, account.slot);
                loaded.schedule(now.unix_ms, 0);
            } else {
                loaded.value().token_count +|= 1;
                if (loaded.value().token_count >= 360) {
                    loaded.value().phase = .exhausted;
                    loaded.value().boot_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &owner.reveal_boot);
                }
                loaded.schedule(now.unix_ms, 5000);
            }
            try loaded.save();
            return 1;
        },
        .done, .exhausted => return 0,
        .prepare, .transaction => {},
    }
    const actor = try operation.Operation.open(a, loaded.store, .{ .id = op_id, .context = context, .nonce = message.nonce, .origin = message.origin, .destination = message.destination, .kind = .reveal, .target = commit.program, .policy = .{ .max_retries = std.math.maxInt(u32), .confirm_delay_ms = 2000 } }, now);
    defer actor.deinit();
    if (actor.value.stage == .delivered) {
        try complete(owner, loaded, now);
        return 1;
    }
    if (loaded.value().request_close and actor.signed == null) {
        try actor.setAllowed(false, now);
        try promoteClose(loaded, message, now);
        return 1;
    }
    if (now.monotonic_ms < actor.value.next_attempt_ms) return 0;
    const effect = try actor.tick(now);
    switch (effect) {
        .none => return 0,
        .prepare => |generation| {
            var prepared = if (actor.intent) |bytes| try types.Prepared.restore(a, bytes) else try prepare(owner, loaded, commit, try owner.authorityFor(message.origin, op_id, generation, .reveal), now) orelse {
                try actor.observe(true, true, now);
                try complete(owner, loaded, now);
                return 1;
            };
            defer prepared.deinit();
            try actor.staged(&prepared, now);
            try actor.prepared(&prepared, true, true, now);
            loaded.value().phase = .transaction;
            loaded.value().send_attempts +|= 1;
            loaded.value().confirm_polls = 0;
            loaded.value().ccs_wait_count = 0;
            loaded.value().minimum_slot = @max(loaded.value().minimum_slot, try rpc.integer(u64, try rpc.field(prepared.body, "context_slot")));
            loaded.schedule(now.unix_ms, 0);
            try loaded.save();
            return 1;
        },
        .build => {
            var prepared = try types.Prepared.restore(a, actor.intent orelse return error.MissingNativePreparedIntent);
            defer prepared.deinit();
            const saved = client.commitment;
            defer client.commitment = saved;
            client.commitment = .confirmed;
            if (try client.blockHeight() > try rpc.integer(u64, try rpc.field(prepared.body, "last_valid_block_height"))) {
                try actor.delay(.ErrorEstimatingGas, 0, now);
                loaded.value().phase = .prepare;
                loaded.schedule(now.unix_ms, 0);
            } else {
                var backend = native(owner);
                var signed = try backend.sign(&prepared, actor.persistence(now));
                defer signed.deinit();
                loaded.value().phase = .transaction;
                loaded.schedule(now.unix_ms, 0);
            }
            try loaded.save();
            return 1;
        },
        .broadcast, .reconcile => |identity| {
            const signed = if (actor.signed) |*value| value else return error.MissingPersistedNativeTransaction;
            var prepared = try types.Prepared.restore(a, actor.intent orelse return error.MissingNativePreparedIntent);
            defer prepared.deinit();
            var backend = native(owner);
            const receipt = backend.reconcile(identity) catch |err| blk: {
                if (hard(err)) return err;
                break :blk null;
            };
            if (receipt) |value| {
                if (!types.Identity.eql(value.identity, identity)) return error.WrongNativeReceipt;
                if (value.finalized) {
                    if (value.success) {
                        try actor.observe(true, true, now);
                        try complete(owner, loaded, now);
                    } else {
                        try actor.finalizedFailure(value, now, 0);
                        loaded.value().failures +|= 1;
                        loaded.value().send_attempts = 0;
                        loaded.value().confirm_polls = 0;
                        loaded.value().phase = .prepare;
                        const delay = backoff(loaded.value().failures);
                        try actor.scheduleReveal(delay, now);
                        loaded.schedule(now.unix_ms, delay);
                        try loaded.save();
                    }
                    return 1;
                }
            }
            try backend.validateSigned(&prepared, signed);
            const saved_commitment = client.commitment;
            const saved_min = client.minimum_slot;
            defer {
                client.commitment = saved_commitment;
                client.minimum_slot = saved_min;
            }
            client.commitment = .finalized;
            client.minimum_slot = try client.slot();
            const height = try client.blockHeight();
            const present = try pending(client, commit, .finalized, @max(loaded.value().minimum_slot, client.minimum_slot.?));
            const boundary = try rpc.integer(u64, try rpc.field(prepared.body, "last_valid_block_height"));
            if (height > boundary) {
                try actor.retire(.{ .kind = .reveal, .target = commit.program, .identity = identity, .intent_digest = prepared.digest(), .generation = prepared.authority.generation, .reason = .svm_blockhash_expired, .finalized_height = height, .boundary = boundary, .observed = height }, now, 0);
                if (!present.exists) {
                    try complete(owner, loaded, now);
                    return 1;
                }
                var delay: u64 = 0;
                if (loaded.value().send_attempts >= 3) {
                    loaded.value().send_attempts = 0;
                    loaded.value().failures +|= 1;
                    delay = backoff(loaded.value().failures);
                }
                try actor.scheduleReveal(delay, now);
                loaded.value().phase = .prepare;
                loaded.value().confirm_polls = 0;
                loaded.schedule(now.unix_ms, delay);
                try loaded.save();
                return 1;
            }
            if (present.exists and (loaded.value().confirm_polls == 0 or loaded.value().confirm_polls % 10 == 0)) {
                _ = try actor.rebroadcast(now);
                backend.broadcast(&prepared, signed, actor.persistence(now)) catch |err| {
                    if (hard(err)) return err;
                    try actor.broadcastResult(false, now);
                    try actor.observe(false, false, now);
                    loaded.value().confirm_polls +|= 1;
                    loaded.schedule(now.unix_ms, 2000);
                    try loaded.save();
                    return 1;
                };
                try actor.broadcastResult(true, now);
            }
            // Receipt absence/errors never allocate a fresh signature. A gone
            // PDA may later be recreated, so retain this ID until actual expiry.
            try actor.observe(false, false, now);
            loaded.value().confirm_polls +|= 1;
            loaded.schedule(now.unix_ms, 2000);
            try loaded.save();
            return 1;
        },
    }
}
fn promoteClose(loaded: *queue.Loaded, message: protocol.Message, now: operation.Times) !void {
    loaded.value().mode = .duplicate_close;
    loaded.value().phase = .prepare;
    loaded.value().request_close = false;
    loaded.value().cycle = try std.math.add(u64, loaded.value().cycle, 1);
    const id = queue.operationId(loaded.route, loaded.value().cycle, message.id());
    loaded.value().operation_hex = try abi.hexAlloc(loaded.document.arena.allocator(), &id);
    loaded.value().send_attempts = 0;
    loaded.value().confirm_polls = 0;
    loaded.schedule(now.unix_ms, 0);
    try loaded.save();
}
