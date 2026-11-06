//! Source-ordered EVM message preparation. No queue/store mutation, nonce
//! allocation, signing, transaction submission, or payload UUID generation.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const evm = @import("../../evm/root.zig");
const native = @import("../store.zig");
const relay_policy = @import("../relay_policy.zig");
const lander = @import("../../lander/root.zig");
const evm_source = @import("../../relayer/evm_source.zig");
const metadata_builder = @import("../../relayer/metadata.zig");
const metadata_parallel = @import("../../relayer/metadata_parallel.zig");
const ccip = @import("../../relayer/ccip.zig");
const contract_cache = @import("../../relayer/contract_cache.zig");
const cached_source = @import("../../relayer/cached_source.zig");
const gas = @import("../../relayer/policies.zig");
const settings = @import("../../settings/types.zig");
const Allocator = std.mem.Allocator;
const operation = @import("../operation.zig");
const Hash = [32]u8;
const Address = [20]u8;

pub const max_ica_reveal_attempts = 66;
pub const max_origin_lookup_failures = 5;

pub const RetryState = struct {
    ica_reveal_attempts: u32 = 0,
    origin_lookup_failures: u32 = 0,
    origin_hash_waited: bool = false,
    origin_lookup_skip_until_ms: ?u64 = null,
};

pub const RetryReason = enum {
    chain_validation,
    canonical_message,
    delivery_status,
    recipient_contract,
    gas_payment_not_found,
    gas_payment_requirement_not_met,
    gas_payment_check,
    origin_sender,
    metadata,
    awaiting_validator_signatures,
    estimation,
    awaiting_ica_reveal,
    exceeds_max_gas_limit,
    payload_validation,
};

pub const Estimate = struct {
    gas_limit: u256,
    gas_price: u256,
    l2_gas_limit: ?u256 = null,
};

pub const Estimator = enum { public, protected };
pub const Diagnostics = struct {
    estimate: ?Estimate = null,
    estimator: ?Estimator = null,
    arbitrum_l2_fallback: bool = false,
    metadata: metadata_builder.Diagnostics = .{},
};

pub const SignerLookup = union(enum) {
    signers: [][32]u8,
    hash_not_stored,
};

pub const OriginSender = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, Allocator, *native.Store, protocol.Message, bool) anyerror!SignerLookup,

    pub fn fetch(self: OriginSender, allocator: Allocator, store: *native.Store, message: protocol.Message, cached_only: bool) !SignerLookup {
        return self.fetch_fn(self.context, allocator, store, message, cached_only);
    }
};

/// Full estimate using only protected transports, with a 5-second deadline.
/// Matching reveals never fall back to the public estimator.
pub const PrivateEstimator = struct {
    context: *anyopaque,
    estimate_fn: *const fn (*anyopaque, Allocator, protocol.Message, []const u8, []const u8, Address, bool) anyerror!Estimate,

    pub fn estimate(self: PrivateEstimator, allocator: Allocator, message: protocol.Message, metadata: []const u8, calldata: []const u8, relayer: Address, arbitrum_nitro: bool) !Estimate {
        return self.estimate_fn(self.context, allocator, message, metadata, calldata, relayer, arbitrum_nitro);
    }
};

/// Relative delay derived by the caller from an absolute monotonic retryAt.
pub const PendingDelay = struct {
    context: *anyopaque,
    delay_ms_fn: *const fn (*anyopaque) u64,

    pub fn delayMs(self: PendingDelay) u64 {
        return self.delay_ms_fn(self.context);
    }
};

pub const Config = struct {
    domain: u32,
    chain_id: u256,
    mailbox: Hash,
    relayer: Address,
    reorg: settings.Reorg,
    arbitrum_nitro: bool = false,
    transaction_gas_limit: ?u256 = null,
    max_metadata_bytes: usize = 8 * 1024 * 1024,
    canonical_ica_router: ?Hash = null,
    protected_ica_routers: []const Hash = &.{},
    metadata_observer: ?@import("../../ops/relayer_metrics.zig").MetadataObserver = null,

    pub fn fromSettings(chain: anytype, relayer: Address, transaction_gas_limit: ?u256, skip_transaction_gas_limit_for: []const u32) !Config {
        var maximum = transaction_gas_limit;
        for (skip_transaction_gas_limit_for) |domain| if (domain == chain.domain) {
            maximum = null;
            break;
        };
        const protected = switch (chain.connection) {
            .ethereum => |connection| connection.mev_submission,
            else => null,
        };
        return .{
            .domain = chain.domain,
            .chain_id = try std.fmt.parseInt(u256, chain.chain_id, 0),
            .mailbox = chain.contracts.mailbox,
            .relayer = relayer,
            .reorg = chain.reorg,
            .arbitrum_nitro = chain.technical_stack == .arbitrumnitro,
            .transaction_gas_limit = maximum,
            .canonical_ica_router = if (protected) |value| value.ica_router else null,
            .protected_ica_routers = if (protected) |value| value.additional_ica_routers else &.{},
        };
    }

    pub fn matchesProtected(self: Config, message: protocol.Message) bool {
        if (message.body.len == 0 or message.body[0] != 2) return false;
        if (self.canonical_ica_router) |router| if (std.mem.eql(u8, &router, &message.recipient)) return true;
        for (self.protected_ica_routers) |router| if (std.mem.eql(u8, &router, &message.recipient)) return true;
        return false;
    }
};

pub const Input = struct {
    store: *native.Store,
    message: protocol.Message,
    uuid: lander.types.Uuid,
    metadata: []const u8,
    now_ms: u64 = 0,
    retry_state: RetryState = .{},
    cached_metadata: ?[]const u8 = null,
};

pub const Ready = struct {
    payload: lander.records.PayloadInput,
    metadata_bytes: []const u8,
    retry_state: RetryState,
    diagnostics: Diagnostics,
};

pub const Retry = struct {
    reason: RetryReason,
    failure: ?[]const u8 = null,
    delay_ms: ?u64 = null,
    retry_state: RetryState,
    cached_metadata: ?[]const u8 = null,
    diagnostics: Diagnostics = .{},
};

pub const Denied = struct {
    denial: relay_policy.Denial,
    reason: ?[]const u8,
    retry_state: RetryState,
};

pub const Waiting = struct {
    retry_state: RetryState,
    delivered: bool = false,
    observed_at: ?operation.Times = null,
    failure: ?[]const u8 = null,
};
pub const Value = union(enum) {
    ready: Ready,
    retry: Retry,
    finality_wait: Waiting,
    denied: Denied,
    not_contract: Waiting,
};

pub const Outcome = struct {
    arena: std.heap.ArenaAllocator,
    value: Value,

    fn init(parent: Allocator) Outcome {
        return .{ .arena = std.heap.ArenaAllocator.init(parent), .value = undefined };
    }

    pub fn deinit(self: *Outcome) void {
        self.arena.deinit();
        self.* = undefined;
    }

    fn allocator(self: *Outcome) Allocator {
        return self.arena.allocator();
    }
};

pub fn Preparer(comptime Origin: type) type {
    return struct {
        allocator: Allocator,
        client: *evm.RpcClient,
        origin: *Origin,
        policy: *relay_policy.Policy,
        config: Config,
        origin_sender: ?OriginSender = null,
        private_estimator: ?PrivateEstimator = null,
        executor: ?*metadata_parallel.Executor = null,
        pending_delay: ?PendingDelay = null,
        ccip_handler: ?ccip.Handler = null,
        metadata_cache: ?*contract_cache.Cache = null,
        default_ism_cache: ?*contract_cache.Cache = null,
        cache_context: ?contract_cache.Context = null,
        ism_cache_configs: []const settings.IsmCache = &.{},
        cancel: ?*const std.atomic.Value(bool) = null,
        observation: ?metadata_builder.Observation = null,
        observation_clock: ?operation.ObservationClock = null,

        const Self = @This();

        pub fn prepare(self: *Self, input: Input) !Outcome {
            var outcome = Outcome.init(self.allocator);
            errdefer outcome.deinit();
            const a = outcome.allocator();
            var state = input.retry_state;
            if (self.config.max_metadata_bytes == 0) return error.InvalidMetadataLimit;
            try checkCancelled(self.cancel);
            self.client.checkChain(self.config.chain_id) catch |err| return retry(&outcome, .chain_validation, err, state, null);
            try checkCancelled(self.cancel);
            if (input.message.destination != self.config.domain) return retryFailure(&outcome, .canonical_message, "DestinationAuthorityMismatch", state, null);
            if (!try input.store.operationMessageAuthorized(input.message)) {
                var current = try input.store.messageByNonce(input.message.nonce);
                defer if (current) |*value| value.deinit();
                return retryFailure(&outcome, .canonical_message, if (current == null) "CanonicalMessageMissing" else "StaleCanonicalMessage", state, null);
            }
            const id = input.message.id();
            const mailbox = lowAddress(self.config.mailbox);
            const latest_delivered = self.client.delivered(mailbox, id, .latest) catch |err| return retry(&outcome, .delivery_status, err, state, null);
            if (latest_delivered) {
                const observed_at = if (self.observation_clock) |clock| try clock.now() else null;
                const block = deliveryFinalityBlock(self.client, self.config.reorg) catch |err| return finalityFailure(&outcome, state, observed_at, err);
                const finalized = self.client.delivered(mailbox, id, block) catch |err| return finalityFailure(&outcome, state, observed_at, err);
                outcome.value = .{ .finality_wait = .{ .retry_state = state, .delivered = finalized, .observed_at = observed_at } };
                return outcome;
            }
            const code = getCode(self.client, a, lowAddress(input.message.recipient)) catch |err| return retry(&outcome, .recipient_contract, err, state, null);
            if (code.len == 0) {
                outcome.value = .{ .not_contract = .{ .retry_state = state } };
                return outcome;
            }
            const payment = try input.store.payment(.{ .message_id = id, .destination = input.message.destination });
            const spent = try input.store.expenditure(id);
            const paid: ?gas.Payment = if (payment) |value| .{ .payment = value.payment, .gas_amount = value.gas_amount } else null;
            const expenditure: gas.Expenditure = .{ .gas_used = spent.gas_used, .tokens_used = spent.tokens_used };
            const preflight = self.policy.evaluateGas(input.message, paid, expenditure, .{ .gas_limit = 0 }) catch |err| return retry(&outcome, .gas_payment_check, err, state, null);
            switch (preflight) {
                .met => {},
                .no_payment_found => return retryFailure(&outcome, .gas_payment_not_found, null, state, null),
                .not_met => return retryFailure(&outcome, .gas_payment_requirement_not_met, null, state, null),
            }
            var policy_decision = try self.policy.check(input.message);
            defer policy_decision.deinit();
            if (policy_decision.denial) |denial| {
                outcome.value = .{ .denied = .{
                    .denial = denial,
                    .reason = if (policy_decision.reason) |reason| try a.dupe(u8, reason) else null,
                    .retry_state = state,
                } };
                return outcome;
            }
            if (self.origin_sender) |lookup| {
                const paused = if (state.origin_lookup_skip_until_ms) |until| input.now_ms < until else false;
                if (!paused) state.origin_lookup_skip_until_ms = null;
                const result = lookup.fetch(a, input.store, input.message, paused) catch |err| {
                    if (hardFailure(err)) return err;
                    if (paused) return retry(&outcome, .origin_sender, err, state, null);
                    state.origin_lookup_failures +|= 1;
                    if (state.origin_lookup_failures < max_origin_lookup_failures) {
                        const shift = state.origin_lookup_failures - 1;
                        const delay = @as(u64, 30_000) << @intCast(shift);
                        return retryDelay(&outcome, .origin_sender, err, state, delay, null);
                    }
                    state.origin_lookup_skip_until_ms = input.now_ms +| 300_000;
                    return metadataAndEstimate(self, &outcome, input, state, paid, expenditure);
                };
                switch (result) {
                    .hash_not_stored => if (!paused and !state.origin_hash_waited) {
                        state.origin_hash_waited = true;
                        return retryDelayFailure(&outcome, .origin_sender, "OriginTransactionHashNotStored", state, 30_000, null);
                    },
                    .signers => |signers| {
                        var signer_decision = try self.policy.checkOriginSigners(signers);
                        defer signer_decision.deinit();
                        if (signer_decision.denial) |denial| {
                            outcome.value = .{ .denied = .{
                                .denial = denial,
                                .reason = if (signer_decision.reason) |reason| try a.dupe(u8, reason) else null,
                                .retry_state = state,
                            } };
                            return outcome;
                        }
                        if (!paused) {
                            state.origin_lookup_failures = 0;
                            state.origin_lookup_skip_until_ms = null;
                        }
                    },
                }
            }
            return metadataAndEstimate(self, &outcome, input, state, paid, expenditure);
        }

        fn metadataAndEstimate(self: *Self, outcome: *Outcome, input: Input, initial_state: RetryState, paid: ?gas.Payment, spent: gas.Expenditure) !Outcome {
            var state = initial_state;
            const a = outcome.allocator();
            var diagnostics: Diagnostics = .{};
            var metadata_bytes: []const u8 = undefined;
            const cached = input.cached_metadata != null;
            if (input.cached_metadata) |bytes| {
                metadata_bytes = bytes;
            } else {
                metadata_bytes = buildMetadata(self, a, input.message, input.now_ms, &diagnostics) catch |err| {
                    if (err == error.CcipReadPending) {
                        outcome.value = .{ .retry = .{
                            .reason = .metadata,
                            .failure = @errorName(err),
                            .delay_ms = if (self.pending_delay) |delay| delay.delayMs() else 1000,
                            .retry_state = state,
                            .diagnostics = diagnostics,
                        } };
                        return outcome.*;
                    }
                    if (hardFailure(err)) return err;
                    const reason: RetryReason = if (err == error.AwaitingValidatorSignatures) .awaiting_validator_signatures else .metadata;
                    return retryDiagnostics(outcome, reason, err, state, null, diagnostics);
                };
            }
            if (metadata_bytes.len > self.config.max_metadata_bytes) return retryFailure(outcome, .metadata, "MetadataTooLarge", state, null);
            const calldata = try processCalldata(a, metadata_bytes, input.message);
            const cost = self.estimate(outcome, input.message, metadata_bytes, calldata, &diagnostics) catch |err| {
                if (hardFailure(err)) return err;
                if (err == error.IcaInvalidReveal and state.ica_reveal_attempts < max_ica_reveal_attempts) {
                    state.ica_reveal_attempts +|= 1;
                    const delay: u64 = if (state.ica_reveal_attempts <= 30) 1_000 else 5_000;
                    const retained = try a.dupe(u8, metadata_bytes);
                    outcome.value = .{ .retry = .{
                        .reason = .awaiting_ica_reveal,
                        .failure = @errorName(err),
                        .delay_ms = delay,
                        .retry_state = state,
                        .cached_metadata = retained,
                        .diagnostics = diagnostics,
                    } };
                    return outcome.*;
                }
                if (err != error.IcaInvalidReveal) state.ica_reveal_attempts = 0;
                if (cached) {
                    var fresh = input;
                    fresh.cached_metadata = null;
                    return metadataAndEstimate(self, outcome, fresh, state, paid, spent);
                }
                return retryDiagnostics(outcome, .estimation, err, state, null, diagnostics);
            };
            state.ica_reveal_attempts = 0;
            diagnostics.estimate = cost;
            const evaluated = self.policy.evaluateGas(input.message, paid, spent, .{ .gas_limit = cost.gas_limit, .l2_gas_limit = cost.l2_gas_limit }) catch |err| return retryDiagnostics(outcome, .gas_payment_check, err, state, null, diagnostics);
            const gas_limit = switch (evaluated) {
                .no_payment_found => return retryDiagnostics(outcome, .gas_payment_not_found, null, state, null, diagnostics),
                .not_met => return retryDiagnostics(outcome, .gas_payment_requirement_not_met, null, state, null, diagnostics),
                .met => |limit| limit,
            };
            if (self.config.transaction_gas_limit) |maximum| if (gas_limit > maximum) return retryDiagnostics(outcome, .exceeds_max_gas_limit, null, state, null, diagnostics);
            const process_json = try processPair(a, calldata, lowAddress(self.config.mailbox));
            const delivered_json = try deliveredPair(a, input.message.id(), lowAddress(self.config.mailbox));
            const payload: lander.records.PayloadInput = .{
                .uuid = input.uuid,
                .metadata = try a.dupe(u8, input.metadata),
                .data_json = process_json,
                .gas_limit = gas_limit,
                .success_criteria_json = delivered_json,
                .to = self.config.mailbox,
                .value = null,
            };
            var validation: lander.records.OwnedJson = .init(a);
            defer validation.deinit();
            lander.records.createPayload(&validation, payload) catch |err| return retryDiagnostics(outcome, .payload_validation, err, state, null, diagnostics);
            outcome.value = .{ .ready = .{
                .payload = payload,
                .metadata_bytes = try a.dupe(u8, metadata_bytes),
                .retry_state = state,
                .diagnostics = diagnostics,
            } };
            return outcome.*;
        }

        fn estimate(self: *Self, outcome: *Outcome, message: protocol.Message, metadata_bytes: []const u8, calldata: []const u8, diagnostics: *Diagnostics) !Estimate {
            if (self.config.matchesProtected(message)) {
                const protected = self.private_estimator orelse return error.MissingProtectedEstimator;
                diagnostics.estimator = .protected;
                return protected.estimate(outcome.allocator(), message, metadata_bytes, calldata, self.config.relayer, self.config.arbitrum_nitro);
            }
            diagnostics.estimator = .public;
            return publicEstimate(self, outcome.allocator(), calldata, diagnostics);
        }
    };
}

fn buildMetadata(self: anytype, a: Allocator, message: protocol.Message, now_ms: u64, diagnostics: *Diagnostics) ![]u8 {
    const observer = self.config.metadata_observer;
    if (observer) |value| try value.start();
    const bytes = buildMetadataInner(self, a, message, now_ms, diagnostics) catch |err| {
        if (err != error.PendingReadIo) {
            const result: @import("../../ops/relayer_metrics.zig").MetadataResult = if (err == error.AwaitingValidatorSignatures) .awaiting_validator_signatures else if (err == error.RequestCancelled or err == error.Cancelled) .cancelled else .failure;
            if (observer) |value| try value.complete(result);
        }
        return err;
    };
    errdefer a.free(bytes);
    if (observer) |value| try value.complete(.success);
    return bytes;
}

fn buildMetadataInner(self: anytype, a: Allocator, message: protocol.Message, now_ms: u64, diagnostics: *Diagnostics) ![]u8 {
    const recipient = lowAddress(message.recipient);
    const block_number = try self.client.blockNumber();
    const working = self.client.allocator;
    const context = self.cache_context;
    if ((self.metadata_cache != null or self.default_ism_cache != null) and context == null) return error.MissingContractCacheContext;
    const ism = if (self.metadata_cache) |cache| cached: {
        if (try cache.get(context.?, .recipientIsm(message.recipient), now_ms)) |value| break :cached value.address;
        const fetched = try self.client.recipientIsm(lowAddress(self.config.mailbox), recipient, .{ .number = block_number });
        _ = try cache.put(context.?, .recipientIsm(message.recipient), &.{ .address = fetched }, now_ms);
        break :cached fetched;
    } else try self.client.recipientIsm(lowAddress(self.config.mailbox), recipient, .{ .number = block_number });
    // Pin even a direct CCIP leaf to the same block as its module queries.
    // Aggregation forks replace this binding again with their independent client.
    var pinned_handler: ?ccip.Handler = null;
    defer if (pinned_handler) |*handler| handler.deinit();
    if (self.ccip_handler) |handler| {
        if (handler.fork_fn != null) pinned_handler = try handler.fork(working, self.client, block_number, self.cancel orelse &uncancelled);
    }
    const Source = evm_source.Source(@TypeOf(self.origin.*));
    var source: Source = .{
        .allocator = working,
        .client = self.client,
        .block_number = block_number,
        .mailbox = lowAddress(self.config.mailbox),
        .origin = self.origin,
        .ccip_handler = pinned_handler orelse self.ccip_handler,
        .cancel = self.cancel,
        .observation = self.observation,
        .observation_clock = self.observation_clock,
    };
    const DefaultContext = struct {
        source: *Source,
        clock: ?operation.ObservationClock,
        fn get(context_ptr: *anyopaque, _: u64) !Address {
            const value: *@This() = @ptrCast(@alignCast(context_ptr));
            return value.source.defaultIsm();
        }
        fn now(context_ptr: *anyopaque) !u64 {
            const value: *@This() = @ptrCast(@alignCast(context_ptr));
            const clock = value.clock orelse return error.DefaultIsmClockUnavailable;
            return (try clock.now()).monotonic_ms;
        }
    };
    var default_context: DefaultContext = .{ .source = &source, .clock = self.observation_clock };
    const explicit_app_context = try self.policy.appContext(message);
    const root_app_context = try @import("../../relayer/app_context.zig").classify(Address, ism, explicit_app_context, self.default_ism_cache, context orelse .{ .domain_name = "", .context_hash = @splat(0) }, .{ .context = &default_context, .get_fn = DefaultContext.get, .now_ms_fn = DefaultContext.now }, now_ms);
    const bytes = if (self.metadata_cache) |cache| cached: {
        const Cached = cached_source.CachedSource(Source);
        var wrapper = Cached.initBorrowed(working, &source, cache, .{ .context = context.?, .configs = self.ism_cache_configs, .default_ism_cache = self.default_ism_cache });
        wrapper.setMessage(ism, root_app_context, now_ms);
        var builder: metadata_builder.Builder(Cached) = .{ .allocator = working, .source = &wrapper, .executor = self.executor, .cancel = self.cancel, .observation = self.observation, .app_context = root_app_context };
        const result = try builder.build(ism, message);
        diagnostics.metadata = builder.diagnostics;
        break :cached result;
    } else uncached: {
        var builder: metadata_builder.Builder(Source) = .{ .allocator = working, .source = &source, .executor = self.executor, .cancel = self.cancel, .observation = self.observation, .app_context = root_app_context };
        const result = try builder.build(ism, message);
        diagnostics.metadata = builder.diagnostics;
        break :uncached result;
    };
    defer working.free(bytes);
    return a.dupe(u8, bytes);
}
var uncancelled = std.atomic.Value(bool).init(false);

/// Reuse the same source cost path on a separately configured protected RPC.
pub fn estimateRpc(a: Allocator, client: *evm.RpcClient, mailbox: Hash, relayer: Address, calldata: []const u8, arbitrum_nitro: bool) !Estimate {
    const context = .{ .client = client, .config = .{ .mailbox = mailbox, .relayer = relayer, .arbitrum_nitro = arbitrum_nitro } };
    var diagnostics: Diagnostics = .{};
    return publicEstimate(&context, a, calldata, &diagnostics);
}

fn publicEstimate(self: anytype, a: Allocator, calldata: []const u8, diagnostics: *Diagnostics) !Estimate {
    const direct = try estimateCall(self.client, a, lowAddress(self.config.mailbox), self.config.relayer, calldata);
    var l2: ?u256 = null;
    if (self.config.arbitrum_nitro) {
        const retryable = try retryableCalldata(a, lowAddress(self.config.mailbox), calldata);
        var node: Address = @splat(0);
        node[19] = 0xc8;
        l2 = estimateCall(self.client, a, node, self.config.relayer, retryable) catch |err| fallback: {
            if (hardFailure(err)) return err;
            diagnostics.arbitrum_l2_fallback = true;
            break :fallback null;
        };
    }
    var response = try self.client.call("eth_gasPrice", .{});
    defer response.deinit();
    const gas_price = try evm.codecs.quantityAs(u256, try evm.provider.string(response.value()));
    diagnostics.estimate = .{ .gas_limit = direct, .gas_price = gas_price, .l2_gas_limit = l2 };
    return diagnostics.estimate.?;
}

fn estimateCall(client: *evm.RpcClient, a: Allocator, to: Address, from: Address, calldata: []const u8) !u256 {
    const to_text = try evm.codecs.hexAlloc(a, &to);
    const from_text = try evm.codecs.hexAlloc(a, &from);
    const data = try evm.codecs.hexAlloc(a, calldata);
    var response = try client.callEnvelope("eth_estimateGas", .{.{ .to = to_text, .from = from_text, .data = data }});
    defer response.deinit();
    if (response.isError()) {
        if (isIcaInvalidReveal(a, response)) return error.IcaInvalidReveal;
        return error.RpcError;
    }
    return evm.codecs.quantityAs(u256, try evm.provider.string(response.value()));
}

fn retryableCalldata(a: Allocator, mailbox: Address, process: []const u8) ![]u8 {
    const signature = "estimateRetryableTicket(address,uint256,address,uint256,address,address,bytes)";
    const padded = try std.math.add(usize, process.len, (32 - process.len % 32) % 32);
    const length = try std.math.add(usize, 4 + 7 * 32 + 32, padded);
    const out = try a.alloc(u8, length);
    @memset(out, 0);
    out[0..4].* = evm.codecs.selector(signature);
    std.mem.writeInt(u256, out[36..68], 100 * std.math.pow(u256, 10, 18), .big);
    @memcpy(out[68 + 12 .. 100], &mailbox);
    std.mem.writeInt(u256, out[196..228], 224, .big);
    std.mem.writeInt(u256, out[228..260], process.len, .big);
    @memcpy(out[260..][0..process.len], process);
    return out;
}

fn deliveryFinalityBlock(client: *evm.RpcClient, reorg: settings.Reorg) !evm.BlockRef {
    return switch (reorg) {
        .blocks => |depth| .{ .number = (try client.blockNumber()) -| depth },
        .tag => |tag| if (std.mem.eql(u8, tag, "latest")) .latest else if (std.mem.eql(u8, tag, "finalized")) .finalized else if (std.mem.eql(u8, tag, "safe")) .safe else if (std.mem.eql(u8, tag, "earliest")) .earliest else if (std.mem.eql(u8, tag, "pending")) .pending else error.InvalidEvmReorgTag,
    };
}

fn getCode(client: *evm.RpcClient, a: Allocator, recipient: Address) ![]u8 {
    const address = try evm.codecs.hexAlloc(a, &recipient);
    var response = try client.call("eth_getCode", .{ address, "latest" });
    defer response.deinit();
    return decodeHex(a, try evm.provider.string(response.value()));
}

fn processCalldata(a: Allocator, metadata_bytes: []const u8, message: protocol.Message) ![]u8 {
    const encoded = try message.encodeAlloc(a);
    return evm.codecs.processCalldata(a, metadata_bytes, encoded);
}

const Param = struct { internalType: []const u8, name: []const u8, type: []const u8 };
const Function = struct {
    inputs: []const Param,
    name: []const u8,
    outputs: []const Param,
    stateMutability: []const u8,
};
const Transaction = struct {
    data: []const u8,
    to: []const u8,
    type: []const u8 = "0x00",
};

fn processPair(a: Allocator, calldata: []const u8, mailbox: Address) ![]u8 {
    const data = try evm.codecs.hexAlloc(a, calldata);
    const to = try evm.codecs.hexAlloc(a, &mailbox);
    const inputs = [_]Param{
        .{ .internalType = "bytes", .name = "metadata", .type = "bytes" },
        .{ .internalType = "bytes", .name = "message", .type = "bytes" },
    };
    const function: Function = .{ .inputs = &inputs, .name = "process", .outputs = &.{}, .stateMutability = "payable" };
    return std.json.Stringify.valueAlloc(a, .{ Transaction{ .data = data, .to = to }, function }, .{});
}

fn deliveredPair(a: Allocator, id: Hash, mailbox: Address) ![]u8 {
    const call = evm.codecs.hashCall("delivered(bytes32)", id);
    const data = try evm.codecs.hexAlloc(a, &call);
    const to = try evm.codecs.hexAlloc(a, &mailbox);
    const inputs = [_]Param{.{ .internalType = "bytes32", .name = "messageId", .type = "bytes32" }};
    const outputs = [_]Param{.{ .internalType = "bool", .name = "", .type = "bool" }};
    const function: Function = .{ .inputs = &inputs, .name = "delivered", .outputs = &outputs, .stateMutability = "view" };
    return std.json.Stringify.valueAlloc(a, .{ Transaction{ .data = data, .to = to }, function }, .{});
}

fn isIcaInvalidReveal(a: Allocator, response: evm.RpcResponse) bool {
    const root = response.parsed.value;
    if (root != .object) return false;
    const rpc_error = root.object.get("error") orelse return false;
    if (rpc_error != .object) return false;
    if (rpc_error.object.get("message")) |message| if (message == .string and std.mem.indexOf(u8, message.string, "ICA: Invalid Reveal") != null) return true;
    const data = rpc_error.object.get("data") orelse return false;
    const raw = if (data == .object) data.object.get("data") orelse return false else data;
    if (raw != .string or raw.string.len > 128 * 1024) return false;
    const bytes = decodeHex(a, raw.string) catch return false;
    if (bytes.len < 68 or !std.mem.eql(u8, bytes[0..4], &evm.codecs.selector("Error(string)"))) return false;
    const offset = evm.codecs.uintWord(usize, bytes[4..36]) catch return false;
    if (offset != 32) return false;
    const len = evm.codecs.uintWord(usize, bytes[36..68]) catch return false;
    if (len > bytes.len - 68) return false;
    return std.mem.indexOf(u8, bytes[68..][0..len], "ICA: Invalid Reveal") != null;
}

fn decodeHex(a: Allocator, text: []const u8) ![]u8 {
    if (text.len < 2 or text.len % 2 != 0) return error.InvalidHex;
    const out = try a.alloc(u8, (text.len - 2) / 2);
    errdefer a.free(out);
    _ = try evm.codecs.decodeHex(out, text);
    return out;
}

fn lowAddress(hash: Hash) Address {
    return hash[12..32].*;
}

fn checkCancelled(cancel: ?*const std.atomic.Value(bool)) !void {
    if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
}

pub fn hardFailure(err: anyerror) bool {
    return metadata_builder.hardFailure(err) or err == error.WrongChain or err == error.ChainIdOutOfRange;
}

fn finalityFailure(outcome: *Outcome, state: RetryState, observed_at: ?operation.Times, err: anyerror) !Outcome {
    // A valid latest-delivered proof starts confirmation even if the extra
    // finality read temporarily fails. Only known peer/transport failures wait;
    // control flow, deadlines, refusal and malformed/corrupt data propagate.
    switch (err) {
        error.RpcError, error.RpcHttpStatus, error.CurlTransportFailed, error.BrokenPipe, error.ConnectionResetByPeer, error.ConnectionAborted, error.SocketNotConnected => {},
        else => return err,
    }
    outcome.value = .{ .finality_wait = .{ .retry_state = state, .observed_at = observed_at, .failure = @errorName(err) } };
    return outcome.*;
}

fn retry(outcome: *Outcome, reason: RetryReason, err: anyerror, state: RetryState, cached: ?[]const u8) !Outcome {
    if (hardFailure(err)) return err;
    return retryFailure(outcome, reason, @errorName(err), state, cached);
}

fn retryFailure(outcome: *Outcome, reason: RetryReason, failure: ?[]const u8, state: RetryState, cached: ?[]const u8) !Outcome {
    outcome.value = .{ .retry = .{ .reason = reason, .failure = failure, .retry_state = state, .cached_metadata = cached } };
    return outcome.*;
}

fn retryDelay(outcome: *Outcome, reason: RetryReason, err: anyerror, state: RetryState, delay: u64, cached: ?[]const u8) !Outcome {
    var result = try retry(outcome, reason, err, state, cached);
    result.value.retry.delay_ms = delay;
    outcome.value = result.value;
    return outcome.*;
}

fn retryDelayFailure(outcome: *Outcome, reason: RetryReason, failure: ?[]const u8, state: RetryState, delay: u64, cached: ?[]const u8) !Outcome {
    outcome.value = .{ .retry = .{ .reason = reason, .failure = failure, .delay_ms = delay, .retry_state = state, .cached_metadata = cached } };
    return outcome.*;
}

fn retryDiagnostics(outcome: *Outcome, reason: RetryReason, err: ?anyerror, state: RetryState, cached: ?[]const u8, diagnostics: Diagnostics) !Outcome {
    if (err) |actual| if (hardFailure(actual)) return actual;
    outcome.value = .{ .retry = .{ .reason = reason, .failure = if (err) |actual| @errorName(actual) else null, .retry_state = state, .cached_metadata = cached, .diagnostics = diagnostics } };
    return outcome.*;
}
