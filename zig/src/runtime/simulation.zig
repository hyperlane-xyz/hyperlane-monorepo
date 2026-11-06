//! Deterministic fault simulation over the same operation transitions used by
//! the durable driver. Reproduce with the seed and pinned compiler/source.
const std = @import("std");
const relayer = @import("relayer.zig");
const scraper = @import("scraper.zig");
pub const Result = struct { seed: u64, steps: u64, crashes: u64, stale_responses: u64, broadcasts: u64, delivered: bool, trace_digest: [32]u8 };

pub fn run(seed: u64, max_steps: u64) !Result {
    if (max_steps == 0 or max_steps > 1_000_000) return error.InvalidStepLimit;
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    var id: [32]u8 = undefined;
    random.bytes(&id);
    var op: relayer.Operation = .{ .id = id, .policy = .{ .confirm_delay_ms = 10 } };
    var durable = op;
    var now: u64 = 0;
    var result: Result = .{ .seed = seed, .steps = 0, .crashes = 0, .stale_responses = 0, .broadcasts = 0, .delivered = false, .trace_digest = @splat(0) };
    var trace = std.crypto.hash.sha2.Sha256.init(.{});
    var transaction: ?[32]u8 = null;
    var remote_accepted = false;
    var remote_finalized = false;
    while (result.steps < max_steps and op.stage != .delivered) {
        result.steps += 1;
        now +|= random.intRangeAtMost(u64, 1, 120_000);
        if (random.uintLessThan(u8, 5) == 0) {
            op = durable;
            result.crashes += 1;
        }
        const old = op;
        const event: relayer.Event = switch (op.stage) {
            .pending => .{ .tick = .{ .now_ms = now } },
            .preparing => if (random.uintLessThan(u8, 4) == 0)
                .{ .retry = .{ .generation = op.generation, .reason = if (random.boolean()) .awaiting_signatures else .transient, .now_ms = now, .jitter = random.int(u64) } }
            else
                .{ .prepared = .{ .generation = if (random.uintLessThan(u8, 8) == 0) op.generation - 1 else op.generation, .gas_allowed = true, .metadata_valid = true } },
            .ready => blk: {
                var tx: [32]u8 = undefined;
                random.bytes(&tx);
                break :blk .{ .transaction_built = .{ .generation = op.generation, .transaction = tx } };
            },
            .submitting => .{ .broadcast_result = .{ .transaction = op.transaction.?, .accepted = remote_accepted } },
            .confirming => if (random.uintLessThan(u8, 3) == 0)
                .{ .tick = .{ .now_ms = now } }
            else if (!remote_accepted and random.boolean())
                .{ .rebroadcast = .{ .transaction = op.transaction.? } }
            else
                .{ .delivery_observed = .{ .transaction = op.transaction.?, .delivered = remote_accepted, .finalized = remote_finalized, .now_ms = now } },
            .denied => .allow,
            .delivered => unreachable,
        };
        const effect = op.apply(event) catch |err| switch (err) {
            error.StaleResponse => {
                result.stale_responses += 1;
                try std.testing.expectEqualDeep(old, op);
                continue;
            },
            else => return err,
        };
        // WAL commit succeeds; any crash after this boundary preserves state.
        durable = op;
        var encoded: [40]u8 = undefined;
        std.mem.writeInt(u64, encoded[0..8], result.steps, .little);
        encoded[8] = @intFromEnum(op.stage);
        std.mem.writeInt(u64, encoded[9..17], op.generation, .little);
        std.mem.writeInt(u64, encoded[17..25], op.next_attempt_ms, .little);
        std.mem.writeInt(u32, encoded[25..29], op.retries, .little);
        encoded[29] = @intFromEnum(effect);
        @memset(encoded[30..], 0);
        trace.update(&encoded);
        if (random.uintLessThan(u8, 6) == 0) {
            op = durable;
            result.crashes += 1;
            continue; // Simulate losing an effect after durable commit.
        }
        switch (effect) {
            .broadcast => |tx| {
                if (transaction) |previous| {
                    if (!std.mem.eql(u8, &previous, &tx)) return error.DuplicateTransactionIdentity;
                }
                transaction = tx;
                result.broadcasts += 1;
                if (random.boolean()) remote_accepted = true;
            },
            .reconcile => {
                if (remote_accepted and random.boolean()) remote_finalized = true;
            },
            else => {},
        }
        if (op.stage == .delivered and (!remote_accepted or !remote_finalized)) return error.UnsafeDelivery;
    }
    result.delivered = op.stage == .delivered;
    trace.final(&result.trace_digest);
    return result;
}

test "1000 fault seeds preserve transaction identity and finalized delivery" {
    for (0..1000) |seed| {
        const result = try run(seed, 500);
        try std.testing.expect(result.delivered);
    }
}

test "simulation seed reproduces every transition and fault" {
    const first = try run(0xabc123, 1000);
    const second = try run(0xabc123, 1000);
    try std.testing.expectEqualDeep(first, second);
    try std.testing.expect(first.crashes > 0);
}

test "1000 canonical reorg traces preserve confirmed history" {
    for (0..1000) |seed| {
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        var chain = scraper.CanonicalChain(8).init(0, @splat(0));
        var canonical: [5]scraper.Block = undefined;
        var parent: [32]u8 = @splat(0);
        for (&canonical, 1..) |*block, height| {
            var hash: [32]u8 = undefined;
            random.bytes(&hash);
            block.* = .{ .height = height, .hash = hash, .parent = parent, .events_digest = @splat(0) };
            parent = hash;
        }
        _ = try chain.ingest(&canonical);
        try chain.confirm(2, canonical[1].hash);
        var fork = canonical;
        parent = canonical[1].hash;
        for (fork[2..]) |*block| {
            random.bytes(&block.hash);
            block.parent = parent;
            parent = block.hash;
        }
        _ = try chain.ingest(fork[2..]);
        try std.testing.expectEqualDeep(canonical[0..2], chain.blocks[0..2]);
        try std.testing.expectEqualDeep(fork[2..], chain.blocks[2..5]);
    }
}
