//! Independent self-announcement worker. Owns every mutable HTTP/KMS/transaction
//! object; checkpoint jobs communicate only through the bounded durable mailbox.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const config = @import("config.zig");
const queue = @import("mailbox.zig");
const native_announcement = @import("announcement.zig");
const DatabaseOwner = @import("../origin_tasks.zig").DatabaseOwner;
const supervisor = @import("../../runtime/supervisor.zig");
const Curl = @import("../../net/curl.zig");
const cloud = @import("../../cloud/root.zig");
const lander = @import("../../lander/root.zig");
const evm = @import("../../evm/root.zig");
const A = std.mem.Allocator;
pub const Credentials = struct { context: *anyopaque, lease: *const fn (*anyopaque, u64) anyerror!config.Credentials };
pub const ChainSigner = struct { context: *anyopaque, load: *const fn (*anyopaque, config.Credentials) anyerror!lander.Signer };
pub const Options = struct { curl_library: []const u8, request_timeout_ms: u32 = 20000, job_timeout_ms: u64 = 120000, environment: ?*const std.process.EnvMap = null, allow_insecure_loopback: bool = false };
pub const Worker = struct {
    allocator: A,
    settings: *const settings.Settings,
    options: Options,
    mailbox: *queue.Mailbox,
    database: *DatabaseOwner,
    native: ?Curl.Client = null,
    http: cloud.http.HttpTransport,
    credentials: ?Credentials = null,
    chain_signer: ?ChainSigner = null,
    native_owner: ?*native_announcement.Owner = null,
    transaction_client: ?evm.RpcClient = null,
    chain_adapter: ?lander.evm.Evm = null,
    transactions: ?lander.Service = null,
    loaded_digest: ?[32]u8 = null,
    loaded_revision: ?u64 = null,
    empty_environment: std.process.EnvMap,
    date: [16]u8 = undefined,
    halt_signal: ?*std.atomic.Value(bool) = null,
    guarded_signer: ?lander.Signer = null,
    idle_cancel: std.atomic.Value(bool) = .init(false),
    pub fn init(a: A, s: *const settings.Settings, database: *DatabaseOwner, mailbox: *queue.Mailbox, options: Options) !*Worker {
        const self = try a.create(Worker);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .settings = s, .database = database, .mailbox = mailbox, .options = options, .http = cloud.http.HttpTransport.init(a), .empty_environment = std.process.EnvMap.init(a) };
        self.http.allow_insecure_loopback = options.allow_insecure_loopback;
        return self;
    }
    /// Configure only before the supervisor starts (or after every job joins).
    pub fn setProviders(self: *Worker, credentials: ?Credentials, signer: ?ChainSigner) void {
        self.credentials = credentials;
        self.chain_signer = signer;
    }
    pub fn deinit(self: *Worker) void {
        if (self.native_owner) |owner| owner.deinit();
        if (self.transactions) |*transactions| transactions.deinit();
        if (self.transaction_client) |*client| client.deinit();
        self.empty_environment.deinit();
        self.http.deinit();
        if (self.native) |*native| native.deinit();
        self.allocator.destroy(self);
    }
    pub fn descriptor(self: *Worker) supervisor.Task {
        return .{ .context = self, .run = run, .failure = failure, .interval_ms = @max(1, self.settings.role.validator.interval *| 1000), .timeout_ms = self.options.job_timeout_ms, .wake = &self.mailbox.pending };
    }
    fn failure(err: anyerror) supervisor.FailureAction {
        return switch (err) {
            error.OperationContextChanged, error.ValidatorIdentityMismatch, error.AnnouncementMailboxConflict, error.StaleNativeOperationOwner => .halt_all,
            else => .retry,
        };
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        return (@as(*Worker, @ptrCast(@alignCast(context)))).tick(times, cancel);
    }
    pub fn tick(self: *Worker, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        try self.checkEffects();
        _ = self.mailbox.pending.swap(false, .acq_rel);
        if (self.settings.role.validator.skip_announce) return .{};
        var request = try self.mailbox.read(cancel) orelse return .{};
        defer request.deinit();
        const chain = self.settings.chainByName(self.settings.role.validator.origin_chain) orelse return error.UnknownOriginChain;
        // Both descriptors may start together on restart. Read the durable guard
        // before credential/signing effects, without relying on Role initialization.
        if (try @import("../validator.zig").Service.persistedHalt(self.allocator, try self.database.get(cancel), chain.name)) {
            if (self.halt_signal) |signal| signal.store(true, .release);
            return error.CheckpointEffectsHalted;
        }
        try self.checkEffects();
        if ((request.wire.kind == .ethereum) != (chain.protocol == .ethereum)) return error.AnnouncementAuthorityMismatch;
        if (request.wire.complete and chain.protocol != .ethereum) {
            if (self.native_owner) |owner| try owner.observedAnnounced(.{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms });
            return .{};
        }
        if (request.wire.complete and self.transactions == null) return .{};
        if (self.native == null) self.native = try Curl.Client.init(self.allocator, self.options.curl_library);
        self.http.native_curl = &self.native.?;
        self.http.cancel = cancel;
        defer self.http.cancel = null;
        const credentials = if (self.credentials) |provider| try provider.lease(provider.context, times.unix_ms / 1000) else config.Credentials{ .transport = self.http.interface(), .http_owner = &self.http, .amz_date = try @import("date.zig").amzDate(&self.date, times.unix_ms / 1000) };
        if (chain.protocol == .ethereum) {
            if (request.target == null or !std.mem.eql(u8, &chain.contracts.validator_announce, &padded(request.target.?))) return error.AnnouncementAuthorityMismatch;
            const call = try @import("../../evm/announce.zig").decodeAnnouncementCall(request.calldata.?);
            const value: @import("../../storage/objects.zig").Announcement = .{ .validator = call.validator, .mailbox_address = chain.contracts.mailbox, .mailbox_domain = chain.domain, .storage_location = call.location };
            if (!std.mem.eql(u8, &value.digest(), &request.digest) or !std.mem.eql(u8, &try @import("../../protocol/root.zig").signature.recover(value.digest(), call.signature), &call.validator)) return error.AnnouncementAuthorityMismatch;
            const provider = self.chain_signer orelse return error.MissingChainSignerFactory;
            self.guarded_signer = try provider.load(provider.context, credentials);
            const signer: lander.Signer = .{ .context = self, .address = self.guarded_signer.?.address, .sign_fn = guardedSign };
            if (self.transaction_client == null) self.transaction_client = try evm.RpcClient.init(self.allocator, chain.rpc_urls[0], .{ .native_transport = &self.native.?, .timeout_ms = self.options.request_timeout_ms });
            self.transaction_client.?.options.cancel = cancel;
            defer self.transaction_client.?.options.cancel = null;
            if (self.transactions == null) {
                // Rust MevSubmission.matches returns false before decoding when
                // target != Mailbox. ValidatorAnnounce payloads use ordinary RPC.
                self.chain_adapter = .{ .rpc = &self.transaction_client.?, .reorg = chain.reorg };
                self.transactions = try lander.Service.open(self.allocator, lander.Store.init(try self.database.get(cancel), chain.name), self.chain_adapter.?.interface(), .{ .domain_name = chain.name, .chain_id = try std.fmt.parseInt(u256, chain.chain_id, 0), .signer = signer, .overrides = chain.connection.ethereum.transaction_overrides, .max_batch_size = chain.max_batch_size, .arbitrum_nitro = chain.technical_stack == .arbitrumnitro, .zksync_stack = chain.technical_stack == .zksync, .estimated_block_time_ms = @intFromFloat(@max(1, chain.estimated_block_time * 1000)) }, cancel);
            }
            const transactions = &self.transactions.?;
            transactions.config.signer = signer;
            transactions.cancel = cancel;
            defer transactions.cancel = &self.idle_cancel;
            // Recover prior persisted transactions before accepting this request.
            try self.checkEffects();
            _ = try transactions.tick(times.unix_ms, .{});
            if (!request.wire.complete and (self.loaded_digest == null or !std.mem.eql(u8, &self.loaded_digest.?, &request.digest) or self.loaded_revision != request.wire.revision)) {
                try self.checkEffects();
                try self.enqueueEvm(transactions, request.digest, request.wire.revision, request.target.?, request.calldata.?);
                self.loaded_digest = request.digest;
                self.loaded_revision = request.wire.revision;
                return .{ .next_delay_ms = 0 };
            }
            return .{};
        }
        const signed = request.signed orelse return error.InvalidAnnouncementMailbox;
        if (signed.value.value.mailbox_domain != chain.domain or !std.mem.eql(u8, &signed.value.value.mailbox_address, &chain.contracts.mailbox)) return error.AnnouncementAuthorityMismatch;
        if (self.loaded_digest == null or !std.mem.eql(u8, &self.loaded_digest.?, &request.digest) or self.loaded_revision != request.wire.revision) {
            if (self.native_owner) |owner| {
                owner.deinit();
                self.native_owner = null;
            }
            const environment = self.options.environment orelse &self.empty_environment;
            self.native_owner = try native_announcement.Owner.open(self.allocator, try self.database.get(cancel), chain, environment, chain.signer orelse return error.MissingNativeChainSigner, credentials, signed.value.value, .{ .clients = .{ .curl_library = self.options.curl_library, .request_timeout_ms = self.options.request_timeout_ms, .allow_insecure_loopback = self.options.allow_insecure_loopback }, .destination = .{ .starknet_crypto_library = environment.get("HYPERLANE_STARKNET_CRYPTO_LIBRARY"), .aleo_parameter_home = environment.get("HYPERLANE_ALEO_PARAMETER_HOME"), .allow_fixture_transport = self.options.allow_insecure_loopback, .concurrent_svm_estimates = self.allocator.vtable == std.heap.smp_allocator.vtable }, .interval_ms = @max(1, self.settings.role.validator.interval *| 1000), .revision = request.wire.revision });
            self.loaded_digest = request.digest;
            self.loaded_revision = request.wire.revision;
        }
        const owner = self.native_owner.?;
        try owner.refresh(credentials);
        owner.resources.setCancellation(cancel);
        defer owner.resources.setCancellation(null);
        try self.checkEffects();
        try owner.enqueue(signed.value);
        if (request.wire.complete) {
            try owner.observedAnnounced(.{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms });
            return .{};
        }
        const now = try @import("../scraper/receipts_evm.zig").nowNs();
        try self.checkEffects();
        const work = try owner.tick(.{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms }, .{ .unix_ms = times.unix_ms, .deadline_ns = now +| (self.options.job_timeout_ms *| std.time.ns_per_ms), .cancel = cancel, .halt = self.halt_signal });
        return .{ .work = work, .next_delay_ms = if (work > 0) 0 else null };
    }
    fn checkEffects(self: *Worker) !void {
        if (self.halt_signal) |signal| if (signal.load(.acquire)) return error.CheckpointEffectsHalted;
    }
    fn guardedSign(context: *anyopaque, digest: lander.types.Hash) !lander.types.Signature {
        const self: *Worker = @ptrCast(@alignCast(context));
        try self.checkEffects();
        return (self.guarded_signer orelse return error.MissingChainSignerFactory).sign(digest);
    }
    fn enqueueEvm(self: *Worker, transactions: *lander.Service, digest: [32]u8, revision: u64, to: [20]u8, data: []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const payload = try std.json.Stringify.valueAlloc(a, .{ .{ .type = "0x02", .chainId = try evm.codecs.quantityAlloc256(a, transactions.config.chain_id), .to = try evm.codecs.hexAlloc(a, &to), .data = try evm.codecs.hexAlloc(a, data), .value = "0x0", .maxFeePerGas = "0x0", .maxPriorityFeePerGas = "0x0" }, .{ .name = "announce", .inputs = .{ .{ .name = "validator", .type = "address" }, .{ .name = "storageLocation", .type = "string" }, .{ .name = "signature", .type = "bytes" } }, .outputs = .{.{ .name = "", .type = "bool" }}, .constant = @as(?bool, null), .stateMutability = "nonpayable" } }, .{});
        var target: [32]u8 = @splat(0);
        target[12..].* = to;
        const uuid = if (revision == 0) digest[0..16].* else blk: {
            var state = std.crypto.hash.sha2.Sha256.init(.{});
            state.update("HYPERLANE_VALIDATOR_REANNOUNCEMENT_V1");
            state.update(&digest);
            var bytes: [8]u8 = undefined;
            std.mem.writeInt(u64, &bytes, revision, .big);
            state.update(&bytes);
            break :blk state.finalResult()[0..16].*;
        };
        _ = try transactions.enqueue(.{ .payload = .{ .uuid = uuid, .metadata = try std.fmt.allocPrint(a, "validator_announcement:{s}", .{std.fmt.bytesToHex(digest, .lower)}), .data_json = payload, .to = target } });
    }
};

fn padded(address: [20]u8) [32]u8 {
    var out: [32]u8 = @splat(0);
    out[12..].* = address;
    return out;
}
