//! Aleo program mappings and function input construction, separate from proving.
const std = @import("std");
const provider = @import("provider.zig");
const p = @import("plaintext.zig");
const codec = @import("codec.zig");
const protocol = @import("../protocol/root.zig");
pub const Config = struct { mailbox: []const u8, hook_manager: []const u8, ism_manager: []const u8, validator_announce: []const u8, hook: [32]u8, domain: u32 };
pub const MailboxState = struct { count: u32, processed: u32, default_ism: [32]u8, height: ?u32 };
pub const TreeAt = struct { tree: codec.Tree, height: u32 };
pub const CheckpointAt = struct { root: [32]u8, index: u32, height: u32 };
pub const OwnedCall = struct {
    arena: std.heap.ArenaAllocator,
    program_id: []const u8,
    function_name: []const u8,
    inputs: []const []const u8,
    pub fn json(self: *const OwnedCall, a: std.mem.Allocator) ![]u8 {
        return std.json.Stringify.valueAlloc(a, .{ .program_id = self.program_id, .function_name = self.function_name, .inputs = self.inputs }, .{});
    }
    pub fn deinit(self: *OwnedCall) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Contracts = struct {
    provider: *provider.Provider,
    config: Config,
    pub fn init(client: *provider.Provider, config: Config) !Contracts {
        for ([_][]const u8{ config.mailbox, config.hook_manager, config.ism_manager, config.validator_announce }) |name| _ = try client.native.programAddress(name);
        const address_ = try client.native.addressText(client.client.allocator, config.hook);
        client.client.allocator.free(address_);
        return .{ .provider = client, .config = config };
    }
    fn address(self: *Contracts, text: []const u8) ![32]u8 {
        return self.provider.native.address(text);
    }
    pub fn mailbox(self: *Contracts, metadata: bool) !MailboxState {
        var result = try self.provider.mapping(self.config.mailbox, "mailbox", "true", metadata);
        defer result.deinit();
        const value = result.value() orelse return error.AleoMailboxUninitialized;
        return .{ .count = try (try value.member("nonce")).number(u32), .processed = try (try value.member("process_count")).number(u32), .default_ism = try self.address(try atom(try value.member("default_ism"))), .height = result.height };
    }
    pub fn delivered(self: *Contracts, id: [32]u8) !bool {
        var words = p.hashWords(id);
        const root: p.Value = .{ .object = &.{.{ .name = "id", .value = .{ .array = &words } }} };
        const key = try root.render(self.provider.client.allocator);
        defer self.provider.client.allocator.free(key);
        var result = try self.provider.mapping(self.config.mailbox, "deliveries", key, false);
        defer result.deinit();
        if (result.value()) |value| {
            _ = try (try value.member("block_number")).number(u32);
            _ = try self.address(try atom(try value.member("processor")));
            return true;
        }
        return false;
    }
    pub fn tree(self: *Contracts) !TreeAt {
        const a = self.provider.client.allocator;
        const hook = try self.provider.native.addressText(a, self.config.hook);
        defer a.free(hook);
        var result = try self.provider.mapping(self.config.hook_manager, "merkle_tree_hooks", hook, true);
        defer result.deinit();
        const decoded = try codec.tree(result.value() orelse return error.UnknownAleoHook);
        const frontier: protocol.IncrementalMerkle = .{ .branch = decoded.branch, .count = decoded.count };
        if (!std.mem.eql(u8, &frontier.root(), &decoded.root)) return error.AleoMerkleRootMismatch;
        return .{ .tree = decoded, .height = result.height orelse return error.MissingAleoMappingHeight };
    }
    pub fn latestCheckpoint(self: *Contracts) !CheckpointAt {
        const actual = try self.tree();
        if (actual.tree.count == 0) return error.EmptyAleoMerkleTree;
        return .{ .root = actual.tree.root, .index = actual.tree.count - 1, .height = actual.height };
    }
    pub fn checkpointAt(_: *Contracts, _: u32) !CheckpointAt {
        return error.AleoHistoricalMappingUnavailable;
    }
    pub fn recipient(self: *Contracts, a: std.mem.Allocator, address_: [32]u8) ![]u8 {
        const key = try self.provider.native.addressText(a, address_);
        defer a.free(key);
        var result = try self.provider.mapping(self.config.mailbox, "registered_applications", key, false);
        defer result.deinit();
        const name = try codec.cString(a, result.value() orelse return error.UnregisteredAleoRecipient, 128);
        errdefer a.free(name);
        _ = try self.provider.native.programAddress(name);
        return name;
    }
    fn recipientIsmValue(self: *Contracts, program: []const u8) ![32]u8 {
        var result = try self.provider.mapping(program, "app_metadata", "true", false);
        defer result.deinit();
        if (result.value()) |value| {
            const actual = try self.address(try atom(try value.member("ism")));
            if (!std.mem.allEqual(u8, &actual, 0)) return actual;
        }
        return (try self.mailbox(false)).default_ism;
    }
    pub fn recipientIsm(self: *Contracts, address_: [32]u8) ![32]u8 {
        const a = self.provider.client.allocator;
        const program = try self.recipient(a, address_);
        defer a.free(program);
        return self.recipientIsmValue(program);
    }
    pub fn moduleType(self: *Contracts, module: [32]u8) !u8 {
        const a = self.provider.client.allocator;
        const key = try self.provider.native.addressText(a, module);
        defer a.free(key);
        var result = try self.provider.mapping(self.config.ism_manager, "isms", key, false);
        defer result.deinit();
        const value = try (result.value() orelse return error.UnknownAleoIsm).number(u8);
        if (value > 12) return error.UnsupportedAleoModule;
        return value;
    }
    pub fn validators(self: *Contracts, module: [32]u8) !codec.Members {
        const a = self.provider.client.allocator;
        const key = try self.provider.native.addressText(a, module);
        defer a.free(key);
        var result = try self.provider.mapping(self.config.ism_manager, "message_id_multisigs", key, false);
        defer result.deinit();
        return codec.members(result.value() orelse return error.UnknownAleoIsm);
    }
    pub fn route(self: *Contracts, module: [32]u8, origin: u32) ![32]u8 {
        const a = self.provider.client.allocator;
        const address_ = try self.provider.native.addressText(a, module);
        defer a.free(address_);
        const key = try std.fmt.allocPrint(a, "{{ism: {s}, domain: {d}u32}}", .{ address_, origin });
        defer a.free(key);
        var result = try self.provider.mapping(self.config.ism_manager, "routes", key, false);
        defer result.deinit();
        return self.address(try atom(result.value() orelse return error.MissingAleoRoute));
    }
    /// Source truncates body>256 and metadata>512. Reject both to avoid signing
    /// inputs that disagree with the supplied Hyperlane message/metadata.
    pub fn process(self: *Contracts, message: protocol.Message, metadata: []const u8) !OwnedCall {
        if (message.body.len > 256 or metadata.len > 512) return error.AleoProcessInputTooLarge;
        var arena = std.heap.ArenaAllocator.init(self.provider.client.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const program = try self.recipient(a, message.recipient);
        const ism = try self.recipientIsmValue(program);
        const ism_text = try self.provider.native.addressText(a, ism);
        var app = try self.provider.mapping(program, "app_metadata", "true", false);
        defer app.deinit();
        const app_text = try (app.value() orelse return error.AleoAppUninitialized).render(a);
        const message_text = try (try codec.messageValue(a, message)).render(a);
        var padded: [512]u8 = .{1} ** 512;
        @memcpy(padded[0..metadata.len], metadata);
        const inputs = try a.alloc([]const u8, 6);
        inputs[0..6].* = .{ ism_text, app_text, message_text, try std.fmt.allocPrint(a, "{d}u32", .{try std.math.add(u32, 77, @intCast(message.body.len))}), try (try p.hashArray(a, message.id())).render(a), try (try p.byteArray(a, &padded)).render(a) };
        return .{ .arena = arena, .program_id = program, .function_name = "process", .inputs = inputs };
    }
    pub fn announcement(self: *Contracts, validator: [20]u8, location: []const u8, signature: [65]u8) !OwnedCall {
        // Actual source API requires exactly480 bytes including the C-string form.
        if (location.len != 480) return error.InvalidAleoAnnouncementLength;
        const end = std.mem.indexOfScalar(u8, location, 0) orelse return error.MissingAleoStringTerminator;
        if (!std.unicode.utf8ValidateSlice(location[0..end])) return error.InvalidAleoUtf8;
        var arena = std.heap.ArenaAllocator.init(self.provider.client.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const inputs = try a.alloc([]const u8, 3);
        inputs[0..3].* = .{ try (try p.byteArray(a, &validator)).render(a), try (try p.byteArray(a, location)).render(a), try (try p.byteArray(a, &signature)).render(a) };
        const program_id = try a.dupe(u8, self.config.validator_announce);
        return .{ .arena = arena, .program_id = program_id, .function_name = "announce", .inputs = inputs };
    }
    pub fn locations(self: *Contracts, validators_: []const [20]u8) !Locations {
        if (validators_.len > 256) return error.AleoLocationLimit;
        var arena = std.heap.ArenaAllocator.init(self.provider.client.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const values = try a.alloc([][]const u8, validators_.len);
        var bytes: usize = 0;
        for (validators_, values) |validator, *out| {
            const address_value = try p.byteArray(a, &validator);
            const key = try (p.Value{ .object = &.{.{ .name = "bytes", .value = address_value }} }).render(a);
            var sequence = try self.provider.mapping(self.config.validator_announce, "storage_sequences", key, false);
            defer sequence.deinit();
            const count = if (sequence.value()) |value| try value.number(u8) else 0;
            var result: std.ArrayList([]const u8) = .empty;
            for (0..count) |index| {
                const location_key = try (p.Value{ .object = &.{ .{ .name = "validator", .value = address_value }, .{ .name = "index", .value = p.number(@as(u8, @intCast(index))) } } }).render(a);
                var item = try self.provider.mapping(self.config.validator_announce, "storage_locations", location_key, false);
                defer item.deinit();
                if (item.value()) |value| {
                    const text = try codec.cString(a, value, 480);
                    bytes = try std.math.add(usize, bytes, text.len);
                    if (bytes > 1024 * 1024) return error.AleoLocationLimit;
                    try result.append(a, text);
                }
            }
            out.* = try result.toOwnedSlice(a);
        }
        return .{ .arena = arena, .values = values };
    }
    /// The source ISM returns a placeholder success. A real process simulation
    /// verifier must be injected at runtime before accepting verification success.
    pub fn verify(_: *Contracts) !void {
        return error.AleoDryRunUnavailable;
    }
};
pub fn atom(value: p.Value) ![]const u8 {
    if (value != .atom) return error.ExpectedAleoAddress;
    return value.atom;
}

pub const Locations = struct {
    arena: std.heap.ArenaAllocator,
    values: [][][]const u8,
    pub fn deinit(self: *Locations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
const ism_metadata = @import("../relayer/metadata.zig");
const storage = @import("../storage/objects.zig");
pub const Verifier = struct { context: *anyopaque, verify_fn: *const fn (*anyopaque, [32]u8, protocol.Message, []const u8) anyerror!u256 };
pub fn Source(comptime Origin: type) type {
    return struct {
        pub const ModuleAddress = [32]u8;
        chain: Contracts,
        origin: *Origin,
        verifier: ?Verifier = null,
        const Self = @This();
        pub fn moduleType(self: *Self, address: [32]u8) !ism_metadata.ModuleType {
            return std.meta.intToEnum(ism_metadata.ModuleType, try self.chain.moduleType(address));
        }
        pub fn route(self: *Self, address: [32]u8, message: protocol.Message) ![32]u8 {
            return self.chain.route(address, message.origin);
        }
        pub fn members(self: *Self, address: [32]u8, _: protocol.Message, comptime validators_: bool) !(if (validators_) ism_metadata.Members else ism_metadata.ModuleMembers([32]u8)) {
            if (!validators_) return error.UnsupportedAleoAggregation;
            const actual = try self.chain.validators(address);
            return .{ .addresses = try self.chain.provider.client.allocator.dupe([20]u8, actual.validators[0..actual.count]), .threshold = actual.threshold };
        }
        pub fn verify(self: *Self, address: [32]u8, message: protocol.Message, bytes: []const u8) !u256 {
            const verifier = self.verifier orelse return error.AleoDryRunUnavailable;
            return verifier.verify_fn(verifier.context, address, message, bytes);
        }
        pub fn leafIndex(self: *Self, id: [32]u8) !?u32 {
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, validator: [20]u8, index: u32) !?storage.SignedCheckpoint {
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: [20]u8) !?u32 {
            return self.origin.latestIndex(validator);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.origin.proof(index, checkpoint);
        }
    };
}
