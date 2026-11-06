//! Aleo policy and durable mutation orchestration. All VM CPU work is isolated,
//! deadline bounded, cancellable and reaped before the worker slot is released.
const std = @import("std");
const types = @import("types.zig");
const contracts = @import("../../aleo/contracts.zig");
const worker = @import("../../aleo/worker.zig");
const events = @import("../../aleo/events.zig");
const plaintext = @import("../../aleo/plaintext.zig");
const protocol = @import("../../protocol/root.zig");
const http = @import("../../cloud/http.zig");
const rpc = @import("../../net/json_rpc.zig");
const abi = @import("../../evm/codecs.zig");
const common = @import("../scraper/receipts_common.zig");
const Hash = types.Hash;
pub const MetadataSource = contracts.Source;
pub const Signer = struct { context: *anyopaque, address: Hash, key_fn: *const fn (*anyopaque, *Hash) anyerror!void };
pub const Authorized = struct {
    allocator: std.mem.Allocator,
    bytes: []u8,
    base_fee: u64,
    priority_fee: u64,
    pub fn restore(a: std.mem.Allocator, bytes: []const u8) !Authorized {
        if (bytes.len == 0 or bytes.len > types.Signed.max_bytes) return error.AleoAuthorizationLimit;
        var parsed = try std.json.parseFromSlice(rpc.Value, a, bytes, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        const base = try rpc.integer(u64, try rpc.field(parsed.value, "base_fee"));
        const priority = try rpc.integer(u64, try rpc.field(parsed.value, "priority_fee"));
        _ = try std.math.add(u64, base, priority);
        return .{ .allocator = a, .bytes = try a.dupe(u8, bytes), .base_fee = base, .priority_fee = priority };
    }
    pub fn deinit(self: *Authorized) void {
        std.crypto.secureZero(u8, self.bytes);
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};
const Program = struct { program: []const u8, edition: u16 };
pub const Aleo = struct {
    chain: contracts.Contracts,
    signer: Signer,
    executable: []const u8,
    library: []const u8,
    limits: worker.Limits = .{},
    entropy: types.Entropy = .{},
    maximum_fee: u64,
    delegated_prover: ?*@import("../../aleo/prover.zig").Prover = null,
    /// Exact rational multiplier avoids unchecked float-to-u64 saturation.
    priority_fee_bps: u32 = 0,
    priority_fee_multiplier: ?f64 = null,
    http_owner: ?*http.HttpTransport = null,
    /// Explicit test injection; production requires a deadline-native transport.
    allow_fixture_transport: bool = false,
    fn authority(self: *Aleo, context: types.Authority) !void {
        const network = std.fmt.parseInt(u16, context.chain_id, 10) catch return error.DestinationAuthorityMismatch;
        if (context.protocol != .aleo or context.destination != self.chain.config.domain or network != self.chain.provider.client.network or !std.mem.eql(u8, &context.mailbox, &try self.chain.provider.native.programAddress(self.chain.config.mailbox))) return error.DestinationAuthorityMismatch;
    }
    pub fn metadata(self: *Aleo, origin: anytype, address: Hash, message: protocol.Message) ![]u8 {
        var source: contracts.Source(@TypeOf(origin.*)) = .{ .chain = self.chain, .origin = origin };
        var builder: @import("../../relayer/metadata.zig").Builder(@TypeOf(source)) = .{ .allocator = self.chain.provider.client.allocator, .source = &source };
        return builder.build(address, message);
    }
    pub fn prepare(self: *Aleo, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        var call = try self.chain.process(message, metadata_bytes);
        defer call.deinit();
        return self.prepareCall(context, call);
    }
    pub fn prepareAnnouncement(self: *Aleo, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        var call = try self.chain.announcement(validator, location, signature);
        defer call.deinit();
        return self.prepareCall(context, call);
    }
    fn prepareCall(self: *Aleo, context: types.Authority, call: contracts.OwnedCall) !types.Prepared {
        const actual_target = try self.chain.provider.native.programAddress(call.program_id);
        try context.expectTarget(actual_target);
        var pinned = context;
        pinned.target = actual_target;
        const a = self.chain.provider.client.allocator;
        const sender = try self.chain.provider.native.addressText(a, self.signer.address);
        defer a.free(sender);
        const body = try std.json.Stringify.valueAlloc(a, .{ .program_id = call.program_id, .function_name = call.function_name, .inputs = call.inputs, .network = self.chain.provider.client.network, .sender = sender, .maximum_fee = self.maximum_fee, .priority_fee_bps = self.priority_fee_bps, .priority_fee_multiplier = self.priority_fee_multiplier }, .{});
        defer a.free(body);
        return types.Prepared.init(a, pinned, body, null, null);
    }
    fn validate(self: *Aleo, prepared: *const types.Prepared) !void {
        try prepared.validate();
        try self.authority(prepared.authority);
        const body = prepared.body;
        if (try rpc.integer(u16, try rpc.field(body, "network")) != self.chain.provider.client.network or try rpc.integer(u64, try rpc.field(body, "maximum_fee")) != self.maximum_fee or try rpc.integer(u32, try rpc.field(body, "priority_fee_bps")) != self.priority_fee_bps or !std.mem.eql(u8, &try self.chain.provider.native.address(try rpc.string(try rpc.field(body, "sender"))), &self.signer.address)) return error.DestinationIntentChanged;
        try prepared.authority.expectTarget(try self.chain.provider.native.programAddress(try rpc.string(try rpc.field(body, "program_id"))));
        const multiplier = try rpc.field(body, "priority_fee_multiplier");
        if (self.priority_fee_multiplier) |expected| {
            const actual: f64 = switch (multiplier) {
                .float => |n| n,
                .integer => |n| @floatFromInt(n),
                else => return error.DestinationIntentChanged,
            };
            if (actual != expected) return error.DestinationIntentChanged;
        } else if (multiplier != .null) return error.DestinationIntentChanged;
        const name = try rpc.string(try rpc.field(body, "function_name"));
        if (!std.mem.eql(u8, name, if (prepared.authority.kind == .process) "process" else "announce")) return error.DestinationIntentChanged;
        if (prepared.authority.kind == .announcement and !std.mem.eql(u8, try rpc.string(try rpc.field(body, "program_id")), self.chain.config.validator_announce)) return error.DestinationIntentChanged;
        const inputs = try rpc.field(body, "inputs");
        if (inputs != .array or inputs.array.items.len > 1024) return error.InvalidAleoInputs;
    }
    fn spawn(self: *Aleo, deadline: u64) !worker.Session {
        const a = self.chain.provider.client.allocator;
        var digits: [3][32]u8 = undefined;
        var limits = self.limits;
        limits.timeout_ms = @min(limits.timeout_ms, try common.milliseconds(deadline));
        var session = try worker.Session.spawn(a, &.{ self.executable, try std.fmt.bufPrint(&digits[0], "{d}", .{limits.memory_bytes}), try std.fmt.bufPrint(&digits[1], "{d}", .{limits.max_input_bytes}), try std.fmt.bufPrint(&digits[2], "{d}", .{limits.max_output_bytes}) }, limits);
        errdefer session.deinit();
        const config = try std.json.Stringify.valueAlloc(a, .{ .library = self.library, .network = self.chain.provider.client.network }, .{});
        defer a.free(config);
        a.free(try session.exchange(.init, config));
        return session;
    }
    fn load(self: *Aleo, session: *worker.Session, a: std.mem.Allocator, name: []const u8, active: *std.ArrayList([]const u8), programs: *std.ArrayList(Program), total: *usize, deadline: u64) anyerror!void {
        _ = try common.milliseconds(deadline);
        if (std.mem.eql(u8, name, "credits.aleo")) return;
        if (active.items.len >= 64 or programs.items.len >= 1024) return error.AleoProgramImportLimit;
        for (programs.items) |entry| {
            // Native program_info is authoritative; retain names separately in
            // active completed list without inventing a second Aleo parser.
            const info_bytes = try session.exchange(.program_info, entry.program);
            defer self.chain.provider.client.allocator.free(info_bytes);
            const info = try std.json.parseFromSlice(rpc.Value, a, info_bytes, .{});
            if (std.mem.eql(u8, name, try rpc.string(try rpc.field(info.value, "program_id")))) return;
        }
        for (active.items) |ancestor| if (std.mem.eql(u8, ancestor, name)) return error.AleoProgramImportCycle;
        try active.append(a, name);
        defer _ = active.pop();
        var edition = try self.chain.provider.client.get(&.{ "program", name, "latest_edition" }, &.{});
        defer edition.deinit();
        const version = try rpc.integer(u16, edition.value());
        var digits: [8]u8 = undefined;
        var response = try self.chain.provider.client.get(&.{ "program", name, try std.fmt.bufPrint(&digits, "{d}", .{version}) }, &.{});
        defer response.deinit();
        const program = try rpc.string(response.value());
        if (program.len > 16 * 1024 * 1024 or program.len > 64 * 1024 * 1024 - total.*) return error.AleoProgramLimit;
        const info_bytes = try session.exchange(.program_info, program);
        defer self.chain.provider.client.allocator.free(info_bytes);
        const info = try std.json.parseFromSlice(rpc.Value, a, info_bytes, .{});
        if (!std.mem.eql(u8, name, try rpc.string(try rpc.field(info.value, "program_id")))) return error.WrongAleoProgram;
        const imports = try rpc.field(info.value, "imports");
        if (imports != .array or imports.array.items.len > 64) return error.AleoProgramImportLimit;
        for (imports.array.items) |item| try self.load(session, a, try rpc.string(item), active, programs, total, deadline);
        const addition: Program = .{ .program = try a.dupe(u8, program), .edition = version };
        const wire = try std.json.Stringify.valueAlloc(a, addition, .{});
        self.chain.provider.client.allocator.free(try session.exchange(.add_program, wire));
        try programs.append(a, addition);
        total.* += program.len;
    }
    fn transport(self: *Aleo, deadline: u64) !Scope {
        var result: Scope = .{ .self = self, .saved = self.chain.provider.client.transport };
        if (self.http_owner) |owner| {
            result.budget = .{ .rpc_read = true, .owner = owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_fixture_transport };
            try result.budget.?.verify(result.saved);
        } else if (!self.allow_fixture_transport) return error.NativeDestinationTransportRequired;
        return result;
    }
    const Scope = struct {
        self: *Aleo,
        saved: http.Transport,
        budget: ?common.DeadlineTransport = null,
        fn install(self: *Scope) void {
            if (self.budget) |*value| self.self.chain.provider.client.transport = value.interface();
        }
        fn deinit(self: *Scope) void {
            self.self.chain.provider.client.transport = self.saved;
        }
    };
    /// Returns a resumable exact authorization, never submits or proves it.
    /// Private keys are requested only after the public intent has been fsynced.
    pub fn authorize(self: *Aleo, prepared: *const types.Prepared, persistence: types.Persistence, deadline: u64) !Authorized {
        try self.validate(prepared);
        const persist = persistence.persistAuthorization orelse return error.AuthorizationPersistenceRequired;
        try persistence.authorizationIntent(prepared);
        var scope = try self.transport(deadline);
        scope.install();
        defer scope.deinit();
        const a = self.chain.provider.client.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        var session = try self.spawn(deadline);
        defer session.deinit();
        var active: std.ArrayList([]const u8) = .empty;
        var programs: std.ArrayList(Program) = .empty;
        var total: usize = 0;
        const program = try rpc.string(try rpc.field(prepared.body, "program_id"));
        try self.load(&session, allocator, program, &active, &programs, &total, deadline);
        var key: Hash = undefined;
        try self.signer.key_fn(self.signer.context, &key);
        defer std.crypto.secureZero(u8, &key);
        const owner = try session.exchange(.key_address, &key);
        defer a.free(owner);
        if (!std.mem.eql(u8, owner, &self.signer.address)) return error.AleoSignerMismatch;
        var seed = try self.entropy.seed();
        defer std.crypto.secureZero(u8, &seed);
        const request = try std.json.Stringify.valueAlloc(allocator, .{ .program_id = program, .function_name = try rpc.string(try rpc.field(prepared.body, "function_name")), .inputs = try rpc.field(prepared.body, "inputs"), .unchecked = false }, .{});
        const payload = try allocator.alloc(u8, 64 + request.len);
        defer std.crypto.secureZero(u8, payload);
        payload[0..32].* = key;
        payload[32..64].* = seed;
        @memcpy(payload[64..], request);
        a.free(try session.exchange(.authorize, payload));
        const height = try self.chain.provider.height();
        var height_wire: [4]u8 = undefined;
        std.mem.writeInt(u32, &height_wire, height, .big);
        const fee_wire = try session.exchange(.estimate, &height_wire);
        defer a.free(fee_wire);
        if (fee_wire.len != 8) return error.InvalidAleoWorkerFrame;
        const base_fee = std.mem.readInt(u64, fee_wire[0..8], .big);
        const priority_fee = if (self.priority_fee_multiplier) |multiplier| blk: {
            const value = @round(@as(f64, @floatFromInt(base_fee)) * multiplier);
            if (!std.math.isFinite(value) or value < 0 or value >= 18446744073709551616.0) return error.AleoFeeOverflow;
            break :blk @as(u64, @intFromFloat(value));
        } else std.math.cast(u64, (@as(u128, base_fee) * self.priority_fee_bps + 5000) / 10000) orelse return error.AleoFeeOverflow;
        if (try std.math.add(u64, base_fee, priority_fee) > self.maximum_fee) return error.AleoFeeCapExceeded;
        var fee: [81]u8 = undefined;
        defer std.crypto.secureZero(u8, &fee);
        fee[0..32].* = key;
        var fee_seed = try self.entropy.seed();
        defer std.crypto.secureZero(u8, &fee_seed);
        fee[32..64].* = fee_seed;
        std.mem.writeInt(u64, fee[64..72], base_fee, .big);
        std.mem.writeInt(u64, fee[72..80], priority_fee, .big);
        fee[80] = 0;
        a.free(try session.exchange(.fee, &fee));
        const info_bytes = try session.exchange(.job_info, "");
        defer {
            std.crypto.secureZero(u8, info_bytes);
            a.free(info_bytes);
        }
        const info = try std.json.parseFromSlice(rpc.Value, allocator, info_bytes, .{});
        try self.bind(prepared, info.value, allocator);
        const bytes = try std.json.Stringify.valueAlloc(a, .{ .version = @as(u8, 1), .network = self.chain.provider.client.network, .intent_digest = try abi.hexAlloc(allocator, &prepared.digest()), .base_fee = base_fee, .priority_fee = priority_fee, .programs = programs.items, .job = info.value }, .{});
        errdefer {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        }
        if (bytes.len > types.Signed.max_bytes) return error.AleoAuthorizationLimit;
        _ = try common.milliseconds(deadline);
        try persist(persistence.context, prepared.authority.operation_id, bytes);
        return .{ .allocator = a, .bytes = bytes, .base_fee = base_fee, .priority_fee = priority_fee };
    }
    fn bind(self: *Aleo, prepared: *const types.Prepared, job: rpc.Value, a: std.mem.Allocator) !void {
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(job, "program_id")), try rpc.string(try rpc.field(prepared.body, "program_id"))) or !std.mem.eql(u8, try rpc.string(try rpc.field(job, "function_name")), try rpc.string(try rpc.field(prepared.body, "function_name"))) or !std.mem.eql(u8, &try self.chain.provider.native.address(try rpc.string(try rpc.field(job, "signer"))), &self.signer.address)) return error.AleoAuthorizationIntentMismatch;
        const actual = try rpc.field(job, "root_inputs");
        const expected = try rpc.field(prepared.body, "inputs");
        if (actual != .array or expected != .array or actual.array.items.len != expected.array.items.len) return error.AleoAuthorizationIntentMismatch;
        for (actual.array.items, expected.array.items) |left, right| {
            var lhs = try plaintext.Document.parse(a, try rpc.string(left), .{});
            defer lhs.deinit();
            var rhs = try plaintext.Document.parse(a, try rpc.string(right), .{});
            defer rhs.deinit();
            const l = try lhs.value.render(a);
            defer a.free(l);
            const r = try rhs.value.render(a);
            defer a.free(r);
            if (!std.mem.eql(u8, l, r)) return error.AleoAuthorizationIntentMismatch;
        }
        const transitions = try rpc.field(job, "transitions");
        if (transitions != .array or transitions.array.items.len > 1024) return error.InvalidAleoAuthorization;
        for (transitions.array.items) |transition| {
            const program = try rpc.string(try rpc.field(transition, "program_id"));
            const name = try rpc.string(try rpc.field(transition, "function_name"));
            if ((std.mem.eql(u8, program, "credits.aleo") or std.mem.eql(u8, program, "token_registry.aleo")) and std.mem.eql(u8, name, "transfer_public_as_signer")) return error.MaliciousAleoAuthorization;
        }
    }
    fn restoreAuthorization(self: *Aleo, prepared: *const types.Prepared, authorized: *const Authorized, session: *worker.Session, a: std.mem.Allocator) !rpc.Value {
        try self.validate(prepared);
        if (authorized.bytes.len == 0 or authorized.bytes.len > types.Signed.max_bytes) return error.AleoAuthorizationLimit;
        const snapshot = (try std.json.parseFromSlice(rpc.Value, a, authorized.bytes, .{ .duplicate_field_behavior = .@"error" })).value;
        if (try rpc.integer(u8, try rpc.field(snapshot, "version")) != 1 or try rpc.integer(u16, try rpc.field(snapshot, "network")) != self.chain.provider.client.network or !std.mem.eql(u8, &try abi.fixedHex(32, try rpc.string(try rpc.field(snapshot, "intent_digest"))), &prepared.digest()) or try rpc.integer(u64, try rpc.field(snapshot, "base_fee")) != authorized.base_fee or try rpc.integer(u64, try rpc.field(snapshot, "priority_fee")) != authorized.priority_fee or try std.math.add(u64, authorized.base_fee, authorized.priority_fee) > self.maximum_fee) return error.AleoAuthorizationIntentMismatch;
        const programs = try rpc.field(snapshot, "programs");
        if (programs != .array or programs.array.items.len > 1024) return error.AleoProgramImportLimit;
        for (programs.array.items) |program| {
            _ = try rpc.string(try rpc.field(program, "program"));
            _ = try rpc.integer(u16, try rpc.field(program, "edition"));
            const wire = try std.json.Stringify.valueAlloc(a, program, .{});
            self.chain.provider.client.allocator.free(try session.exchange(.add_program, wire));
        }
        const job_wire = try std.json.Stringify.valueAlloc(a, try rpc.field(snapshot, "job"), .{});
        const restored = try session.exchange(.restore, job_wire);
        defer {
            std.crypto.secureZero(u8, restored);
            self.chain.provider.client.allocator.free(restored);
        }
        const info = (try std.json.parseFromSlice(rpc.Value, a, restored, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" })).value;
        try self.bind(prepared, info, a);
        if (try rpc.field(info, "fee_authorization") == .null) return error.AleoFeeAuthorizationMissing;
        if (try rpc.integer(u64, try rpc.field(info, "base_fee")) != authorized.base_fee or try rpc.integer(u64, try rpc.field(info, "priority_fee")) != authorized.priority_fee) return error.AleoAuthorizationIntentMismatch;
        return info;
    }
    pub fn validateAuthorization(self: *Aleo, prepared: *const types.Prepared, authorized: *const Authorized, deadline: u64) !void {
        const a = self.chain.provider.client.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var session = try self.spawn(deadline);
        defer session.deinit();
        _ = try self.restoreAuthorization(prepared, authorized, &session, arena.allocator());
    }
    fn validateSigned(self: *Aleo, session: *worker.Session, a: std.mem.Allocator, authorized: *const Authorized, signed_bytes: []const u8) !Hash {
        const result_bytes = try session.exchange(.validate, signed_bytes);
        defer self.chain.provider.client.allocator.free(result_bytes);
        const parsed = try std.json.parseFromSlice(rpc.Value, a, result_bytes, .{});
        if (try rpc.integer(u64, try rpc.field(parsed.value, "base_fee")) != authorized.base_fee or try rpc.integer(u64, try rpc.field(parsed.value, "priority_fee")) != authorized.priority_fee) return error.AleoAuthorizationIntentMismatch;
        return self.chain.provider.native.id(.transaction, try rpc.string(try rpc.field(parsed.value, "id")));
    }
    /// Generate a local proof only after exact signed authorizations are durable.
    /// The worker cannot perform network I/O: all state paths are explicit inputs.
    pub fn proveLocal(self: *Aleo, prepared: *const types.Prepared, authorized: *const Authorized, persistence: types.Persistence, deadline: u64) !types.Signed {
        try persistence.intent(prepared);
        var scope = try self.transport(deadline);
        scope.install();
        defer scope.deinit();
        const a = self.chain.provider.client.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        var session = try self.spawn(deadline);
        defer session.deinit();
        const info = try self.restoreAuthorization(prepared, authorized, &session, allocator);
        const persist = persistence.persistAuthorization orelse return error.AuthorizationPersistenceRequired;
        try persist(persistence.context, prepared.authority.operation_id, authorized.bytes);
        const commitments = try rpc.field(info, "record_commitments");
        if (commitments != .array or commitments.array.items.len > 4096) return error.AleoStatePathLimit;
        var paths: std.json.ObjectMap = .init(allocator);
        for (commitments.array.items) |item| {
            const commitment = try rpc.string(item);
            var path = try self.chain.provider.client.get(&.{ "statePath", commitment }, &.{});
            defer path.deinit();
            const wire = try std.json.Stringify.valueAlloc(allocator, path.value(), .{});
            const owned = (try std.json.parseFromSlice(rpc.Value, allocator, wire, .{})).value;
            try paths.put(try allocator.dupe(u8, commitment), owned);
        }
        var root = try self.chain.provider.client.get(&.{ "stateRoot", "latest" }, &.{});
        defer root.deinit();
        const state_root = try rpc.string(root.value());
        const height = try self.chain.provider.height();
        const query = try std.json.Stringify.valueAlloc(allocator, .{ .height = height, .state_root = state_root, .state_paths = rpc.Value{ .object = paths } }, .{});
        const input = try allocator.alloc(u8, 32 + query.len);
        var seed = try self.entropy.seed();
        defer std.crypto.secureZero(u8, &seed);
        input[0..32].* = seed;
        defer std.crypto.secureZero(u8, input[0..32]);
        @memcpy(input[32..], query);
        const wire = try session.exchange(.prove, input);
        defer a.free(wire);
        const id = try self.validateSigned(&session, allocator, authorized, wire);
        var signed = try types.Signed.init(a, .{ .hash256 = id }, wire);
        errdefer signed.deinit();
        _ = try common.milliseconds(deadline);
        try persistence.signed(prepared, &signed);
        return signed;
    }
    /// Explicit delegated mode; never silently falls back to local proving.
    pub fn proveDelegated(self: *Aleo, prepared: *const types.Prepared, authorized: *const Authorized, persistence: types.Persistence, deadline: u64, unix_seconds: i64) !types.Signed {
        try persistence.intent(prepared);
        const prover = self.delegated_prover orelse return error.MissingAleoDelegatedProver;
        if (prover.network != self.chain.provider.client.network) return error.WrongAleoProverNetwork;
        const a = self.chain.provider.client.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var session = try self.spawn(deadline);
        defer session.deinit();
        _ = try self.restoreAuthorization(prepared, authorized, &session, arena.allocator());
        const persist = persistence.persistAuthorization orelse return error.AuthorizationPersistenceRequired;
        try persist(persistence.context, prepared.authority.operation_id, authorized.bytes);
        const wire = try session.exchange(.proving_request, "");
        defer {
            std.crypto.secureZero(u8, wire);
            a.free(wire);
        }
        const transaction = try prover.prove(wire, deadline, unix_seconds);
        defer a.free(transaction);
        const id = try self.validateSigned(&session, arena.allocator(), authorized, transaction);
        var signed = try types.Signed.init(a, .{ .hash256 = id }, transaction);
        errdefer signed.deinit();
        _ = try common.milliseconds(deadline);
        try persistence.signed(prepared, &signed);
        return signed;
    }
    pub fn broadcast(self: *Aleo, prepared: *const types.Prepared, authorized: *const Authorized, signed: *const types.Signed, persistence: types.Persistence, deadline: u64) !void {
        if (signed.identity != .hash256) return error.WrongDestinationIdentity;
        var scope = try self.transport(deadline);
        scope.install();
        defer scope.deinit();
        const a = self.chain.provider.client.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var session = try self.spawn(deadline);
        defer session.deinit();
        _ = try self.restoreAuthorization(prepared, authorized, &session, arena.allocator());
        const id = try self.validateSigned(&session, arena.allocator(), authorized, signed.bytes);
        if (!std.mem.eql(u8, &id, &signed.identity.hash256)) return error.DestinationIntentChanged;
        try persistence.signed(prepared, signed);
        _ = try common.milliseconds(deadline);
        var response = try self.chain.provider.broadcast(signed.bytes);
        defer response.deinit();
        if (!std.mem.eql(u8, &id, &try self.chain.provider.native.id(.transaction, try rpc.string(response.value())))) return error.AleoBroadcastIdentityMismatch;
    }
    fn canonicalInclusion(self: *Aleo, block: rpc.Value, info: rpc.Value, expected_hash: Hash) !u32 {
        if (!std.mem.eql(u8, &try self.chain.provider.native.id(.block, try rpc.string(try rpc.field(block, "hash"))), &expected_hash)) return error.AleoReceiptIdentityMismatch;
        const transactions = try rpc.field(block, "transactions");
        const index = try rpc.integer(u32, try rpc.field(info, "index"));
        if (transactions != .array or transactions.array.items.len > 8192 or index >= transactions.array.items.len) return error.AleoReceiptInclusionMismatch;
        const transaction = transactions.array.items[index];
        const accepted = try rpc.field(transaction, "accepted");
        const expected_accepted = try rpc.field(info, "accepted");
        if (accepted != .bool or expected_accepted != .bool) return error.InvalidAleoReceipt;
        if (try rpc.integer(u32, try rpc.field(transaction, "index")) != index or accepted.bool != expected_accepted.bool or !std.mem.eql(u8, &try self.chain.provider.native.id(.transaction, try rpc.string(try rpc.field(transaction, "id"))), &try self.chain.provider.native.id(.transaction, try rpc.string(try rpc.field(info, "chain_id"))))) return error.AleoReceiptInclusionMismatch;
        return rpc.integer(u32, try rpc.field(block, "height"));
    }
    pub fn reconcile(self: *Aleo, identity: types.Identity, deadline: u64) !?types.Receipt {
        if (identity != .hash256) return error.WrongDestinationIdentity;
        var scope = try self.transport(deadline);
        scope.install();
        defer scope.deinit();
        const a = self.chain.provider.client.allocator;
        const id = try self.chain.provider.native.idText(a, .transaction, identity.hash256);
        defer a.free(id);
        var response = try self.chain.provider.transaction(id, true) orelse return null;
        defer response.deinit();
        const wire = try std.json.Stringify.valueAlloc(a, response.value(), .{});
        defer a.free(wire);
        var decoder: events.NativeDecoder = .{ .executable = self.executable, .library = self.library, .network = self.chain.provider.client.network, .limits = self.limits };
        decoder.limits.timeout_ms = @min(decoder.limits.timeout_ms, try common.milliseconds(deadline));
        var info = try decoder.confirmedInfo(a, wire);
        defer info.deinit();
        if (!std.mem.eql(u8, &identity.hash256, &try self.chain.provider.native.id(.transaction, try rpc.string(try rpc.field(info.value, "id"))))) return error.AleoReceiptIdentityMismatch;
        const chain_id = try rpc.string(try rpc.field(info.value, "chain_id"));
        _ = try self.chain.provider.native.id(.transaction, chain_id);
        var location = try self.chain.provider.client.get(&.{ "find", "blockHash", chain_id }, &.{});
        defer location.deinit();
        const block_hash = try self.chain.provider.native.id(.block, try rpc.string(location.value()));
        const block_text = try self.chain.provider.native.idText(a, .block, block_hash);
        defer a.free(block_text);
        var block = try self.chain.provider.client.get(&.{ "block", block_text }, &.{});
        defer block.deinit();
        if (!std.mem.eql(u8, &block_hash, &try self.chain.provider.native.id(.block, try rpc.string(try rpc.field(block.value(), "block_hash"))))) return error.AleoReceiptIdentityMismatch;
        const block_wire = try std.json.Stringify.valueAlloc(a, block.value(), .{});
        defer a.free(block_wire);
        decoder.limits.timeout_ms = @min(decoder.limits.timeout_ms, try common.milliseconds(deadline));
        var decoded = try decoder.interface().decode(a, block_wire);
        defer decoded.deinit();
        const height = try self.canonicalInclusion(decoded.value, info.value, block_hash);
        // The find endpoint may return a retained fork. Bind inclusion to the
        // canonical height lookup independently before publishing finality/spend.
        const canonical = try self.chain.provider.header(height);
        if (!std.mem.eql(u8, &canonical.hash, &block_hash)) return error.NoncanonicalAleoReceipt;
        const accepted = try rpc.field(info.value, "accepted");
        _ = try common.milliseconds(deadline);
        const fee = try rpc.integer(u64, try rpc.field(info.value, "fee_amount"));
        return .{ .identity = identity, .block_hash = block_hash, .height = height, .success = accepted.bool, .finalized = true, .expenditure = .{ .gas_used = fee, .tokens_used = fee } };
    }
};

const FixtureJournal = struct {
    intents: usize = 0,
    authorizations: usize = 0,
    signed_count: usize = 0,
    keys: usize = 0,
    fail: bool = false,
    fn intent(ctx: *anyopaque, _: Hash, _: []const u8) !void {
        const self: *FixtureJournal = @ptrCast(@alignCast(ctx));
        if (self.fail) return error.FixturePersistenceFailed;
        self.intents += 1;
    }
    fn authorization(ctx: *anyopaque, _: Hash, _: []const u8) !void {
        const self: *FixtureJournal = @ptrCast(@alignCast(ctx));
        try std.testing.expect(self.intents > 0);
        self.authorizations += 1;
    }
    fn signed(ctx: *anyopaque, _: Hash, identity: types.Identity, _: []const u8) !void {
        const self: *FixtureJournal = @ptrCast(@alignCast(ctx));
        try std.testing.expect(self.authorizations > 0 and identity == .hash256);
        self.signed_count += 1;
    }
    fn key(ctx: *anyopaque, output: *Hash) !void {
        const self: *FixtureJournal = @ptrCast(@alignCast(ctx));
        try std.testing.expect(self.intents > 0);
        self.keys += 1;
        output.* = .{0x11} ** 32;
    }
    fn persistence(self: *FixtureJournal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed, .persistAuthorization = authorization };
    }
};
const ProofFixture = struct {
    transaction: []const u8,
    calls: usize = 0,
    fn interface(self: *ProofFixture) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, a: std.mem.Allocator, request: http.Request) !http.Response {
        const self: *ProofFixture = @ptrCast(@alignCast(context));
        self.calls += 1;
        const keypair = try std.crypto.nacl.SealedBox.KeyPair.generateDeterministic(.{9} ** 32);
        if (self.calls == 1) {
            try std.testing.expect(std.mem.endsWith(u8, request.url, "/jwt"));
            const headers = try a.alloc(http.Header, 1);
            errdefer a.free(headers);
            const name = try a.dupe(u8, "authorization");
            errdefer a.free(name);
            const value = try a.dupe(u8, "Bearer fixture");
            errdefer a.free(value);
            headers[0] = .{ .name = name, .value = value };
            return .{ .allocator = a, .status = 200, .bytes = try a.dupe(u8, ""), .headers = headers };
        }
        if (self.calls == 2) {
            try std.testing.expect(std.mem.endsWith(u8, request.url, "/pubkey"));
            var encoded: [44]u8 = undefined;
            _ = std.base64.standard.Encoder.encode(&encoded, &keypair.public_key);
            return .{ .allocator = a, .status = 200, .bytes = try std.json.Stringify.valueAlloc(a, .{ .key_id = "fixture", .public_key = encoded[0..] }, .{}) };
        }
        try std.testing.expectEqual(@as(usize, 3), self.calls);
        try std.testing.expect(std.mem.endsWith(u8, request.url, "/prove/authorization"));
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request.body.?, .{});
        defer parsed.deinit();
        const text = try rpc.string(try rpc.field(parsed.value, "ciphertext"));
        const sealed = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(text));
        defer a.free(sealed);
        try std.base64.standard.Decoder.decode(sealed, text);
        const clear = try a.alloc(u8, sealed.len - std.crypto.nacl.SealedBox.seal_length);
        defer {
            std.crypto.secureZero(u8, clear);
            a.free(clear);
        }
        try std.crypto.nacl.SealedBox.open(clear, sealed, keypair);
        try std.testing.expect(clear.len > 100 and clear[clear.len - 1] == 0);
        var transaction = try std.json.parseFromSlice(rpc.Value, a, self.transaction, .{});
        defer transaction.deinit();
        return .{ .allocator = a, .status = 200, .bytes = try std.json.Stringify.valueAlloc(a, .{ .transaction = transaction.value, .broadcast = false }, .{}) };
    }
};
fn env(a: std.mem.Allocator, key: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(a, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
test "Aleo destination resumes exact persisted authorization in isolated worker and validates real proof before native broadcast" {
    const a = std.testing.allocator;
    const library = try env(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(library);
    const executable = try env(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    const crypto_path = try env(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const parameter_home = try env(a, "HYPERLANE_ALEO_PARAMETER_HOME");
    defer a.free(parameter_home);
    var native = try @import("../../aleo/crypto.zig").Crypto.init(crypto_path);
    defer native.deinit();
    var journal: FixtureJournal = .{};
    const program = "program ziggyfixture.aleo;\nfunction process:\n input r0 as u64.public;\n add r0 1u64 into r1;\n output r1 as u64.public;\n";
    const program_json = try std.json.Stringify.valueAlloc(a, program, .{});
    defer a.free(program_json);
    var steps = [_]@import("../../cloud/testing.zig").Step{
        .{ .method = .GET, .suffix = "/program/ziggyfixture.aleo/latest_edition", .response = "1" },
        .{ .method = .GET, .suffix = "/program/ziggyfixture.aleo/1", .response = program_json },
        .{ .method = .GET, .suffix = "/block/height/latest", .response = "15000000" },
        .{ .method = .GET, .suffix = "/stateRoot/latest", .response = "\"sr1dz06ur5spdgzkguh4pr42mvft6u3nwsg5drh9rdja9v8jpcz3czsls9geg\"" },
        .{ .method = .GET, .suffix = "/block/height/latest", .response = "15000000" },
        .{ .method = .POST, .suffix = "/transaction/broadcast", .response = "" },
    };
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &steps };
    var client: @import("../../aleo/provider.zig").Provider = .{ .native = &native, .client = try @import("../../aleo/rest.zig").Client.init(a, network.transport(), &.{.{ .url = "https://fixture/v2" }}, 0) };
    var destination: Aleo = .{ .chain = .{ .provider = &client, .config = .{ .mailbox = "hyp_mailbox.aleo", .hook_manager = "hyp_hook_manager.aleo", .ism_manager = "hyp_ism_manager.aleo", .validator_announce = "hyp_validator_announce.aleo", .hook = .{0} ** 32, .domain = 200 } }, .signer = .{ .context = &journal, .address = undefined, .key_fn = FixtureJournal.key }, .executable = executable, .library = library, .limits = .{ .timeout_ms = 120000, .parameter_home = parameter_home }, .maximum_fee = 10000000, .priority_fee_bps = 100, .allow_fixture_transport = true };
    const now = @import("../scraper/receipts_evm.zig").nowNs;
    const deadline = try std.math.add(u64, try now(), 120 * std.time.ns_per_s);
    {
        var session = try destination.spawn(deadline);
        defer session.deinit();
        const address = try session.exchange(.key_address, &(.{0x11} ** 32));
        defer a.free(address);
        try std.testing.expectEqual(@as(usize, 32), address.len);
        destination.signer.address = address[0..32].*;
    }
    const context: types.Authority = .{ .protocol = .aleo, .origin = 100, .destination = 200, .mailbox = try native.programAddress("hyp_mailbox.aleo"), .chain_id = "0", .operation_id = .{7} ** 32 };
    var call_arena = std.heap.ArenaAllocator.init(a);
    defer call_arena.deinit();
    const call: contracts.OwnedCall = .{ .arena = call_arena, .program_id = "ziggyfixture.aleo", .function_name = "process", .inputs = &.{"1u64"} };
    var prepared = try destination.prepareCall(context, call);
    defer prepared.deinit();
    journal.fail = true;
    try std.testing.expectError(error.FixturePersistenceFailed, destination.authorize(&prepared, journal.persistence(), deadline));
    try std.testing.expectEqual(@as(usize, 0), journal.keys);
    journal.fail = false;
    var authorized = try destination.authorize(&prepared, journal.persistence(), deadline);
    defer authorized.deinit();
    try std.testing.expect(authorized.base_fee > 0 and authorized.priority_fee > 0);
    try std.testing.expectEqual(@as(usize, 1), journal.keys);
    var signed = try destination.proveLocal(&prepared, &authorized, journal.persistence(), deadline);
    defer signed.deinit();
    try std.testing.expectEqual(@as(usize, 1), journal.keys);
    const transaction_id = try native.idText(a, .transaction, signed.identity.hash256);
    defer a.free(transaction_id);
    const response = try std.json.Stringify.valueAlloc(a, transaction_id, .{});
    defer a.free(response);
    steps[5].response = response;
    try destination.broadcast(&prepared, &authorized, &signed, journal.persistence(), deadline);
    try std.testing.expectEqual(@as(usize, 2), journal.signed_count);
    try network.expectDone();
    var remote: ProofFixture = .{ .transaction = signed.bytes };
    const prover = try @import("../../aleo/prover.zig").Prover.init(a, remote.interface(), &.{"https://prover/v2?custom_rpc_header=x-auth-url:https%3A%2F%2Fprover%2Fjwt"}, 0);
    defer prover.deinit();
    prover.allow_fixture_transport = true;
    destination.delegated_prover = prover;
    var delegated = try destination.proveDelegated(&prepared, &authorized, journal.persistence(), deadline, 1000);
    defer delegated.deinit();
    try std.testing.expect(types.Identity.eql(signed.identity, delegated.identity));
    try std.testing.expectEqual(@as(usize, 1), journal.keys);
    try std.testing.expectEqual(@as(usize, 3), remote.calls);
    try std.testing.expectError(error.WrongDestinationIdentity, destination.reconcile(.{ .signature512 = .{0} ** 64 }, deadline));
    var wrong = context;
    wrong.destination = 201;
    try std.testing.expectError(error.DestinationAuthorityMismatch, destination.prepare(wrong, .{}, ""));
    try std.testing.expectError(error.DestinationAuthorityMismatch, destination.prepareAnnouncement(wrong, .{0} ** 20, "", .{0} ** 65));
}

test "Aleo destination receipt binds production confirmed transaction to canonical native block inclusion" {
    const a = std.testing.allocator;
    const library = try env(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(library);
    const executable = try env(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    const crypto_path = try env(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    var native = try @import("../../aleo/crypto.zig").Crypto.init(crypto_path);
    defer native.deinit();
    const path = blk: {
        std.fs.cwd().access("rust/main/config", .{}) catch break :blk "../rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
        break :blk "rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
    };
    const block_wire = try std.fs.cwd().readFileAlloc(a, path, 16 * 1024 * 1024);
    defer a.free(block_wire);
    var block = try std.json.parseFromSlice(rpc.Value, a, block_wire, .{});
    defer block.deinit();
    const confirmed = (try rpc.field(block.value, "transactions")).array.items[0];
    const confirmed_wire = try std.json.Stringify.valueAlloc(a, confirmed, .{});
    defer a.free(confirmed_wire);
    const block_id = try rpc.string(try rpc.field(block.value, "block_hash"));
    const block_id_wire = try std.json.Stringify.valueAlloc(a, block_id, .{});
    defer a.free(block_id_wire);
    var decoder: events.NativeDecoder = .{ .executable = executable, .library = library, .network = 1 };
    var info = try decoder.confirmedInfo(a, confirmed_wire);
    defer info.deinit();
    const identity: types.Identity = .{ .hash256 = try native.id(.transaction, try rpc.string(try rpc.field(info.value, "id"))) };
    var steps = [_]@import("../../cloud/testing.zig").Step{
        .{ .method = .GET, .suffix = "/transaction/confirmed/", .response = confirmed_wire },
        .{ .method = .GET, .suffix = "/find/blockHash/", .response = block_id_wire },
        .{ .method = .GET, .suffix = "/block/", .response = block_wire },
        .{ .method = .GET, .suffix = "/block/12618649", .response = block_wire },
    };
    // Exact IDs are runtime-derived from the actual SDK; no synthetic native IDs.
    const tx_text = try native.idText(a, .transaction, identity.hash256);
    defer a.free(tx_text);
    const confirmed_suffix = try std.fmt.allocPrint(a, "/transaction/confirmed/{s}", .{tx_text});
    defer a.free(confirmed_suffix);
    const chain_tx = try rpc.string(try rpc.field(info.value, "chain_id"));
    const find_suffix = try std.fmt.allocPrint(a, "/find/blockHash/{s}", .{chain_tx});
    defer a.free(find_suffix);
    const block_suffix = try std.fmt.allocPrint(a, "/block/{s}", .{block_id});
    defer a.free(block_suffix);
    steps[0].suffix = confirmed_suffix;
    steps[1].suffix = find_suffix;
    steps[2].suffix = block_suffix;
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &steps };
    var client: @import("../../aleo/provider.zig").Provider = .{ .native = &native, .client = try @import("../../aleo/rest.zig").Client.init(a, network.transport(), &.{.{ .url = "https://fixture/v2" }}, 1) };
    var destination: Aleo = .{ .chain = .{ .provider = &client, .config = .{ .mailbox = "test_mailbox.aleo", .hook_manager = "test_hook.aleo", .ism_manager = "test_ism.aleo", .validator_announce = "test_announce.aleo", .hook = .{0} ** 32, .domain = 2 } }, .signer = undefined, .executable = executable, .library = library, .maximum_fee = 1, .allow_fixture_transport = true };
    const now = @import("../scraper/receipts_evm.zig").nowNs;
    const receipt = (try destination.reconcile(identity, try now() + 20 * std.time.ns_per_s)).?;
    try std.testing.expect(receipt.success and receipt.finalized);
    try std.testing.expectEqual(@as(u64, 12618649), receipt.height);
    try std.testing.expectEqual(try rpc.integer(u64, try rpc.field(info.value, "fee_amount")), receipt.expenditure.?.tokens_used);
    try network.expectDone();
    var decoded = try decoder.interface().decode(a, block_wire);
    defer decoded.deinit();
    const hash = try native.id(.block, block_id);
    try std.testing.expectEqual(@as(u32, 12618649), try destination.canonicalInclusion(decoded.value, info.value, hash));
    const saved_index = info.value.object.get("index").?;
    info.value.object.getPtr("index").?.* = .{ .integer = 1 };
    try std.testing.expectError(error.AleoReceiptInclusionMismatch, destination.canonicalInclusion(decoded.value, info.value, hash));
    info.value.object.getPtr("index").?.* = saved_index;
    info.value.object.getPtr("accepted").?.* = .{ .bool = false };
    try std.testing.expectError(error.AleoReceiptInclusionMismatch, destination.canonicalInclusion(decoded.value, info.value, hash));
    info.value.object.getPtr("accepted").?.* = .{ .bool = true };
    info.value.object.getPtr("chain_id").?.* = .{ .string = tx_text };
    decoded.value.object.getPtr("transactions").?.array.items.len = 0;
    try std.testing.expectError(error.AleoReceiptInclusionMismatch, destination.canonicalInclusion(decoded.value, info.value, hash));
    // A retained fork at the correct height cannot produce finalized success.
    var fork = try std.json.parseFromSlice(rpc.Value, a, block_wire, .{});
    defer fork.deinit();
    try fork.value.object.put("block_hash", try rpc.field(block.value, "previous_hash"));
    const fork_wire = try std.json.Stringify.valueAlloc(a, fork.value, .{});
    defer a.free(fork_wire);
    steps[3].response = fork_wire;
    network.index = 0;
    try std.testing.expectError(error.NoncanonicalAleoReceipt, destination.reconcile(identity, try now() + 20 * std.time.ns_per_s));
    try network.expectDone();
}
