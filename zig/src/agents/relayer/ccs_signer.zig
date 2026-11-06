//! Role-owned CCS signing with one serialized credential/identity gate.
const std = @import("std");
const builtin = @import("builtin");
const settings = @import("../../settings/root.zig");
const credentials = @import("../credentials.zig");
const signing = @import("../signer.zig");
const cloud = @import("../../cloud/root.zig");
const curl = @import("../../net/curl.zig");
const ccip = @import("../../relayer/ccip.zig");
const protocol = @import("../../protocol/root.zig");
const origin_signers = @import("../origin_signers.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const Cancel = ?*const std.atomic.Value(bool);

pub const Options = struct {
    curl_library: []const u8,
    credential_options: credentials.Options = .{},
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 10000,
    halt: ?*const std.atomic.Value(bool) = null,
};

pub const Stats = struct {
    identity_loads: usize,
    leases: usize,
    signatures: usize,
    cancel_installed: bool,
};

const FixtureSignature = struct {
    context: *anyopaque,
    sign_fn: *const fn (*anyopaque, Hash) anyerror![65]u8,
};

const FixtureBeforeSign = struct {
    context: *anyopaque,
    before_fn: *const fn (*anyopaque) anyerror!void,
};

pub const Owner = struct {
    allocator: Allocator,
    filtered_settings: settings.Settings,
    filtered_chain: settings.Chain,
    native: curl.Client,
    transport: cloud.http.HttpTransport,
    manager: *credentials.Manager,
    digest_signer: ?*signing.DigestSigner = null,
    timeout_ms: u32,
    connect_timeout_ms: u32,
    gate: std.Thread.Mutex = .{},
    halt: ?*const std.atomic.Value(bool),
    stopping: bool = false,
    identity_loads: usize = 0,
    leases: usize = 0,
    signatures: usize = 0,
    fixture_signature: if (builtin.is_test) ?FixtureSignature else void = if (builtin.is_test) null else {},
    fixture_before_sign: if (builtin.is_test) ?FixtureBeforeSign else void = if (builtin.is_test) null else {},

    pub fn init(allocator: Allocator, configured: *const settings.Settings, chain: *const settings.Chain, environment: *const std.process.EnvMap, options: Options) !*Owner {
        if (options.timeout_ms == 0 or options.connect_timeout_ms == 0) return error.InvalidCcsDeadline;
        const self = try allocator.create(Owner);
        errdefer allocator.destroy(self);
        self.filtered_settings = configured.*;
        self.filtered_chain = chain.*;
        self.filtered_chain.signer = null;
        self.filtered_chain.identity = null;
        self.filtered_settings.chains = (&self.filtered_chain)[0..1];
        self.native = try curl.Client.init(allocator, options.curl_library);
        errdefer self.native.deinit();
        self.transport = cloud.http.HttpTransport.init(allocator);
        errdefer self.transport.deinit();
        self.transport.native_curl = &self.native;
        self.transport.timeout_ms = options.timeout_ms;
        self.transport.connect_timeout_ms = options.connect_timeout_ms;
        self.manager = try credentials.Manager.init(allocator, &self.filtered_settings, environment, &self.transport, options.credential_options);
        errdefer self.manager.deinit();
        self.*.allocator = allocator;
        self.*.timeout_ms = options.timeout_ms;
        self.*.connect_timeout_ms = options.connect_timeout_ms;
        self.*.gate = .{};
        self.*.halt = options.halt;
        self.*.digest_signer = null;
        self.*.stopping = false;
        self.*.identity_loads = 0;
        self.*.leases = 0;
        self.*.signatures = 0;
        if (comptime builtin.is_test) {
            self.*.fixture_signature = null;
            self.*.fixture_before_sign = null;
        }
        return self;
    }

    /// Metadata scopes and their callbacks must be joined before teardown.
    pub fn deinit(self: *Owner) void {
        self.gate.lock();
        self.stopping = true;
        if (self.digest_signer) |signer| signer.deinit();
        self.manager.deinit();
        self.transport.deinit();
        self.native.deinit();
        self.gate.unlock();
        const allocator = self.allocator;
        self.* = undefined;
        allocator.destroy(self);
    }

    pub fn stats(self: *Owner) Stats {
        self.gate.lock();
        defer self.gate.unlock();
        return .{ .identity_loads = self.identity_loads, .leases = self.leases, .signatures = self.signatures, .cancel_installed = self.transport.cancel != null or self.manager.metadata_transport.cancel != null };
    }

    pub fn installFixtureSignature(self: *Owner, context: *anyopaque, sign_fn: *const fn (*anyopaque, Hash) anyerror![65]u8) void {
        if (comptime !builtin.is_test) @compileError("CCS signature fixtures are test-only");
        self.fixture_signature = .{ .context = context, .sign_fn = sign_fn };
    }

    pub fn installFixtureBeforeSign(self: *Owner, context: *anyopaque, before_fn: *const fn (*anyopaque) anyerror!void) void {
        if (comptime !builtin.is_test) @compileError("CCS before-sign fixtures are test-only");
        self.fixture_before_sign = .{ .context = context, .before_fn = before_fn };
    }

    fn checkControl(self: *Owner, cancel: Cancel) !void {
        if (self.halt) |flag| if (flag.load(.acquire)) return error.GlobalEffectsHalted;
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
    }

    fn acquire(self: *Owner, cancel: Cancel, deadline_ns: u64) !origin_signers.WaitBudget {
        var budget = try origin_signers.WaitBudget.init(deadline_ns);
        while (!self.gate.tryLock()) {
            try self.checkControl(cancel);
            const remaining = try budget.remaining();
            std.Thread.sleep(@min(remaining, std.time.ns_per_ms));
        }
        errdefer self.gate.unlock();
        if (self.stopping) return error.CcsSignerStopped;
        try self.checkControl(cancel);
        const milliseconds = try budget.milliseconds();
        self.transport.cancel = cancel;
        self.transport.timeout_ms = @min(@as(u32, 30000), self.timeout_ms, milliseconds);
        self.transport.connect_timeout_ms = @min(@as(u32, 10000), self.connect_timeout_ms, milliseconds);
        return budget;
    }

    fn release(self: *Owner) void {
        self.transport.cancel = null;
        self.manager.metadata_transport.cancel = null;
        self.gate.unlock();
    }

    fn lease(self: *Owner) !signing.Credentials {
        const now = std.time.timestamp();
        if (now < 0) return error.UnsupportedClock;
        self.leases += 1;
        return self.manager.lease(@intCast(now));
    }

    fn ensureIdentity(self: *Owner, cancel: Cancel) !*signing.DigestSigner {
        if (self.digest_signer) |signer| return signer;
        const config = self.filtered_chain.ccs_signer orelse return error.MissingCcsSigner;
        try self.checkControl(cancel);
        const lease_value = try self.lease();
        const signer = try signing.DigestSigner.open(self.allocator, config, lease_value);
        self.digest_signer = signer;
        self.identity_loads += 1;
        return signer;
    }

    pub fn bind(self: *Owner, cancel: Cancel, deadline_ns: u64) !?*Scope {
        if (self.filtered_chain.ccs_signer == null) return null;
        _ = try self.acquire(cancel, deadline_ns);
        defer self.release();
        const signer = try self.ensureIdentity(cancel);
        const scope = try self.allocator.create(Scope);
        scope.* = .{ .owner = self, .address = signer.address, .cancel = cancel, .deadline_ns = deadline_ns };
        return scope;
    }

    pub fn provider(self: *Owner, deadline_utc_ns: u64) ccip.SignerProvider {
        return .{ .context = self, .deadline_utc_ns = deadline_utc_ns, .bind_fn = bindProvider };
    }

    fn bindProvider(context: *anyopaque, cancel: Cancel, deadline_utc_ns: u64) !?ccip.Signer {
        const self: *Owner = @ptrCast(@alignCast(context));
        const scope = (try self.bind(cancel, deadline_utc_ns)) orelse return null;
        return scope.signer();
    }

    fn sign(self: *Owner, scope: *Scope, digest: Hash, operation_cancel: Cancel) ![65]u8 {
        const cancel = operation_cancel orelse scope.cancel;
        var budget = try self.acquire(cancel, scope.deadline_ns);
        defer self.release();
        const signer = try self.ensureIdentity(cancel);
        try self.checkControl(cancel);
        const lease_value = try self.lease();
        try signer.refresh(lease_value);
        if (!std.mem.eql(u8, &signer.address, &scope.address)) return error.CcsSignerIdentityChanged;
        if (comptime builtin.is_test) if (self.fixture_before_sign) |fixture| try fixture.before_fn(fixture.context);
        try self.checkControl(cancel);
        _ = try budget.remaining();
        const signature = if (comptime builtin.is_test) blk: {
            if (self.fixture_signature) |fixture| break :blk try fixture.sign_fn(fixture.context, digest);
            break :blk try signer.signDigest(&digest);
        } else try signer.signDigest(&digest);
        try self.checkControl(cancel);
        _ = try budget.remaining();
        const recovered = try protocol.signature.recover(digest, signature);
        if (!std.mem.eql(u8, &recovered, &scope.address)) return error.CcsSignerIdentityMismatch;
        self.signatures += 1;
        return signature;
    }
};

pub const Scope = struct {
    owner: *Owner,
    address: [20]u8,
    cancel: Cancel,
    deadline_ns: u64,
    references: std.atomic.Value(usize) = .init(1),

    pub fn deinit(self: *Scope) void {
        releaseStatic(self);
    }

    pub fn signer(self: *Scope) ccip.Signer {
        return .{ .context = self, .address = self.address, .sign_digest = sign, .retain_fn = retainStatic, .release_fn = releaseStatic };
    }

    fn retainStatic(context: *anyopaque) void {
        const self: *Scope = @ptrCast(@alignCast(context));
        _ = self.references.fetchAdd(1, .acq_rel);
    }

    fn releaseStatic(context: *anyopaque) void {
        const self: *Scope = @ptrCast(@alignCast(context));
        if (self.references.fetchSub(1, .acq_rel) == 1) {
            const allocator = self.owner.allocator;
            self.* = undefined;
            allocator.destroy(self);
        }
    }

    fn sign(context: *anyopaque, digest: Hash, cancel: Cancel) ![65]u8 {
        const self: *Scope = @ptrCast(@alignCast(context));
        return self.owner.sign(self, digest, cancel);
    }
};
