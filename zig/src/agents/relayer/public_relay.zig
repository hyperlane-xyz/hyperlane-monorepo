//! Concrete public /relay submission owner with retained sources and atomic admission.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const types = @import("../../settings/types.zig");
const protocol = @import("../../protocol/root.zig");
const relay_api = @import("../../ops/admin/relay_api.zig");
const resources = @import("../chain_source.zig");
const origins = @import("../origin_tasks.zig");
const control = @import("control.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const db = @import("../../db/root.zig");
const cancel_gate = @import("../../runtime/cancel_gate.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);
const extraction_timeout_ms: u32 = 5000;
const admission_timeout_ms: u64 = 250;
const command_recovery_timeout_ms: u64 = 10_000;
const max_messages: usize = 10;

const Payment = struct { value: db.codec.GasPayment, meta: db.codec.GasPaymentMeta };
const Extraction = struct {
    allocator: A,
    transaction: [64]u8,
    messages: []protocol.Message,
    payments: []Payment,

    fn deinit(self: *Extraction) void {
        for (self.messages) |message| self.allocator.free(message.body);
        self.allocator.free(self.messages);
        self.allocator.free(self.payments);
        self.* = undefined;
    }
};

const TransportScope = struct {
    client: *rpc.RpcClient,
    original: rpc.Options,
    timer: std.time.Timer,
    timeout_ms: u32,
    owner_deadline_ns: u64,

    fn init(client: *rpc.RpcClient, timer: std.time.Timer, timeout_ms: u32, owner_deadline_ns: u64) TransportScope {
        return .{ .client = client, .original = client.options, .timer = timer, .timeout_ms = timeout_ms, .owner_deadline_ns = owner_deadline_ns };
    }
    fn remaining(self: *TransportScope) !u32 {
        const total = @as(u64, self.timeout_ms) * std.time.ns_per_ms;
        const elapsed = self.timer.read();
        if (elapsed >= total) return error.RelayExtractionDeadline;
        return @intCast((total - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
    }
    fn beforeCall(self: *TransportScope) !void {
        const remaining_ms = try self.remaining();
        self.client.options.owner_deadline_ns = @min(self.original.owner_deadline_ns orelse self.owner_deadline_ns, self.owner_deadline_ns);
        self.client.options.timeout_ms = @min(self.original.timeout_ms, remaining_ms);
        self.client.options.connect_timeout_ms = @min(self.original.connect_timeout_ms, self.client.options.timeout_ms);
    }
    fn check(self: *TransportScope) !void {
        _ = try self.remaining();
    }
    fn deinit(self: *TransportScope) void {
        self.client.options = self.original;
        self.* = undefined;
    }
};

const SourceSlot = struct {
    owner: *PublicRelay,
    chain: *const types.Chain,
    gate: cancel_gate.Gate = .{},
    network: ?*resources.Resources = null,
    checked: bool = false,

    fn extract(self: *SourceSlot, a: A, transaction: [64]u8, hash_text: []const u8, cancel: Cancel) !Extraction {
        if (self.chain.protocol != .ethereum) return error.UnsupportedRelayChain;
        const started_ns = try @import("../../cloud/http.zig").rpcNowNs();
        const timer = try std.time.Timer.start();
        try self.gate.lock(cancel);
        defer self.gate.unlock();
        if (self.network == null) self.network = try resources.Resources.open(self.owner.allocator, self.chain, self.owner.environment, self.owner.options);
        const network = self.network.?;
        network.setCancellation(cancel);
        defer network.setCancellation(null);
        const client = &network.rpc_client.?;
        var scope = TransportScope.init(client, timer, self.owner.extraction_timeout_ms, started_ns +| @as(u64, self.owner.extraction_timeout_ms) * std.time.ns_per_ms);
        defer scope.deinit();
        if (!self.checked) {
            try scope.beforeCall();
            try client.checkChain(try std.fmt.parseInt(u256, self.chain.chain_id, 0));
            self.checked = true;
            try scope.check();
        }
        try scope.beforeCall();
        var receipt = try client.call("eth_getTransactionReceipt", .{hash_text});
        defer receipt.deinit();
        try scope.check();
        if (receipt.value() == .null) return error.RelayReceiptUnavailable;
        if (receipt.value() != .object) return error.InvalidRelayReceipt;
        const raw_logs = receipt.value().object.get("logs") orelse return error.InvalidRelayReceipt;
        if (raw_logs != .array) return error.InvalidRelayReceipt;
        var logs = std.array_list.Managed(rpc.Log).init(a);
        defer {
            for (logs.items) |*log| log.deinit();
            logs.deinit();
        }
        for (raw_logs.array.items) |raw| {
            if (cancel.load(.acquire)) return error.RequestCancelled;
            const log = try rpc.Log.parse(a, raw);
            errdefer {
                var owned = log;
                owned.deinit();
            }
            try logs.append(log);
        }
        return decodeReceipt(self.chain, a, transaction, logs.items, cancel);
    }
};

fn decodeReceipt(chain: *const types.Chain, a: A, transaction: [64]u8, logs: []const rpc.Log, cancel: Cancel) !Extraction {
    const transaction_hash = transaction[32..64].*;
    var result: Extraction = .{ .allocator = a, .transaction = transaction, .messages = &.{}, .payments = &.{} };
    errdefer result.deinit();
    var messages = std.array_list.Managed(protocol.Message).init(a);
    defer messages.deinit();
    var payments = std.array_list.Managed(Payment).init(a);
    defer payments.deinit();
    errdefer for (messages.items) |message| a.free(message.body);
    var message_sent: usize = 0;
    for (logs) |log| {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (!std.mem.eql(u8, &log.transaction_hash, &transaction_hash)) return error.ReceiptLogTransactionMismatch;
        if (isCctpTransmitter(log.address) and log.topic_count > 0 and std.mem.eql(u8, &log.topics[0], &message_sent_topic)) message_sent += 1;
        if (std.mem.eql(u8, &log.address, chain.contracts.mailbox[12..32]) and log.topic_count > 0 and std.mem.eql(u8, &log.topics[0], &abi.dispatch_topic)) {
            const event = try log.event();
            if (event != .dispatch) return error.InvalidRelayDispatch;
            const message = try protocol.Message.decode(event.dispatch.message);
            if (message.origin != chain.domain) return error.ReceiptOriginMismatch;
            if (messages.items.len == max_messages) return error.TooManyRelayMessages;
            var owned = message;
            owned.body = try a.dupe(u8, message.body);
            errdefer a.free(owned.body);
            try messages.append(owned);
        }
        if (std.mem.eql(u8, &log.address, chain.contracts.interchain_gas_paymaster[12..32]) and log.topic_count > 0 and std.mem.eql(u8, &log.topics[0], &abi.gas_payment_topic)) {
            const event = try log.event();
            if (event != .gas_payment) return error.InvalidRelayGasPayment;
            try payments.append(.{
                .value = .{ .message_id = event.gas_payment.message_id, .destination = event.gas_payment.destination, .payment = event.gas_payment.payment, .gas_amount = event.gas_payment.gas_amount },
                .meta = .{ .transaction_id = transaction, .log_index = log.log_index },
            });
        }
    }
    if (messages.items.len == 0) return error.NoRelayMessages;
    if (message_sent == 0 or message_sent != messages.items.len) return error.NotCctpV2;
    result.messages = try messages.toOwnedSlice();
    result.payments = try payments.toOwnedSlice();
    return result;
}

const PendingPhase = enum { abort, commit };
const Pending = struct {
    id: u64,
    origin_chain: []u8,
    tx_hash: []u8,
    transaction: [64]u8,
    domains: []u32,
    attempted: usize,
    next: usize,
    phase: PendingPhase,
    messages: []relay_api.RelayMessage,
    admission_seconds: f64 = 0,

    fn deinit(self: *Pending, a: A) void {
        a.free(self.origin_chain);
        a.free(self.tx_hash);
        a.free(self.domains);
        a.free(self.messages);
        a.destroy(self);
    }
};

pub const OriginAuthority = struct {
    context: *anyopaque,
    handle_fn: *const fn (*anyopaque, u32) ?origins.Handle,
};

pub const PublicRelay = struct {
    allocator: A,
    settings: *const settings.Settings,
    environment: *const std.process.EnvMap,
    authority: OriginAuthority,
    hub: *control.Hub,
    options: resources.Options,
    sources: []SourceSlot,
    admission_gate: cancel_gate.Gate = .{},
    extraction_timeout_ms: u32 = extraction_timeout_ms,
    next_batch: u64 = 1,
    pending: ?*Pending = null,

    pub fn init(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, origin_set: *origins.Set, hub: *control.Hub, options: resources.Options) !*PublicRelay {
        return initWithAuthority(a, configured, environment, .{ .context = origin_set, .handle_fn = originHandle }, hub, options);
    }

    pub fn initWithAuthority(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, authority: OriginAuthority, hub: *control.Hub, options: resources.Options) !*PublicRelay {
        if (configured.role != .relayer or configured.chains.len == 0 or configured.chains.len > 1024) return error.InvalidPublicRelay;
        const self = try a.create(PublicRelay);
        errdefer a.destroy(self);
        const sources = try a.alloc(SourceSlot, configured.chains.len);
        for (sources, configured.chains) |*slot, *chain| slot.* = .{ .owner = self, .chain = chain };
        self.* = .{ .allocator = a, .settings = configured, .environment = environment, .authority = authority, .hub = hub, .options = options, .sources = sources };
        return self;
    }

    pub fn deinit(self: *PublicRelay) void {
        if (self.pending) |pending| pending.deinit(self.allocator);
        for (self.sources) |*slot| if (slot.network) |network| network.deinit();
        self.allocator.free(self.sources);
        self.allocator.destroy(self);
    }

    pub fn submissionOwner(self: *PublicRelay) relay_api.SubmissionOwner {
        return .{ .context = self, .submit_fn = submit };
    }

    fn source(self: *PublicRelay, name: []const u8) ?*SourceSlot {
        for (self.sources) |*slot| if (std.mem.eql(u8, slot.chain.name, name)) return slot;
        return null;
    }
};

fn submit(context: *anyopaque, a: A, origin_chain: []const u8, tx_hash: []const u8, cancel: Cancel) anyerror!relay_api.RelayResult {
    const self: *PublicRelay = @ptrCast(@alignCast(context));
    if (cancel.load(.acquire)) return error.RequestCancelled;
    const parsed = parseTransactionHash(a, tx_hash) catch |err| return extractionFailure(err);
    defer a.free(parsed.text);
    const slot = self.source(origin_chain) orelse return failed(.invalid_request, .extraction_failed, "Failed to extract messages: Chain not found in registry");
    var extracted = slot.extract(a, parsed.full, parsed.text, cancel) catch |err| return extractionFailure(err);
    defer extracted.deinit();
    if (extracted.messages.len > max_messages) return failed(.invalid_request, .too_many_messages, "Transaction contains too many messages");
    const admission_messages = try a.alloc(relay_api.RelayMessage, extracted.messages.len);
    defer a.free(admission_messages);
    for (extracted.messages, admission_messages) |message, *output| {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.hub.relayControl(message.destination) == null) return failed(.invalid_request, .send_failed, "Unsupported destination");
        var decision = try self.hub.gateway_policy.check(message);
        defer decision.deinit();
        if (decision.denial) |denial| return policyFailure(denial);
        const origin = self.authority.handle_fn(self.authority.context, message.origin) orelse return failed(.internal, .send_failed, "Message context not found");
        const retry_state = try origin.store.retryState(message.id());
        const status = try origin.store.status(message.id());
        if (retriesExhausted(retry_state, status, try origin.store.retryCount(message.id()))) return failed(.invalid_request, .retries_exhausted, "Message has exhausted its maximum retries and cannot be re-submitted");
        output.* = .{ .message_id = message.id(), .origin = message.origin, .destination = message.destination, .nonce = message.nonce };
    }
    for (extracted.payments) |payment| {
        const origin = self.authority.handle_fn(self.authority.context, extracted.messages[0].origin) orelse continue;
        _ = origin.store.storePayment(payment.value, payment.meta) catch {};
    }
    return admit(self, a, origin_chain, tx_hash, extracted, admission_messages, cancel);
}

fn admit(self: *PublicRelay, a: A, origin_chain: []const u8, tx_hash: []const u8, extracted: Extraction, messages: []relay_api.RelayMessage, cancel: Cancel) !relay_api.RelayResult {
    try self.admission_gate.lock(cancel);
    defer self.admission_gate.unlock();
    if (self.pending) |pending| {
        if (pending.phase == .abort) {
            driveAbort(self, pending) catch |err| return admissionErrorTimed(err, pending.admission_seconds);
            pending.deinit(self.allocator);
            self.pending = null;
        } else {
            if (!std.mem.eql(u8, pending.origin_chain, origin_chain) or !std.mem.eql(u8, pending.tx_hash, tx_hash)) return failed(.service_unavailable, .send_failed, "Processor admission recovery pending");
            const result = try driveCommit(self, a, pending);
            return result;
        }
    }
    sortMessagesByDomain(extracted.messages);
    const domains = try uniqueSortedDomains(self.allocator, extracted.messages);
    const pending = try createPending(self, origin_chain, tx_hash, extracted.transaction, domains, messages);
    self.next_batch +%= 1;
    self.pending = pending;
    var timer = try std.time.Timer.start();
    for (domains) |domain| {
        const destination = self.hub.relayControl(domain).?;
        const batch = messagesForDomain(extracted.messages, domain);
        pending.attempted += 1;
        const remaining = admission_timeout_ms -| (timer.read() / std.time.ns_per_ms);
        self.hub.relayReserve(destination, pending.id, extracted.transaction, batch, remaining, cancel) catch |err| {
            if (err == error.OutOfMemory) return err;
            pending.admission_seconds = @as(f64, @floatFromInt(timer.read())) / std.time.ns_per_s;
            pending.next = 0;
            driveAbort(self, pending) catch |cleanup_err| return admissionErrorTimed(cleanup_err, pending.admission_seconds);
            pending.deinit(self.allocator);
            self.pending = null;
            if (err == error.RequestCancelled) return err;
            return admissionErrorTimed(err, pending.admission_seconds);
        };
    }
    for (domains) |domain| {
        self.hub.relayAuthorize(self.hub.relayControl(domain).?, pending.id, command_recovery_timeout_ms, &independent_cancel) catch |err| {
            if (err == error.OutOfMemory) return err;
            pending.admission_seconds = @as(f64, @floatFromInt(timer.read())) / std.time.ns_per_s;
            pending.next = 0;
            driveAbort(self, pending) catch |cleanup_err| return admissionErrorTimed(cleanup_err, pending.admission_seconds);
            pending.deinit(self.allocator);
            self.pending = null;
            return admissionErrorTimed(err, pending.admission_seconds);
        };
    }
    pending.admission_seconds = @as(f64, @floatFromInt(timer.read())) / std.time.ns_per_s;
    pending.phase = .commit;
    pending.next = 0;
    return driveCommit(self, a, pending);
}

fn createPending(self: *PublicRelay, origin_chain: []const u8, tx_hash: []const u8, transaction: [64]u8, domains: []u32, messages: []const relay_api.RelayMessage) !*Pending {
    const pending = self.allocator.create(Pending) catch |err| {
        self.allocator.free(domains);
        return err;
    };
    pending.* = .{
        .id = self.next_batch,
        .origin_chain = &.{},
        .tx_hash = &.{},
        .transaction = transaction,
        .domains = domains,
        .attempted = 0,
        .next = 0,
        .phase = .abort,
        .messages = &.{},
    };
    errdefer pending.deinit(self.allocator);
    pending.origin_chain = try self.allocator.dupe(u8, origin_chain);
    pending.tx_hash = try self.allocator.dupe(u8, tx_hash);
    pending.messages = try self.allocator.dupe(relay_api.RelayMessage, messages);
    return pending;
}

fn sortMessagesByDomain(messages: []protocol.Message) void {
    var index: usize = 1;
    while (index < messages.len) : (index += 1) {
        const current = messages[index];
        var position = index;
        while (position > 0 and messages[position - 1].destination > current.destination) : (position -= 1) messages[position] = messages[position - 1];
        messages[position] = current;
    }
}

fn messagesForDomain(messages: []const protocol.Message, domain: u32) []const protocol.Message {
    var first: usize = 0;
    for (messages, 0..) |message, index| {
        if (message.destination == domain) {
            first = index;
            break;
        }
    }
    var last = first;
    while (last < messages.len and messages[last].destination == domain) last += 1;
    return messages[first..last];
}

fn uniqueSortedDomains(a: A, messages: []const protocol.Message) ![]u32 {
    const domains = try a.alloc(u32, messages.len);
    errdefer a.free(domains);
    var count: usize = 0;
    for (messages) |message| {
        var found = false;
        for (domains[0..count]) |domain| {
            if (domain == message.destination) found = true;
        }
        if (!found) {
            domains[count] = message.destination;
            count += 1;
        }
    }
    const result = domains[0..count];
    std.mem.sort(u32, result, {}, std.sort.asc(u32));
    return a.realloc(domains, count);
}

fn driveCommit(self: *PublicRelay, a: A, pending: *Pending) !relay_api.RelayResult {
    while (pending.next < pending.domains.len) {
        const domain = pending.domains[pending.next];
        self.hub.relayCommit(self.hub.relayControl(domain).?, pending.id, command_recovery_timeout_ms, &independent_cancel) catch |err| return admissionErrorTimed(err, pending.admission_seconds);
        pending.next += 1;
    }
    const result = relay_api.RelayResult{ .messages = try a.dupe(relay_api.RelayMessage, pending.messages), .processor_admission_seconds = pending.admission_seconds };
    pending.deinit(self.allocator);
    self.pending = null;
    return result;
}

fn driveAbort(self: *PublicRelay, pending: *Pending) !void {
    while (pending.next < pending.attempted) {
        const domain = pending.domains[pending.next];
        try self.hub.relayAbort(self.hub.relayControl(domain).?, pending.id, command_recovery_timeout_ms, &independent_cancel);
        pending.next += 1;
    }
}

var independent_cancel = std.atomic.Value(bool).init(false);

fn retriesExhausted(versioned: ?db.json.RetryState, status: ?db.json.Status, legacy_count: u32) bool {
    if (status != null and status.? == .Retry and status.?.Retry == .Manual) return false;
    const count = if (versioned) |state| blk: {
        if (legacy_count > state.retry_count) break :blk legacy_count;
        break :blk state.retry_count;
    } else legacy_count;
    return count >= 1;
}

fn originHandle(context: *anyopaque, domain: u32) ?origins.Handle {
    const origin_set: *origins.Set = @ptrCast(@alignCast(context));
    for (origin_set.slots) |*slot| {
        const origin = slot.handle() orelse continue;
        if (origin.chain.domain == domain) return origin;
    }
    return null;
}

fn parseTransactionHash(a: A, text: []const u8) !struct { text: []u8, full: [64]u8 } {
    const digits = if (std.mem.startsWith(u8, text, "0x") or std.mem.startsWith(u8, text, "0X")) text[2..] else text;
    if (digits.len != 64) return error.InvalidTransactionHash;
    const normalized = try std.fmt.allocPrint(a, "0x{s}", .{digits});
    errdefer a.free(normalized);
    const hash = abi.fixedHex(32, normalized) catch return error.InvalidTransactionHash;
    var full: [64]u8 = @splat(0);
    full[32..64].* = hash;
    return .{ .text = normalized, .full = full };
}

const message_sent_topic = abi.topic("MessageSent(bytes)");
const mainnet_transmitter = abi.fixedHex(20, "0x81D40F21F12A8F0E3252Bccb954D" ++ "722d4c464B64") catch unreachable;
const edge_transmitter = abi.fixedHex(20, "0x5b61381Fc9e58E70EfC13a4A975169" ++ "97019198ee") catch unreachable;
const testnet_transmitter = abi.fixedHex(20, "0xE737e5cEBEEBa77EFE34D4aa090756" ++ "590b1CE275") catch unreachable;

fn isCctpTransmitter(address: [20]u8) bool {
    return std.mem.eql(u8, &address, &mainnet_transmitter) or std.mem.eql(u8, &address, &edge_transmitter) or std.mem.eql(u8, &address, &testnet_transmitter);
}

fn failed(kind: relay_api.FailureKind, metric: relay_api.FailureMetric, body: []const u8) relay_api.RelayResult {
    return .{ .failure = .{ .kind = kind, .metric = metric, .body = body } };
}

fn extractionFailure(err: anyerror) anyerror!relay_api.RelayResult {
    return switch (err) {
        error.OutOfMemory, error.RequestCancelled => err,
        error.RelayReceiptUnavailable, error.RelayExtractionDeadline, error.RequestDeadlineExceeded, error.SourceReadDeadline => failed(.request_timeout, .timeout, "Request timeout"),
        error.TooManyRelayMessages => failed(.invalid_request, .too_many_messages, "Transaction contains too many messages"),
        error.NotCctpV2, error.UnsupportedRelayChain => failed(.invalid_request, .not_cctp_v2, "Only EVM CCTP V2 messages are supported via the relay API"),
        error.NoRelayMessages => failed(.invalid_request, .extraction_failed, "Failed to extract messages: No Hyperlane Dispatch events found in transaction"),
        error.InvalidTransactionHash => failed(.invalid_request, .extraction_failed, "Failed to extract messages: Invalid tx hash format"),
        else => failed(.invalid_request, .extraction_failed, "Failed to extract messages: Failed to fetch transaction logs"),
    };
}

fn policyFailure(denial: @import("../relay_policy.zig").Denial) relay_api.RelayResult {
    return switch (denial) {
        .not_whitelisted => failed(.invalid_request, .message_not_whitelisted, "Message not whitelisted"),
        .message_blacklisted => failed(.invalid_request, .message_blacklisted, "Message blacklisted"),
        .address_blacklisted => failed(.invalid_request, .message_blacklisted_address, "Message rejected"),
        .runtime_denylisted => failed(.invalid_request, .message_runtime_denylisted, "Message rejected"),
    };
}

fn admissionError(err: anyerror) anyerror!relay_api.RelayResult {
    return switch (err) {
        error.OutOfMemory, error.RequestCancelled => err,
        error.CommandDeadline, error.CommandQueueFull, error.ProcessorCapacityUnavailable => failed(.service_unavailable, .processor_saturated, "Processor capacity unavailable"),
        error.MessageContextNotFound => failed(.invalid_request, .send_failed, "Unsupported destination"),
        else => failed(.internal, .send_failed, "Failed to reserve processor channel capacity"),
    };
}

fn admissionErrorTimed(err: anyerror, seconds: f64) anyerror!relay_api.RelayResult {
    var result = try admissionError(err);
    if (result.failure) |*failure| failure.processor_admission_seconds = seconds;
    result.processor_admission_seconds = seconds;
    return result;
}

const ReceiptFixture = struct {
    chain: types.Chain,
    transaction: [64]u8,
    logs: [3]rpc.Log,
    cancel: std.atomic.Value(bool) = .init(false),

    fn init(a: A) !ReceiptFixture {
        var chain: types.Chain = undefined;
        chain.domain = 1;
        chain.contracts.mailbox = @splat(0);
        chain.contracts.mailbox[12..32].* = @splat(1);
        chain.contracts.interchain_gas_paymaster = @splat(0);
        chain.contracts.interchain_gas_paymaster[12..32].* = @splat(2);
        const message: protocol.Message = .{ .version = 3, .nonce = 7, .origin = 1, .destination = 2, .sender = chain.contracts.mailbox, .recipient = chain.contracts.interchain_gas_paymaster, .body = "receipt" };
        const encoded = try message.encodeAlloc(a);
        defer a.free(encoded);
        const padded = (encoded.len + 31) / 32 * 32;
        const dispatch_data = try a.alloc(u8, 64 + padded);
        @memset(dispatch_data, 0);
        std.mem.writeInt(u256, dispatch_data[0..32], 32, .big);
        std.mem.writeInt(u256, dispatch_data[32..64], encoded.len, .big);
        @memcpy(dispatch_data[64..][0..encoded.len], encoded);
        const gas_data = try a.alloc(u8, 64);
        @memset(gas_data, 0);
        std.mem.writeInt(u256, gas_data[0..32], 200, .big);
        std.mem.writeInt(u256, gas_data[32..64], 100, .big);
        const cctp_data = try a.dupe(u8, "");
        var transaction: [64]u8 = @splat(0);
        transaction[32..64].* = @splat(7);
        var logs: [3]rpc.Log = undefined;
        logs[0] = .{ .allocator = a, .address = chain.contracts.mailbox[12..32].*, .topics = .{ abi.dispatch_topic, message.sender, @splat(0), message.recipient }, .topic_count = 4, .data = dispatch_data, .block_number = 1, .block_hash = @splat(9), .transaction_hash = transaction[32..64].*, .transaction_index = 0, .log_index = 0 };
        logs[0].topics[2][31] = 2;
        logs[1] = .{ .allocator = a, .address = chain.contracts.interchain_gas_paymaster[12..32].*, .topics = .{ abi.gas_payment_topic, message.id(), @splat(0), @splat(0) }, .topic_count = 3, .data = gas_data, .block_number = 1, .block_hash = @splat(9), .transaction_hash = transaction[32..64].*, .transaction_index = 0, .log_index = 1 };
        logs[1].topics[2][31] = 2;
        logs[2] = .{ .allocator = a, .address = mainnet_transmitter, .topics = .{ message_sent_topic, @splat(0), @splat(0), @splat(0) }, .topic_count = 1, .data = cctp_data, .block_number = 1, .block_hash = @splat(9), .transaction_hash = transaction[32..64].*, .transaction_index = 0, .log_index = 2 };
        return .{ .chain = chain, .transaction = transaction, .logs = logs };
    }

    fn deinit(self: *ReceiptFixture) void {
        for (&self.logs) |*log| log.deinit();
        self.* = undefined;
    }
};

fn receiptSweep(a: A, fixture: *ReceiptFixture) !void {
    var result = try decodeReceipt(&fixture.chain, a, fixture.transaction, &fixture.logs, &fixture.cancel);
    defer result.deinit();
}

pub const testing = struct {
    pub fn checkPendingAllocationFailures() !void {
        try std.testing.checkAllAllocationFailures(std.testing.allocator, pendingSweep, .{});
    }
    fn pendingSweep(a: A) !void {
        var owner: PublicRelay = undefined;
        owner.allocator = a;
        owner.next_batch = 1;
        const domains = try a.dupe(u32, &.{1});
        const pending = try createPending(&owner, "origin", "public-hash", @splat(0), domains, &.{.{ .message_id = @splat(1), .origin = 2, .destination = 1, .nonce = 0 }});
        defer pending.deinit(a);
    }
    pub fn checkReceiptAllocationFailures() !void {
        var fixture = try ReceiptFixture.init(std.testing.allocator);
        defer fixture.deinit();
        try std.testing.checkAllAllocationFailures(std.testing.allocator, receiptSweep, .{&fixture});
    }
};
