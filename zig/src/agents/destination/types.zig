//! Shared destination mutation boundary. Native chain identities are never
//! substituted with Keccak(public bytes) or another VM's transaction identifier.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const protocol = @import("../../protocol/root.zig");
const hex = @import("../../evm/codecs.zig");
pub const Hash = [32]u8;
pub const Identity = union(enum) {
    hash256: Hash,
    signature512: [64]u8,
    pub fn eql(left: Identity, right: Identity) bool {
        return std.meta.eql(left, right);
    }
};
pub const Kind = enum { process, announcement, reveal };
pub const RetirementProof = struct {
    kind: Kind = .process,
    target: ?Hash = null,
    identity: Identity,
    intent_digest: Hash,
    generation: u64,
    reason: enum { tron_expired, svm_blockhash_expired, radix_epoch_expired, cosmos_sequence_superseded, cosmos_timeout_expired, starknet_nonce_superseded },
    finalized_height: u64,
    finalized_block_hash: ?Hash = null,
    /// Expiration timestamp, last-valid block height, end epoch, or sequence.
    boundary: u64,
    observed: u64,
    nonce_account: ?Hash = null,
    nonce_boundary: ?Hash = null,
    nonce_observed: ?Hash = null,
    absence_checked: bool = false,
};
pub const Authority = struct {
    protocol: settings.Protocol,
    origin: u32,
    destination: u32,
    mailbox: Hash,
    chain_id: []const u8,
    origin_hook: ?Hash = null,
    operation_id: Hash,
    generation: u64 = 0,
    kind: Kind = .process,
    target: ?Hash = null,
    pub fn expectTarget(self: Authority, expected: Hash) !void {
        const target = self.target orelse {
            if (self.kind != .process) return error.DestinationAuthorityMismatch;
            return;
        };
        if (!std.mem.eql(u8, &target, &expected)) return error.DestinationAuthorityMismatch;
    }
    pub fn message(self: Authority, value: protocol.Message) !void {
        if (self.kind != .process or self.origin != value.origin or self.destination != value.destination or !std.mem.eql(u8, &self.operation_id, &value.id())) return error.DestinationAuthorityMismatch;
    }
};
pub const Prepared = struct {
    arena: std.heap.ArenaAllocator,
    authority: Authority,
    canonical_intent: []const u8,
    body: std.json.Value,
    /// Null means a real estimate has not been obtained; never interpret it as0.
    gas_limit: ?u256 = null,
    estimated_cost: ?u256 = null,
    pub const max_intent_bytes = 2 * 1024 * 1024;
    pub fn init(a: std.mem.Allocator, authority: Authority, body_json: []const u8, gas_limit: ?u256, estimated_cost: ?u256) !Prepared {
        if (body_json.len == 0 or body_json.len > max_intent_bytes or authority.chain_id.len == 0 or authority.chain_id.len > 128) return error.InvalidDestinationIntent;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        var context = authority;
        context.chain_id = try allocator.dupe(u8, authority.chain_id);
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body_json, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        const canonical = try std.json.Stringify.valueAlloc(allocator, .{ .version = @as(u8, 1), .authority = .{ .protocol = @tagName(context.protocol), .origin = context.origin, .destination = context.destination, .mailbox = try hex.hexAlloc(allocator, &context.mailbox), .chain_id = context.chain_id, .origin_hook = if (context.origin_hook) |hook| try hex.hexAlloc(allocator, &hook) else null, .operation_id = try hex.hexAlloc(allocator, &context.operation_id), .generation = context.generation, .kind = @tagName(context.kind), .target = if (context.target) |target| try hex.hexAlloc(allocator, &target) else null }, .payload = parsed.value }, .{});
        if (canonical.len > max_intent_bytes) return error.InvalidDestinationIntent;
        return .{ .arena = arena, .authority = context, .canonical_intent = canonical, .body = parsed.value, .gas_limit = gas_limit, .estimated_cost = estimated_cost };
    }
    /// Load the exact persisted public intent; reject noncanonical/extra fields.
    /// Gas estimates are advisory and reconstructed by the destination adapter.
    pub fn restore(a: std.mem.Allocator, bytes: []const u8) !Prepared {
        if (bytes.len == 0 or bytes.len > max_intent_bytes) return error.InvalidDestinationIntent;
        const json = @import("../../net/json_rpc.zig");
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const document = (try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error" })).value;
        if (try json.integer(u8, try json.field(document, "version")) != 1) return error.UnsupportedDestinationIntentVersion;
        const context = try json.field(document, "authority");
        const hook = try json.field(context, "origin_hook");
        const target = try json.field(context, "target");
        const authority: Authority = .{
            .protocol = std.meta.stringToEnum(settings.Protocol, try json.string(try json.field(context, "protocol"))) orelse return error.InvalidDestinationIntent,
            .origin = try json.integer(u32, try json.field(context, "origin")),
            .destination = try json.integer(u32, try json.field(context, "destination")),
            .mailbox = try hex.fixedHex(32, try json.string(try json.field(context, "mailbox"))),
            .chain_id = try json.string(try json.field(context, "chain_id")),
            .origin_hook = if (hook == .null) null else try hex.fixedHex(32, try json.string(hook)),
            .operation_id = try hex.fixedHex(32, try json.string(try json.field(context, "operation_id"))),
            .generation = try json.integer(u64, try json.field(context, "generation")),
            .target = if (target == .null) null else try hex.fixedHex(32, try json.string(target)),
            .kind = std.meta.stringToEnum(@TypeOf(@as(Authority, undefined).kind), try json.string(try json.field(context, "kind"))) orelse return error.InvalidDestinationIntent,
        };
        const body = try std.json.Stringify.valueAlloc(allocator, try json.field(document, "payload"), .{});
        var result = try Prepared.init(a, authority, body, null, null);
        errdefer result.deinit();
        if (!std.mem.eql(u8, bytes, result.canonical_intent)) return error.NoncanonicalDestinationIntent;
        return result;
    }
    pub fn validate(self: *const Prepared) !void {
        var arena = std.heap.ArenaAllocator.init(self.arena.child_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const body_json = try std.json.Stringify.valueAlloc(a, self.body, .{});
        var fresh = try Prepared.init(a, self.authority, body_json, self.gas_limit, self.estimated_cost);
        defer fresh.deinit();
        if (!std.mem.eql(u8, self.canonical_intent, fresh.canonical_intent)) return error.DestinationIntentChanged;
    }
    pub fn digest(self: *const Prepared) Hash {
        var out: Hash = undefined;
        std.crypto.hash.sha2.Sha256.hash(self.canonical_intent, &out, .{});
        return out;
    }
    pub fn deinit(self: *Prepared) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Signed = struct {
    allocator: std.mem.Allocator,
    identity: Identity,
    bytes: []u8,
    pub const max_bytes = 16 * 1024 * 1024;
    pub fn init(a: std.mem.Allocator, identity: Identity, bytes: []const u8) !Signed {
        if (bytes.len == 0 or bytes.len > max_bytes) return error.InvalidSignedDestinationTransaction;
        return .{ .allocator = a, .identity = identity, .bytes = try a.dupe(u8, bytes) };
    }
    pub fn deinit(self: *Signed) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};
pub const Persistence = struct {
    context: *anyopaque,
    persistIntent: *const fn (*anyopaque, Hash, []const u8) anyerror!void,
    persistSigned: *const fn (*anyopaque, Hash, Identity, []const u8) anyerror!void,
    /// Aleo authorization/fee snapshot must be durable before handing it to any
    /// prover. Persist as sensitive data: it contains signed public requests and
    /// derived transition view keys, never the private signing key.
    persistAuthorizationIntent: ?*const fn (*anyopaque, Hash, []const u8) anyerror!void = null,
    persistAuthorization: ?*const fn (*anyopaque, Hash, []const u8) anyerror!void = null,
    pub fn intent(self: Persistence, prepared: *const Prepared) !void {
        try prepared.validate();
        try self.persistIntent(self.context, prepared.authority.operation_id, prepared.canonical_intent);
    }
    pub fn authorizationIntent(self: Persistence, prepared: *const Prepared) !void {
        try prepared.validate();
        if (self.persistAuthorizationIntent) |persist| return persist(self.context, prepared.authority.operation_id, prepared.canonical_intent);
        return self.intent(prepared);
    }
    pub fn signed(self: Persistence, prepared: *const Prepared, transaction: *const Signed) !void {
        try self.persistSigned(self.context, prepared.authority.operation_id, transaction.identity, transaction.bytes);
    }
};
pub const Entropy = struct {
    context: ?*anyopaque = null,
    fill_fn: *const fn (?*anyopaque, *Hash) anyerror!void = system,
    pub fn seed(self: Entropy) !Hash {
        var out: Hash = undefined;
        try self.fill_fn(self.context, &out);
        return out;
    }
    fn system(_: ?*anyopaque, out: *Hash) !void {
        std.crypto.random.bytes(out);
    }
};
pub const Expenditure = struct { gas_used: u256, tokens_used: u256 };
pub const Receipt = struct { identity: Identity, block_hash: Hash, height: u64, success: bool, finalized: bool, expenditure: ?Expenditure = null };

test "Destination canonical recovery binds authority and rejects edited context" {
    const a = std.testing.allocator;
    const context: Authority = .{ .protocol = .tron, .origin = 1, .destination = 2, .mailbox = .{3} ** 32, .chain_id = "728126428", .operation_id = .{4} ** 32, .generation = 7 };
    var original = try Prepared.init(a, context, "{\"nonce\":7}", 100, 200);
    defer original.deinit();
    var recovered = try Prepared.restore(a, original.canonical_intent);
    defer recovered.deinit();
    try std.testing.expectEqual(original.digest(), recovered.digest());
    try std.testing.expectEqual(@as(u64, 7), recovered.authority.generation);
    recovered.authority.origin += 1;
    try std.testing.expectError(error.DestinationIntentChanged, recovered.validate());
}
