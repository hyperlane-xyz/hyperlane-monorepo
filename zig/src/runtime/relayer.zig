//! Pure relayer operation lifecycle. The driver persists each accepted event
//! before executing its effect. No wall clock, RNG, keys, or sockets live here.
const std = @import("std");
pub const Hash = [32]u8;

pub const Stage = enum { pending, preparing, ready, submitting, confirming, delivered, denied };
pub const RetryReason = enum { transient, awaiting_signatures };
pub const Policy = struct {
    max_retries: u32 = 66,
    confirm_delay_ms: u64 = 600_000,
};
pub const Effect = union(enum) {
    none,
    prepare: u64,
    /// Build/sign a transaction locally. Persist the returned transaction ID
    /// and recoverable bytes before any network submission.
    build_transaction: u64,
    broadcast: Hash,
    /// Includes a delivered(messageId) check and transaction inclusion check.
    reconcile: Hash,
};
pub const Event = union(enum) {
    already_delivered: struct { finalized: bool, now_ms: u64 = 0 },
    tick: struct { now_ms: u64 },
    prepared: struct { generation: u64, gas_allowed: bool, metadata_valid: bool },
    transaction_built: struct { generation: u64, transaction: Hash },
    broadcast_result: struct { transaction: Hash, accepted: bool },
    rebroadcast: struct { transaction: Hash },
    delivery_observed: struct { transaction: Hash, finalized: bool, delivered: bool, now_ms: u64 },
    retry: struct { generation: u64, reason: RetryReason, now_ms: u64, jitter: u64 },
    /// Source fast-poll/backoff paths wait without spending a normal retry.
    delay: struct { generation: u64, now_ms: u64, delay_ms: u64 },
    deny,
    allow,
};

pub const Operation = struct {
    id: Hash,
    stage: Stage = .pending,
    generation: u64 = 0,
    retries: u32 = 0,
    next_attempt_ms: u64 = 0,
    /// One successful inclusion observation starts the source confirmation wait.
    /// Replay must retain the same deadline until this generation is retried.
    confirmation_started: bool = false,
    transaction: ?Hash = null,
    policy: Policy = .{},

    pub fn beginConfirmation(self: *Operation, now_ms: u64) void {
        if (self.confirmation_started) return;
        self.confirmation_started = true;
        self.next_attempt_ms = now_ms +| self.policy.confirm_delay_ms;
    }
    pub fn confirmationReady(self: Operation, now_ms: u64) bool {
        return self.confirmation_started and now_ms >= self.next_attempt_ms;
    }

    /// Returns effects only after a complete valid transition. Callers must
    /// journal the event before dispatching the effect, including .tick events.
    pub fn apply(self: *Operation, event: Event) !Effect {
        switch (event) {
            .already_delivered => |observed| {
                if (!observed.finalized) return error.UnfinalizedDelivery;
                self.beginConfirmation(observed.now_ms);
                if (!self.confirmationReady(observed.now_ms)) return .none;
                self.stage = .delivered;
                self.next_attempt_ms = 0;
                return .none;
            },
            .tick => |tick| {
                if (tick.now_ms < self.next_attempt_ms) return .none;
                if (self.confirmation_started and self.transaction == null) return .none;
                switch (self.stage) {
                    .pending => {
                        self.generation = try std.math.add(u64, self.generation, 1);
                        self.stage = .preparing;
                        return .{ .prepare = self.generation };
                    },
                    .preparing => return .{ .prepare = self.generation },
                    .ready => return .{ .build_transaction = self.generation },
                    .submitting, .confirming => {
                        const transaction = self.transaction orelse return error.MissingTransaction;
                        // Recovery always reconciles first: an RPC timeout may
                        // have happened after the node accepted the broadcast.
                        return .{ .reconcile = transaction };
                    },
                    else => return .none,
                }
            },
            .prepared => |prepared| {
                try self.expectGeneration(prepared.generation, .preparing);
                if (!prepared.gas_allowed) return error.InsufficientGasPayment;
                if (!prepared.metadata_valid) return error.InvalidMetadata;
                self.stage = .ready;
                return .{ .build_transaction = self.generation };
            },
            .transaction_built => |built| {
                try self.expectGeneration(built.generation, .ready);
                self.transaction = built.transaction;
                self.stage = .submitting;
                return .{ .broadcast = built.transaction };
            },
            .broadcast_result => |result| {
                try self.expectTransaction(result.transaction);
                if (self.stage != .submitting) return error.InvalidTransition;
                // Rejections/timeouts cannot prove a transaction was not
                // submitted by a previous attempt. Keep its identity.
                self.stage = .confirming;
                return .{ .reconcile = result.transaction };
            },
            .rebroadcast => |request| {
                try self.expectTransaction(request.transaction);
                if (self.stage != .submitting and self.stage != .confirming) return error.InvalidTransition;
                self.stage = .submitting;
                // Only the exact transaction already in durable storage may be
                // resent. This never allocates a fresh nonce or changes bytes.
                return .{ .broadcast = request.transaction };
            },
            .delivery_observed => |observed| {
                try self.expectTransaction(observed.transaction);
                if (self.stage != .confirming and self.stage != .submitting) return error.InvalidTransition;
                if (observed.delivered and observed.finalized) {
                    self.beginConfirmation(observed.now_ms);
                    if (self.confirmationReady(observed.now_ms)) self.stage = .delivered;
                    return .none;
                }
                if (observed.delivered) self.beginConfirmation(observed.now_ms);
                return .none;
            },
            .retry => |retry| {
                if (retry.generation != self.generation) return error.StaleResponse;
                if (self.stage != .preparing and self.stage != .ready and !(self.stage == .pending and self.confirmation_started and self.transaction == null)) return error.InvalidTransition;
                self.confirmation_started = false;
                self.retries +|= 1;
                self.next_attempt_ms = retry.now_ms +| (retryDelaySeconds(self.retries, self.policy.max_retries, retry.reason, retry.jitter) *| 1000);
                self.stage = .pending;
                return .none;
            },
            .delay => |delay| {
                if (delay.generation != self.generation) return error.StaleResponse;
                if (self.stage != .preparing and self.stage != .ready) return error.InvalidTransition;
                self.confirmation_started = false;
                self.next_attempt_ms = delay.now_ms +| delay.delay_ms;
                self.stage = .pending;
                return .none;
            },
            .deny => {
                if (self.stage == .delivered) return error.InvalidTransition;
                self.stage = .denied;
                return .none;
            },
            .allow => {
                if (self.stage != .denied) return error.InvalidTransition;
                // An operator can deny an in-flight operation; allowing it
                // must recover that transaction rather than allocate a nonce.
                self.stage = if (self.transaction != null) .confirming else .pending;
                return .none;
            },
        }
    }

    fn expectGeneration(self: Operation, generation: u64, stage: Stage) !void {
        if (self.generation != generation) return error.StaleResponse;
        if (self.stage != stage) return error.InvalidTransition;
    }
    fn expectTransaction(self: Operation, transaction: Hash) !void {
        const current = self.transaction orelse return error.MissingTransaction;
        if (!std.mem.eql(u8, &current, &transaction)) return error.StaleResponse;
    }
};

/// Exact Rust PendingMessage gentle ramp. RNG output is injected so replay
/// and tests have identical behavior. The 10-week arm parks, not drops, work.
pub fn retryDelaySeconds(retries: u32, max_retries: u32, reason: RetryReason, jitter: u64) u64 {
    if (reason == .awaiting_signatures) {
        if (retries >= 1 and retries <= 3) return 2;
        return retryDelaySeconds(retries -| 3, max_retries, .transient, jitter);
    }
    return switch (retries) {
        0 => 0,
        1 => 5,
        2 => 10,
        3 => 30,
        4 => 60,
        5...24 => 180,
        25...39 => 300 + @as(u64, retries - 25) * 90,
        40...44 => 1800,
        45...49 => 3600,
        else => if (retries < max_retries) @max(7200, @as(u64, retries -| 49) * 7200) + jitter % 21600 else 6_048_000,
    };
}

test "ambiguous broadcast survives restart without creating another transaction" {
    var op: Operation = .{ .id = @splat(1), .policy = .{ .confirm_delay_ms = 0 } };
    try std.testing.expectEqual(Effect{ .prepare = 1 }, try op.apply(.{ .tick = .{ .now_ms = 0 } }));
    try std.testing.expectEqual(Effect{ .build_transaction = 1 }, try op.apply(.{ .prepared = .{ .generation = 1, .gas_allowed = true, .metadata_valid = true } }));
    const tx: Hash = @splat(2);
    try std.testing.expectEqual(Effect{ .broadcast = tx }, try op.apply(.{ .transaction_built = .{ .generation = 1, .transaction = tx } }));
    var recovered = op;
    try std.testing.expectEqual(Effect{ .reconcile = tx }, try recovered.apply(.{ .tick = .{ .now_ms = 0 } }));
    _ = try recovered.apply(.{ .broadcast_result = .{ .transaction = tx, .accepted = false } });
    _ = try recovered.apply(.{ .delivery_observed = .{ .transaction = tx, .finalized = false, .delivered = true, .now_ms = 5 } });
    try std.testing.expectEqual(Stage.confirming, recovered.stage);
    _ = try recovered.apply(.{ .delivery_observed = .{ .transaction = tx, .finalized = true, .delivered = true, .now_ms = 10 } });
    try std.testing.expectEqual(Stage.delivered, recovered.stage);
}

test "stale metadata, insufficient payment and unverified metadata cannot submit" {
    var op: Operation = .{ .id = @splat(0) };
    _ = try op.apply(.{ .tick = .{ .now_ms = 0 } });
    try std.testing.expectError(error.StaleResponse, op.apply(.{ .prepared = .{ .generation = 0, .gas_allowed = true, .metadata_valid = true } }));
    try std.testing.expectError(error.InsufficientGasPayment, op.apply(.{ .prepared = .{ .generation = 1, .gas_allowed = false, .metadata_valid = true } }));
    try std.testing.expectError(error.InvalidMetadata, op.apply(.{ .prepared = .{ .generation = 1, .gas_allowed = true, .metadata_valid = false } }));
    try std.testing.expectEqual(Stage.preparing, op.stage);
}

test "retry curve matches production Rust boundaries" {
    for ([_]u32{ 0, 1, 2, 3, 4, 5, 24, 25, 39, 40, 44, 45, 49, 50, 65, 66 }, [_]u64{ 0, 5, 10, 30, 60, 180, 180, 300, 1560, 1800, 1800, 3600, 3600, 7200, 115200, 6048000 }) |retries, delay| {
        try std.testing.expectEqual(delay, retryDelaySeconds(retries, 66, .transient, 0));
    }
    for ([_]u32{ 1, 2, 3, 4, 5, 6 }, [_]u64{ 2, 2, 2, 5, 10, 30 }) |retries, delay| {
        try std.testing.expectEqual(delay, retryDelaySeconds(retries, 66, .awaiting_signatures, 0));
    }
}

test "source explicit delays preserve ordinary retry budget and reject stale or signed work" {
    var op: Operation = .{ .id = @splat(0), .retries = 4 };
    _ = try op.apply(.{ .tick = .{ .now_ms = 0 } });
    try std.testing.expectError(error.StaleResponse, op.apply(.{ .delay = .{ .generation = 0, .now_ms = 0, .delay_ms = 30000 } }));
    _ = try op.apply(.{ .delay = .{ .generation = 1, .now_ms = 0, .delay_ms = 30000 } });
    try std.testing.expectEqual(@as(u32, 4), op.retries);
    try std.testing.expectEqual(Stage.pending, op.stage);
    try std.testing.expectEqual(Effect.none, try op.apply(.{ .tick = .{ .now_ms = 29999 } }));
    try std.testing.expectEqual(Effect{ .prepare = 2 }, try op.apply(.{ .tick = .{ .now_ms = 30000 } }));
    _ = try op.apply(.{ .prepared = .{ .generation = 2, .gas_allowed = true, .metadata_valid = true } });
    _ = try op.apply(.{ .transaction_built = .{ .generation = 2, .transaction = @splat(3) } });
    try std.testing.expectError(error.InvalidTransition, op.apply(.{ .delay = .{ .generation = 2, .now_ms = 30000, .delay_ms = 1000 } }));
}

test "deny/allow never discards an in-flight transaction" {
    var op: Operation = .{ .id = @splat(0), .stage = .confirming, .transaction = @splat(3) };
    _ = try op.apply(.deny);
    _ = try op.apply(.allow);
    try std.testing.expectEqual(Stage.confirming, op.stage);
}

test "source production confirmation delay starts at successful inclusion and retry gets a fresh window" {
    var op: Operation = .{ .id = @splat(1), .stage = .confirming, .transaction = @splat(2) };
    _ = try op.apply(.{ .delivery_observed = .{ .transaction = @splat(2), .finalized = false, .delivered = false, .now_ms = 10 } });
    try std.testing.expect(!op.confirmation_started);
    _ = try op.apply(.{ .delivery_observed = .{ .transaction = @splat(2), .finalized = false, .delivered = true, .now_ms = 20 } });
    try std.testing.expectEqual(@as(u64, 600020), op.next_attempt_ms);
    _ = try op.apply(.{ .delivery_observed = .{ .transaction = @splat(2), .finalized = true, .delivered = true, .now_ms = 600019 } });
    try std.testing.expectEqual(Stage.confirming, op.stage);
    try std.testing.expectEqual(@as(u64, 600020), op.next_attempt_ms);
    _ = try op.apply(.{ .delivery_observed = .{ .transaction = @splat(2), .finalized = false, .delivered = true, .now_ms = 600020 } });
    try std.testing.expectEqual(Stage.confirming, op.stage);
    _ = try op.apply(.{ .delivery_observed = .{ .transaction = @splat(2), .finalized = true, .delivered = true, .now_ms = 600020 } });
    try std.testing.expectEqual(Stage.delivered, op.stage);
    var external: Operation = .{ .id = @splat(3) };
    external.beginConfirmation(100);
    _ = try external.apply(.{ .retry = .{ .generation = 0, .reason = .transient, .now_ms = 600100, .jitter = 0 } });
    try std.testing.expect(!external.confirmation_started);
    external.beginConfirmation(605100);
    try std.testing.expectEqual(@as(u64, 1205100), external.next_attempt_ms);
}
