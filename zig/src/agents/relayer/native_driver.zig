//! Source-ordered native process driver. Queue/resource/credential ownership stays
//! with the retained destination lane. One serial caller owns each Actor/Factory.
const std = @import("std");
const destination = @import("../destination/root.zig");
const policy_module = @import("../relay_policy.zig");
const protocol = @import("../../protocol/root.zig");
const gas = @import("../../relayer/policies.zig");
const db = @import("../../db/root.zig");
const metadata = @import("../../relayer/metadata.zig");
const origin_signers = @import("../origin_signers.zig");
const common = @import("../scraper/receipts_common.zig");
const A = std.mem.Allocator;
const Factory = destination.Factory;
const Actor = destination.operation.Operation;
const Clock = destination.Clock;
const Times = destination.operation.Times;
const Reason = db.json.ReprepareReason;
pub const GateResult = union(enum) { allow, deny, delay_ms: u64, retry };
pub const SignerGate = struct {
    context: *anyopaque,
    /// cached_only denotes the secondary queue gate. Warm gates perform no
    /// origin RPC; a cold restored owner must first complete Source's initial
    /// lookup/backoff through its retained per-message state.
    check_fn: *const fn (*anyopaque, A, protocol.Message, Clock, bool) anyerror!GateResult,
};
pub const PendingDelay = struct {
    context: *anyopaque,
    delay_ms_fn: *const fn (*anyopaque) u64,
    pub fn delayMs(self: PendingDelay) u64 {
        return self.delay_ms_fn(self.context);
    }
};
pub const Options = struct { submit_via_group: bool = false, group_owned: bool = false, prepare_allowed: bool = true, pending_delay: ?PendingDelay = null, maximum_gas: ?u256 = null, signer_gate: ?SignerGate = null, jitter: u64 = 0, observation_clock: ?@import("../operation.zig").ObservationClock = null };
pub const State = enum { backpressured, idle, denied, not_contract, retried, prepared, signed, broadcast, reconciled, retired, delivered };
pub const Report = struct { state: State, reason: ?Reason = null, failure: ?anyerror = null, denial: ?policy_module.Denial = null, expenditure: ?destination.types.Expenditure = null };
const Accounting = struct { paid: ?gas.Payment, spent: gas.Expenditure };
pub const Driver = struct {
    options: Options = .{},
    pub fn step(self: Driver, a: A, factory: *Factory, actor: *Actor, origin: anytype, policy: *policy_module.Policy, message: protocol.Message, clock: Clock, now: Times) !Report {
        try checkClock(clock);
        if (actor.options.kind != .process or !std.mem.eql(u8, &actor.options.id, &message.id()) or actor.options.nonce != message.nonce or actor.options.origin != message.origin or actor.options.destination != message.destination) return error.NativeDriverAuthorityMismatch;
        const authority = try factory.authorityFor(message.origin, message.id(), actor.value.generation, .process);
        if (!std.mem.eql(u8, &actor.options.context, &try factory.contextFor(authority))) return error.OperationContextChanged;
        if (actor.value.stage == .delivered) {
            if (actor.options.acknowledge_canonical) try factory.onDelivered(actor.store, message, clock);
            return .{ .state = .delivered };
        }
        const current = try self.observationTime(now);
        if (actor.parked or (actor.signed == null and current.monotonic_ms < actor.value.next_attempt_ms)) return .{ .state = .idle };
        {
            actor.store.mutex.lock();
            defer actor.store.mutex.unlock();
            if (!try actor.store.operationMessageAuthorized(message)) return error.StaleCanonicalMessage;
        }
        if (actor.signed != null) return self.reconcile(a, factory, actor, policy, message, clock, now);
        if (self.options.group_owned) return .{ .state = .idle };
        if (!self.options.prepare_allowed and needsPreparation(actor)) return .{ .state = .backpressured };
        if (factory.deliveredFinalized(message.id(), clock) catch |err| {
            if (try actor.hasInheritedPayloads()) return .{ .state = .reconciled, .reason = .ErrorCheckingDeliveryStatus, .failure = err };
            try ensurePreparing(actor, now);
            return self.retry(actor, .ErrorCheckingDeliveryStatus, err, now);
        }) {
            const observed_at = try self.observationTime(current);
            try beginConfirmation(factory, actor, message, clock, observed_at);
            if (!actor.value.confirmationReady(observed_at.monotonic_ms)) return .{ .state = .reconciled };
            if (actor.options.acknowledge_canonical) try factory.onDelivered(actor.store, message, clock);
            try actor.alreadyDelivered(true, observed_at);
            return .{ .state = .delivered };
        }
        if (actor.value.confirmation_started) return self.retry(actor, .RevertedOrReorged, null, now);
        if (try actor.hasInheritedPayloads()) return .{ .state = .reconciled, .failure = error.InheritedPayloadNeedsReconciliation };
        if (!(factory.isRecipientContract(message, clock) catch |err| {
            try ensurePreparing(actor, now);
            return self.retry(actor, .ErrorCheckingIfRecipientIsContract, err, now);
        })) {
            try actor.dropNonContract(now);
            return .{ .state = .not_contract };
        }
        const accounting = try readAccounting(actor, message);
        const preflight = policy.evaluateGas(message, accounting.paid, accounting.spent, .{ .gas_limit = 0 }) catch |err| {
            try ensurePreparing(actor, now);
            return self.retry(actor, .ErrorCheckingGasRequirement, err, now);
        };
        if (preflight != .met) {
            try ensurePreparing(actor, now);
            return self.gasRetry(actor, preflight, now);
        }
        var decision = try policy.check(message);
        defer decision.deinit();
        if (decision.denial) |denial| {
            try actor.setAllowed(false, now);
            return .{ .state = .denied, .denial = denial };
        }
        try actor.setAllowed(true, now);
        try ensurePreparing(actor, now);
        if (actor.value.stage != .ready) if (try self.senderGate(a, actor, message, clock, now, false)) |report| return report;
        if (self.options.submit_via_group and actor.value.stage == .ready) return .{ .state = .idle };
        const effect = try actor.tick(now);
        switch (effect) {
            .none => return .{ .state = .idle },
            .prepare, .build => |generation| {
                const had_intent = actor.intent != null;
                var prepared_value = if (actor.intent) |bytes| try destination.types.Prepared.restore(a, bytes) else blk: {
                    const module = factory.recipientIsm(message, clock) catch |err| return self.retry(actor, .ErrorFetchingIsmAddress, err, now);
                    const bytes = factory.metadata(origin, module, message, clock) catch |err| {
                        if (err == error.CcipReadPending) {
                            const delay = if (self.options.pending_delay) |pending| pending.delayMs() else 1000;
                            try actor.delay(.CouldNotFetchMetadata, delay, now);
                            return .{ .state = .retried, .reason = .CouldNotFetchMetadata, .failure = err };
                        }
                        return self.retry(actor, if (err == error.AwaitingValidatorSignatures) .AwaitingValidatorSignatures else .CouldNotFetchMetadata, err, now);
                    };
                    defer factory.allocator.free(bytes);
                    break :blk factory.prepare(try factory.authorityFor(message.origin, message.id(), generation, .process), message, bytes, clock) catch |err| {
                        if (err == error.SvmSimulationFailed and try factory.recoverDuplicateCommit(actor.store, message, clock)) {
                            try actor.delay(.ErrorEstimatingGas, 1000, now);
                            return .{ .state = .retried, .reason = .ErrorEstimatingGas };
                        }
                        return self.retry(actor, .ErrorEstimatingGas, err, now);
                    };
                };
                defer prepared_value.deinit();
                // Aleo signs a nonbroadcastable authorization to obtain a real
                // SDK quote. Its public intent must precede that key callback.
                if (factory.backend == .aleo and !had_intent) try actor.staged(&prepared_value, now);
                var estimate = factory.quote(&prepared_value, actor.authorization, actor.persistence(now), clock) catch |err| return self.retry(actor, .ErrorEstimatingGas, err, now);
                if (self.options.maximum_gas) |maximum| if (estimate.gas_limit > maximum) return self.retry(actor, .ExceedsMaxGasLimit, null, now);
                const status = policy.evaluateGas(message, accounting.paid, accounting.spent, .{ .gas_limit = estimate.gas_limit }) catch |err| return self.retry(actor, .ErrorCheckingGasRequirement, err, now);
                if (status != .met) return self.gasRetry(actor, status, now);
                var adjusted = factory.applyGasAllowance(&prepared_value, status.met, clock) catch |err| return self.retry(actor, if (err == error.CosmosGasCapExceeded) .ExceedsMaxGasLimit else .ErrorEstimatingGas, err, now);
                defer adjusted.deinit();
                if (!std.mem.eql(u8, adjusted.canonical_intent, prepared_value.canonical_intent)) {
                    if (had_intent or actor.intent != null) {
                        // A new gas policy cannot overwrite an already staged
                        // nonce/expiry/body. Start a fresh unsigned generation.
                        try actor.delay(.ErrorCheckingGasRequirement, 0, now);
                        return .{ .state = .retried, .reason = .ErrorCheckingGasRequirement };
                    }
                    std.mem.swap(destination.types.Prepared, &prepared_value, &adjusted);
                    estimate = factory.quote(&prepared_value, actor.authorization, actor.persistence(now), clock) catch |err| return self.retry(actor, .ErrorEstimatingGas, err, now);
                    if (self.options.maximum_gas) |maximum| if (estimate.gas_limit > maximum) return self.retry(actor, .ExceedsMaxGasLimit, null, now);
                    const final_status = policy.evaluateGas(message, accounting.paid, accounting.spent, .{ .gas_limit = estimate.gas_limit }) catch |err| return self.retry(actor, .ErrorCheckingGasRequirement, err, now);
                    if (final_status != .met) return self.gasRetry(actor, final_status, now);
                }
                if (effect == .prepare) {
                    try actor.staged(&prepared_value, now);
                    try actor.prepared(&prepared_value, true, true, now);
                    return .{ .state = .prepared };
                }
                // Ready recovery requotes and reevaluates current gas policy.
                if (try self.senderGate(a, actor, message, clock, now, true)) |report| return report;
                var latest = try policy.check(message);
                defer latest.deinit();
                if (latest.denial) |denial| {
                    try actor.setAllowed(false, now);
                    return .{ .state = .denied, .denial = denial };
                }
                var signed = factory.sign(&prepared_value, actor.authorization, actor.persistence(now), clock) catch |err| return self.retry(actor, .ErrorSubmitting, err, now);
                defer signed.deinit();
                return .{ .state = .signed };
            },
            .broadcast, .reconcile => return error.NativeDriverStateMismatch,
        }
    }
    fn reconcile(self: Driver, a: A, factory: *Factory, actor: *Actor, policy: *policy_module.Policy, message: protocol.Message, clock: Clock, now: Times) !Report {
        const signed = if (actor.signed) |*value| value else return error.NativeDriverStateMismatch;
        var prepared_value = try destination.types.Prepared.restore(a, actor.intent orelse return error.MissingNativePreparedIntent);
        defer prepared_value.deinit();
        var delivered = factory.deliveredFinalized(message.id(), clock) catch |err| {
            if (hardFailure(err)) return err;
            return .{ .state = .reconciled, .reason = .ErrorCheckingDeliveryStatus, .failure = err };
        };
        const delivery_observed_at = try self.observationTime(now);
        if (delivered) try beginConfirmation(factory, actor, message, clock, delivery_observed_at);
        var receipt_error: ?anyerror = null;
        const receipt = factory.reconcilePrepared(&prepared_value, signed.identity, clock) catch |err| blk: {
            if (hardFailure(err)) return err;
            receipt_error = err;
            break :blk null;
        };
        var expenditure: ?destination.types.Expenditure = null;
        var observed_at = try self.observationTime(now);
        if (receipt) |value| {
            if (!destination.types.Identity.eql(value.identity, signed.identity)) return error.WrongNativeReceipt;
            if (value.success) try beginConfirmation(factory, actor, message, clock, observed_at);
            if (value.finalized and try actor.recordExpenditure(value)) expenditure = value.expenditure;
        }
        if (delivered and actor.value.confirmationReady(observed_at.monotonic_ms) and !actor.value.confirmationReady(delivery_observed_at.monotonic_ms)) {
            // Receipt I/O may cross the deadline. A delivery read obtained
            // before eligibility cannot serve as the release-time proof.
            delivered = factory.deliveredFinalized(message.id(), clock) catch |err| {
                if (hardFailure(err)) return err;
                return .{ .state = .reconciled, .reason = .ErrorCheckingDeliveryStatus, .failure = err, .expenditure = expenditure };
            };
            observed_at = try self.observationTime(observed_at);
        }
        if (delivered) {
            if (!actor.value.confirmationReady(observed_at.monotonic_ms)) return .{ .state = .reconciled, .expenditure = expenditure, .failure = receipt_error };
            if (actor.options.acknowledge_canonical) try factory.onDelivered(actor.store, message, clock);
            try actor.alreadyDelivered(true, observed_at);
            return .{ .state = .delivered, .expenditure = expenditure, .failure = receipt_error };
        }
        if (try actor.hasInheritedPayloads()) return .{ .state = .reconciled, .expenditure = expenditure, .failure = error.InheritedPayloadNeedsReconciliation };
        if (receipt) |value| {
            if (value.finalized and !value.success) {
                if (self.options.group_owned) return .{ .state = .reconciled, .expenditure = expenditure };
                try actor.finalizedFailure(value, observed_at, self.options.jitter);
                return .{ .state = .retired, .expenditure = expenditure };
            }
            try actor.observe(value.finalized, false, observed_at);
            return .{ .state = .reconciled, .expenditure = expenditure };
        }
        if (self.options.group_owned) return .{ .state = .reconciled, .expenditure = expenditure, .failure = receipt_error };
        if (factory.retirementProof(&prepared_value, signed, clock) catch |err| {
            if (hardFailure(err)) return err;
            return .{ .state = .reconciled, .failure = err };
        }) |proof| {
            try actor.retire(proof, now, self.options.jitter);
            return .{ .state = .retired };
        }
        if (receipt_error) |err| return .{ .state = .reconciled, .failure = err };
        if (actor.value.confirmation_started and !actor.value.confirmationReady(observed_at.monotonic_ms)) return .{ .state = .reconciled };
        if (self.options.group_owned) return .{ .state = .reconciled };
        var decision = try policy.check(message);
        defer decision.deinit();
        if (decision.denial) |denial| return .{ .state = .denied, .denial = denial };
        if (try self.senderGate(a, actor, message, clock, now, true)) |report| return report;
        _ = try actor.rebroadcast(now);
        factory.broadcast(&prepared_value, actor.authorization, signed, actor.persistence(now), clock) catch |err| {
            if (hardFailure(err)) return err;
            try actor.broadcastResult(false, now);
            try actor.observe(false, false, now);
            return .{ .state = .broadcast, .reason = .ErrorSubmitting, .failure = err };
        };
        try actor.broadcastResult(true, now);
        try actor.observe(false, false, now);
        return .{ .state = .broadcast };
    }
    fn observationTime(self: Driver, fallback: Times) !Times {
        return if (self.options.observation_clock) |clock| clock.now() else fallback;
    }
    pub fn submissionAllowed(self: Driver, a: A, factory: *Factory, actor: *Actor, policy: *policy_module.Policy, message: protocol.Message, clock: Clock) !bool {
        try checkClock(clock);
        try actor.assertFresh();
        var decision = try policy.check(message);
        defer decision.deinit();
        if (decision.denial != null) return false;
        // Signed reconciliation never reruns fresh gas admission. Its exact
        // bytes/nonce are already committed; receipts may have consumed the
        // payment being tracked. Live denylist/sender gates still apply.
        if (actor.signed != null) return true;
        if (try factory.deliveredFinalized(message.id(), clock)) return false;
        var prepared = try destination.types.Prepared.restore(a, actor.intent orelse return error.MissingNativePreparedIntent);
        defer prepared.deinit();
        const estimate = try factory.quote(&prepared, null, actor.persistence(.{ .unix_ms = clock.unix_ms, .monotonic_ms = 0 }), clock);
        if (self.options.maximum_gas) |maximum| if (estimate.gas_limit > maximum) return false;
        const accounting = try readAccounting(actor, message);
        if (try policy.evaluateGas(message, accounting.paid, accounting.spent, .{ .gas_limit = estimate.gas_limit }) != .met) return false;
        if (self.options.signer_gate) |gate| if (try gate.check_fn(gate.context, a, message, clock, true) != .allow) return false;
        return true;
    }
    fn senderGate(self: Driver, a: A, actor: *Actor, message: protocol.Message, clock: Clock, now: Times, cached_only: bool) !?Report {
        const gate = self.options.signer_gate orelse return null;
        const result = gate.check_fn(gate.context, a, message, clock, cached_only) catch |err| {
            if (hardFailure(err)) return err;
            if (actor.signed != null) return .{ .state = .denied, .reason = .ErrorFetchingOriginTxSender, .failure = err };
            return try self.retry(actor, .ErrorFetchingOriginTxSender, err, now);
        };
        return switch (result) {
            .allow => null,
            .deny => blk: {
                if (actor.signed == null) try actor.setAllowed(false, now);
                break :blk .{ .state = .denied, .denial = .runtime_denylisted };
            },
            .delay_ms => |delay| blk: {
                if (actor.signed == null) try actor.delay(.ErrorFetchingOriginTxSender, delay, now);
                break :blk .{ .state = .retried, .reason = .ErrorFetchingOriginTxSender };
            },
            .retry => if (actor.signed == null) try self.retry(actor, .ErrorFetchingOriginTxSender, null, now) else .{ .state = .denied, .reason = .ErrorFetchingOriginTxSender },
        };
    }
    fn gasRetry(self: Driver, actor: *Actor, status: gas.Status, now: Times) !Report {
        return self.retry(actor, if (status == .no_payment_found) .GasPaymentNotFound else .GasPaymentRequirementNotMet, null, now);
    }
    fn retry(self: Driver, actor: *Actor, reason: Reason, failure: ?anyerror, now: Times) !Report {
        if (failure) |err| if (hardFailure(err)) return err;
        if (actor.signed != null) return error.SignedNativeRetryForbidden;
        try actor.retry(reason, now, self.options.jitter);
        return .{ .state = .retried, .reason = reason, .failure = failure };
    }
};
/// The submit queue excludes an operation already popped for signing/broadcast,
/// and confirmation work must never hold the preparation threshold.
pub fn queuedForSubmission(actor: *const Actor) bool {
    return actor.current_status == .ReadyToSubmit and actor.signed == null and !actor.value.confirmation_started and !actor.parked and actor.value.stage != .denied and actor.value.stage != .delivered;
}
pub fn needsPreparation(actor: *const Actor) bool {
    return actor.signed == null and !actor.value.confirmation_started and actor.value.stage != .ready and actor.current_status != .ReadyToSubmit and actor.current_status != .Confirm;
}
/// Rust ChainConf::operation_submission_config supports this native subset.
pub fn preparationLimit(chain: *const @import("../../settings/types.zig").Chain) ?u32 {
    return switch (chain.protocol) {
        .cosmos, .sealevel, .starknet => chain.max_submit_queue_length,
        else => null,
    };
}
fn ensurePreparing(actor: *Actor, now: Times) !void {
    if (actor.value.stage == .denied) try actor.setAllowed(true, now);
    if (actor.value.stage == .pending) _ = try actor.tick(now);
    if (actor.value.stage != .preparing and actor.value.stage != .ready) return error.NativeDriverStateMismatch;
}
/// Source fires the auxiliary reveal hook on successful inclusion, before its
/// 600s confirmation hold. Enqueue first: cooperative I/O must not durably park
/// an operation whose hook has not completed. Factory enqueue is idempotent.
fn beginConfirmation(factory: anytype, actor: *Actor, message: protocol.Message, clock: Clock, now: Times) !void {
    try checkClock(clock);
    if (actor.options.acknowledge_canonical) try factory.onDelivered(actor.store, message, clock);
    try actor.beginConfirmation(now);
}
pub const NativeTests = if (@import("builtin").is_test) struct {
    pub fn confirmExisting(factory: anytype, actor: *Actor, message: protocol.Message, clock: Clock, now: Times) !void {
        return beginConfirmation(factory, actor, message, clock, now);
    }
} else struct {};
fn checkClock(clock: Clock) !void {
    _ = try common.milliseconds(clock.deadline_ns);
    if (clock.halt) |flag| if (flag.load(.acquire)) return error.CheckpointEffectsHalted;
    if (clock.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
}
fn readAccounting(actor: *Actor, message: protocol.Message) !Accounting {
    const payment = try actor.store.payment(.{ .message_id = message.id(), .destination = message.destination });
    const spent = try actor.store.expenditure(message.id());
    return .{ .paid = if (payment) |value| .{ .payment = value.payment, .gas_amount = value.gas_amount } else null, .spent = .{ .gas_used = spent.gas_used, .tokens_used = spent.tokens_used } };
}
pub fn hardFailure(err: anyerror) bool {
    return metadata.hardFailure(err) or origin_signers.isControlError(err) or switch (err) {
        error.InheritedPayloadNeedsReconciliation, error.StaleNativeOperationOwner, error.OperationContextChanged, error.NativeDriverAuthorityMismatch, error.DestinationAuthorityMismatch, error.OriginAuthorityMismatch, error.MissingOriginAuthorityBinding, error.NativeDriverStateMismatch, error.NativeIntentConflict, error.InvalidNativeOperation, error.NativeGroupOwnsOperation => true,
        else => false,
    };
}

test "source600s Native inclusion hook enqueues before hold survives restart and respects halt" {
    const a = std.testing.allocator;
    const queue = @import("../destination/reveal_queue.zig");
    const reveal = @import("../destination/reveal.zig");
    const CaptureFactory = struct {
        calls: usize = 0,
        enqueues: usize = 0,
        pending: bool = true,
        pub fn onDelivered(self: *@This(), store: *@import("../store.zig").Store, message: protocol.Message, _: Clock) !void {
            self.calls += 1;
            if (self.pending) return error.PendingReadIo;
            const commit = reveal.Commit.message(message.recipient, message).?;
            if (try queue.enqueue(a, store, .{4} ** 32, .{5} ** 32, message, commit, .reveal)) self.enqueues += 1;
        }
    };
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "early-reveal" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "origin");
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .nonce = 0, .sender = .{2} ** 32, .recipient = .{3} ** 32, .body = &(.{1} ** 96) };
    _ = try store.storeMessage(message, 1, null);
    const initial: Times = .{ .unix_ms = 1000, .monotonic_ms = 100 };
    const options: destination.operation.Options = .{ .id = message.id(), .context = .{6} ** 32, .nonce = 0, .origin = 1, .destination = 2 };
    var factory: CaptureFactory = .{};
    var halt: std.atomic.Value(bool) = .init(false);
    var cancel: std.atomic.Value(bool) = .init(false);
    const clock: Clock = .{ .unix_ms = initial.unix_ms, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 10 * std.time.ns_per_s, .halt = &halt, .cancel = &cancel };
    {
        const actor = try Actor.open(a, &store, options, initial);
        defer actor.deinit();
        // Source hook failure must remain replayable now, not park for600s.
        try std.testing.expectError(error.PendingReadIo, beginConfirmation(&factory, actor, message, clock, initial));
        try std.testing.expect(!actor.value.confirmation_started);
        try std.testing.expectEqual(@as(u64, 0), actor.value.next_attempt_ms);
        try std.testing.expect((try queue.next(a, &store, 2)) == null);
        factory.pending = false;
        try beginConfirmation(&factory, actor, message, clock, initial);
        try std.testing.expect(actor.value.confirmation_started);
        try std.testing.expectEqual(@as(u64, 600100), actor.value.next_attempt_ms);
        try std.testing.expect(!try store.processed(0));
        try std.testing.expectEqual(@as(usize, 1), factory.enqueues);
        var auxiliary = (try queue.next(a, &store, 2)).?;
        defer auxiliary.deinit();
        // The auxiliary workflow can advance while canonical process is held.
        auxiliary.value().phase = .tokens;
        try auxiliary.save();
    }
    const restarted: Times = .{ .unix_ms = 101000, .monotonic_ms = 7 };
    const actor = try Actor.open(a, &store, options, restarted);
    defer actor.deinit();
    try std.testing.expectEqual(@as(u64, 500007), actor.value.next_attempt_ms);
    try beginConfirmation(&factory, actor, message, clock, restarted);
    try std.testing.expectEqual(@as(u64, 500007), actor.value.next_attempt_ms);
    try std.testing.expectEqual(@as(usize, 1), factory.enqueues);
    {
        var auxiliary = (try queue.next(a, &store, 2)).?;
        defer auxiliary.deinit();
        try std.testing.expectEqual(queue.Phase.tokens, auxiliary.value().phase);
        try std.testing.expectEqual(@as(u64, 0), auxiliary.value().cycle);
    }
    const calls = factory.calls;
    halt.store(true, .release);
    try std.testing.expectError(error.CheckpointEffectsHalted, beginConfirmation(&factory, actor, message, clock, restarted));
    halt.store(false, .release);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, beginConfirmation(&factory, actor, message, clock, restarted));
    try std.testing.expectEqual(calls, factory.calls);
    cancel.store(false, .release);
    try actor.alreadyDelivered(true, .{ .unix_ms = 600999, .monotonic_ms = 500006 });
    try std.testing.expect(!try store.processed(0));
    try std.testing.expectEqual(db.json.Status.Confirm, std.meta.activeTag(actor.current_status));
    try actor.alreadyDelivered(true, .{ .unix_ms = 601000, .monotonic_ms = 500007 });
    try std.testing.expect(try store.processed(0));
    try std.testing.expectEqual(@as(usize, 1), factory.enqueues);
}

test "native preparation limit follows Source supported protocol subset" {
    var chain: @import("../../settings/types.zig").Chain = undefined;
    chain.max_submit_queue_length = 0;
    inline for (.{ .cosmos, .sealevel, .starknet }) |vm| {
        chain.protocol = vm;
        try std.testing.expectEqual(@as(?u32, 0), preparationLimit(&chain));
    }
    inline for (.{ .ethereum, .cosmosnative, .radix, .aleo, .tron }) |vm| {
        chain.protocol = vm;
        try std.testing.expect(preparationLimit(&chain) == null);
    }
}

test "native submission phase restoration keeps Ready Confirm and popped signed work out of fresh preparation" {
    var actor: Actor = undefined;
    actor.value = .{ .id = @splat(0) };
    actor.signed = null;
    actor.parked = false;
    actor.current_status = .ReadyToSubmit;
    try std.testing.expect(queuedForSubmission(&actor));
    try std.testing.expect(!needsPreparation(&actor));
    actor.current_status = .{ .Confirm = .AlreadySubmitted };
    try std.testing.expect(!queuedForSubmission(&actor));
    try std.testing.expect(!needsPreparation(&actor));
    actor.current_status = .{ .Retry = .Manual };
    try std.testing.expect(needsPreparation(&actor));
    actor.current_status = .ReadyToSubmit;
    actor.signed = .{ .allocator = undefined, .identity = .{ .hash256 = @splat(1) }, .bytes = undefined };
    try std.testing.expect(!queuedForSubmission(&actor));
    try std.testing.expect(!needsPreparation(&actor));
}
