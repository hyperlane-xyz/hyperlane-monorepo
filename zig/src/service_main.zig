//! Native agent entry point. Role-specific factories run on bounded workers;
//! the process thread handles signals, health and scheduling only.
const std = @import("std");
const options = @import("service_options");
const settings = @import("settings/root.zig");
const scheduler = @import("runtime/supervisor.zig");
const process_clock = @import("agents/process_clock.zig");
const validator = @import("agents/validator_task.zig");
const scraper = @import("agents/scraper/task.zig");
const relayer = @import("agents/relayer_task.zig");
const health_set = @import("agents/health_set.zig");
const metrics = @import("ops/metrics.zig");
const metric_schema = @import("ops/metrics_schema.zig");
const http = @import("ops/http.zig");
const routes = @import("ops/routes.zig");
const admin_api = @import("ops/admin/api.zig");
const admin_bindings = @import("ops/admin/relayer_bindings.zig");
const public_server = @import("agents/relayer/public_server.zig");
const chain_metrics = @import("ops/telemetry.zig");
const signer = @import("agents/signer.zig");
const credential_manager = @import("agents/credentials.zig");
const cloud = @import("cloud/root.zig");
const lander = @import("lander/root.zig");
const builtin = @import("builtin");
const a = std.heap.smp_allocator;
comptime {
    _ = @import("db/bzip2_glue.zig");
}
var stopping = std.atomic.Value(bool).init(false);
fn signal(_: c_int) callconv(.c) void {
    stopping.store(true, .release);
}
const ChainSigner = struct {
    settings: *const settings.Settings,
    value: ?*signer.DigestSigner = null,
    fn load(context: *anyopaque, credentials: signer.Credentials) !lander.Signer {
        const self: *ChainSigner = @ptrCast(@alignCast(context));
        const chain = self.settings.chainByName(self.settings.role.validator.origin_chain) orelse return error.UnknownOriginChain;
        if (self.value == null) self.value = try signer.DigestSigner.open(a, chain.signer orelse return error.MissingTransactionSigner, credentials);
        try self.value.?.refresh(credentials);
        return .{ .context = self.value.?, .address = self.value.?.address, .sign_fn = sign };
    }
    fn sign(context: *anyopaque, digest: [32]u8) ![65]u8 {
        const self: *signer.DigestSigner = @ptrCast(@alignCast(context));
        return self.signDigest(&digest);
    }
    fn deinit(self: *ChainSigner) void {
        if (self.value) |value| value.deinit();
    }
};
const CredentialOwner = struct {
    settings: *const settings.Settings,
    environment: *const std.process.EnvMap,
    http: ?*cloud.http.HttpTransport = null,
    manager: ?*credential_manager.Manager = null,
    fn lease(context: *anyopaque, seconds: u64) !signer.Credentials {
        const self: *CredentialOwner = @ptrCast(@alignCast(context));
        const transport = self.http orelse return error.CredentialTransportNotInitialized;
        if (self.manager == null) self.manager = try credential_manager.Manager.init(a, self.settings, self.environment, transport, .{ .libcrypto_path = self.environment.get("HYPERLANE_LIBCRYPTO_LIBRARY") orelse if (builtin.os.tag == .macos) "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" else "libcrypto.so.3" });
        return self.manager.?.lease(seconds);
    }
    fn deinit(self: *CredentialOwner) void {
        if (self.manager) |manager| manager.deinit();
    }
};
pub fn main() void {
    run() catch |err| {
        // Error names only: never print config/URLs, native diagnostics or keys.
        std.log.err("agent stopped: {s}", .{@errorName(err)});
        std.process.exit(1);
    };
}
fn run() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    var once = false;
    for (args[1..]) |argument| {
        if (std.mem.eql(u8, argument, "--help") or std.mem.eql(u8, argument, "-h")) {
            try std.fs.File.stdout().writeAll("Hyperlane " ++ options.role ++ " (Zig, experimental)\nRust-compatible CONFIG_FILES, HYP_ environment and --key=value configuration.\nHYPERLANE_ZIG_DEFAULTS: defaults directory (default ./config).\nHYPERLANE_CURL_LIBRARY: vetted native libcurl path.\n--zig-once: execute one bounded worker cycle and report health.\n");
            return;
        }
        if (std.mem.eql(u8, argument, "--zig-once")) once = true;
    }
    var environment = try std.process.getEnvMap(a);
    defer environment.deinit();
    const selected = comptime std.meta.stringToEnum(settings.Role, options.role) orelse @compileError("invalid agent role");
    var configured = try settings.Settings.loadProcess(a, selected, environment.get("HYPERLANE_ZIG_DEFAULTS") orelse "./config");
    defer configured.deinit();
    const library = environment.get("HYPERLANE_CURL_LIBRARY") orelse if (builtin.os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
    const telemetry = try metrics.Registry.init(a, comptime std.meta.stringToEnum(metrics.Role, options.role).?, .{ .base_version = metric_schema.baselib_version });
    defer telemetry.deinit();
    try chain_metrics.configure(telemetry, &configured);
    var endpoints: routes.Routes = .{ .registry = telemetry };
    const server = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("0.0.0.0", configured.metrics_port) }, endpoints.handler());
    defer server.deinit();
    var previous_int: std.posix.Sigaction = undefined;
    var previous_term: std.posix.Sigaction = undefined;
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = signal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &action, &previous_int);
    defer std.posix.sigaction(std.posix.SIG.INT, &previous_int, null);
    std.posix.sigaction(std.posix.SIG.TERM, &action, &previous_term);
    defer std.posix.sigaction(std.posix.SIG.TERM, &previous_term, null);
    var clock = try process_clock.Clock.init();
    switch (selected) {
        .validator => {
            var identity: CredentialOwner = .{ .settings = &configured, .environment = &environment };
            defer identity.deinit();
            var transaction_identity: CredentialOwner = .{ .settings = &configured, .environment = &environment };
            defer transaction_identity.deinit();
            var transaction_signer: ChainSigner = .{ .settings = &configured };
            defer transaction_signer.deinit();
            const task = try validator.Task.init(a, &configured, .{ .curl_library = library, .metrics = telemetry, .environment = &environment }, .{ .context = &identity, .lease = CredentialOwner.lease }, null);
            defer task.deinit();
            identity.http = &task.http;
            transaction_identity.http = &task.announcement.http;
            task.announcement.setProviders(.{ .context = &transaction_identity, .lease = CredentialOwner.lease }, .{ .context = &transaction_signer, .load = ChainSigner.load });
            const tasks = task.descriptors();
            endpoints.setExtra(task.httpHandler());
            errdefer {
                endpoints.setExtra(null);
                server.stop();
            }
            const health = try health_set.Set.open(a, &configured, &environment, telemetry, &tasks, .{ .source = .{ .curl_library = library }, .criticals = .{ .context = task, .get_fn = validatorCritical } });
            defer health.deinit();
            const owner = try scheduler.Supervisor.start(a, health.descriptors());
            defer owner.deinit();
            defer {
                endpoints.setExtra(null);
                server.stop();
            }
            try supervise(owner, server, null, once, &clock);
            if (task.hasUnpersistedGuard()) return error.ReorgGuardPersistencePending;
        },
        .scraper => {
            const tasks = try scraper.TaskSet.open(a, &configured, &environment, .{ .curl_library = library, .metrics = telemetry, .startup_cancel = &stopping });
            defer tasks.deinit();
            const health = try health_set.Set.open(a, &configured, &environment, telemetry, tasks.descriptors(), .{ .source = .{ .curl_library = library, .http_runtime = tasks.http_runtime, .read_budget = &tasks.read_budget }, .criticals = .{ .context = tasks, .get_fn = scraperCritical } });
            defer health.deinit();
            const owner = try scheduler.Supervisor.start(a, health.descriptors());
            defer owner.deinit();
            try supervise(owner, server, null, once, &clock);
        },
        .relayer => {
            const tasks = try relayer.TaskSet.open(a, &configured, &environment, .{ .curl_library = library, .metrics = telemetry, .observation_clock = clock.observation() });
            defer tasks.deinit();
            const relay_listener = try public_server.Listener.start(a, &configured, &environment, tasks.origins, &tasks.control_hub, tasks.sourceOptions(), telemetry);
            defer if (relay_listener) |value| value.deinit();
            const relay_http = if (relay_listener) |value| value.server else null;

            var bindings = admin_bindings.Bindings.init(tasks.origins);
            var has_evm = false;
            for (configured.chains) |chain| if (chain.protocol == .ethereum) {
                has_evm = true;
                break;
            };
            var admin: admin_api.Admin = .{
                .messages = bindings.messageDb(),
                .merkle = bindings.merkleDb(),
                .proofs = bindings.proofDb(),
                .queue = tasks.control_hub.queueOwner(),
                .retry = tasks.control_hub.retryOwner(),
                .policy = &tasks.control_hub.gateway_policy,
                .regex_engine = if (tasks.regex_engine) |*value| value else null,
                .origin_signers = tasks.control_hub.cachedSigners(),
                .reprocess = tasks.control_hub.reprocessOwner(),
                .gas = tasks.control_hub.gasOwner(),
                .nonce = if (has_evm) tasks.control_hub.nonceOwner() else null,
                .environment = if (environment.get("HYPERLANE_RELAYER_ENVIRONMENT_VARIABLE_ENDPOINT_ENABLED")) |flag| (if (std.mem.eql(u8, flag, "true")) tasks.control_hub.environmentOwner() else null) else null,
                .denylist = &tasks.denylist,
                .denylist_clock = tasks.denylist_clock.interface(),
                .denylist_refresh = .{ .context = tasks, .bind_fn = bindDenylist, .unbind_fn = unbindDenylist },
            };
            endpoints.setExtra(admin.handler());
            errdefer {
                endpoints.setExtra(null);
                if (relay_http) |value| value.stop();
                server.stop();
            }
            const health = try health_set.Set.open(a, &configured, &environment, telemetry, tasks.descriptors(), .{ .source = tasks.sourceOptions(), .wallets = tasks.healthWallets(), .criticals = tasks.healthCriticals() });
            defer health.deinit();
            const owner = try scheduler.Supervisor.start(a, health.descriptors());
            defer owner.deinit();
            // Join every borrowed HTTP context before role owners, queues and
            // databases are destroyed, including error and signal shutdown.
            defer {
                endpoints.setExtra(null);
                if (relay_http) |value| value.stop();
                server.stop();
            }
            try supervise(owner, server, relay_http, once, &clock);
        },
    }
}
fn supervise(owner: *scheduler.Supervisor, server: *http.Server, public_http: ?*http.Server, once: bool, clock: *process_clock.Clock) !void {
    errdefer drain(owner, server, public_http);
    var halt_error: ?anyerror = null;
    const logged = try a.alloc(?anyerror, owner.taskCount());
    defer a.free(logged);
    @memset(logged, null);
    while (!stopping.load(.acquire)) {
        try server.checkFailure();
        if (public_http) |value| try value.checkFailure();
        const now = try clock.observation().now();
        _ = try owner.tick(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms });
        if (owner.failureReason()) |err| {
            halt_error = err;
            break;
        }
        var finished = true;
        var halted = true;
        for (0..owner.taskCount()) |index| {
            const health = try owner.health(index);
            if (health.last_error != logged[index]) {
                if (health.last_error) |err| std.log.warn("task {d} failed: {s}", .{ index, @errorName(err) });
                logged[index] = health.last_error;
            }
            finished = finished and (health.completed > 0 or health.failures > 0);
            halted = halted and health.halted;
            if (health.halted) halt_error = health.last_error orelse error.AgentTaskHalted;
        }
        if ((once and finished) or halted) break;
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }
    drain(owner, server, public_http);
    if (once) {
        for (0..owner.taskCount()) |index| {
            const health = try owner.health(index);
            const output = try std.json.Stringify.valueAlloc(a, .{ .task = index, .completed = health.completed, .suspended = health.suspended, .failures = health.failures, .timeouts = health.timeouts, .work = health.work, .halted = health.halted, .error_code = if (health.last_error) |err| @errorName(err) else null }, .{});
            defer a.free(output);
            try std.fs.File.stdout().writeAll(output);
            try std.fs.File.stdout().writeAll("\n");
            if (halt_error == null) if (health.last_error) |err| {
                halt_error = err;
            };
        }
    }
    if (halt_error) |err| return err;
}

fn drain(owner: *scheduler.Supervisor, server: *http.Server, public_http: ?*http.Server) void {
    // Cancel and join HTTP callers before retiring their serialized command
    // owners. Native jobs retain cancellation through actual completion.
    // Latch/cancel retained effect owners before waiting for HTTP callers.
    owner.stop();
    if (public_http) |value| value.stop();
    server.stop();
    while (!owner.drained()) std.Thread.sleep(10 * std.time.ns_per_ms);
}

fn bindDenylist(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
    const tasks: *relayer.TaskSet = @ptrCast(@alignCast(context));
    try tasks.bindDenylist(cancel);
}
fn unbindDenylist(context: *anyopaque, cancel: *const std.atomic.Value(bool)) void {
    const tasks: *relayer.TaskSet = @ptrCast(@alignCast(context));
    tasks.unbindDenylist(cancel);
}

fn scraperCritical(context: *anyopaque, domain: u32) !?*@import("ops/critical_metrics.zig").Tracker {
    const tasks: *scraper.TaskSet = @ptrCast(@alignCast(context));
    return tasks.criticalForChain(domain);
}

fn validatorCritical(context: *anyopaque, domain: u32) !?*@import("ops/critical_metrics.zig").Tracker {
    const task: *validator.Task = @ptrCast(@alignCast(context));
    return task.criticalForChain(domain);
}
