//! Concrete Aleo validator observations/votes for the durable shared service.
//! The checkpoint signer remains EVM secp256k1; Aleo transaction signing is separate.
const std = @import("std");
const settings = @import("../settings/root.zig");
const http = @import("../cloud/http.zig");
const endpoint = @import("../net/endpoint.zig");
const rest = @import("rest.zig");
const provider = @import("provider.zig");
const crypto = @import("crypto.zig");
const contracts = @import("contracts.zig");
const codec = @import("codec.zig");
const service = @import("../agents/validator.zig");
const driver = @import("../agents/validator/driver.zig");
const objects = @import("../storage/objects.zig");
const Slot = struct { endpoint: endpoint.OwnedEndpoint, rest_endpoint: [1]rest.Endpoint, provider: provider.Provider, chain: contracts.Contracts };
pub const Source = struct {
    allocator: std.mem.Allocator,
    slots: []*Slot,
    consensus: bool,
    domain: u32,
    hook: [32]u8,
    pub fn init(a: std.mem.Allocator, s: *const settings.Settings, transport: http.Transport, native: *crypto.Crypto) !*Source {
        if (s.role != .validator) return error.ExpectedValidatorSettings;
        const role = s.role.validator;
        const chain = s.chainByName(role.origin_chain) orelse return error.UnknownOriginChain;
        if (chain.protocol != .aleo) return error.ExpectedAleoOrigin;
        if (role.lightweight or role.websocket_url != null) return error.UnsupportedAleoValidatorTransport;
        const network = try std.fmt.parseInt(u16, chain.chain_id, 10);
        _ = try rest.networkName(network);
        const consensus = role.checkpoint_consensus != null;
        const self = try a.create(Source);
        errdefer a.destroy(self);
        var slots: std.ArrayList(*Slot) = .empty;
        defer slots.deinit(a);
        errdefer for (slots.items) |slot| {
            slot.endpoint.deinit();
            a.destroy(slot);
        };
        const config: contracts.Config = .{ .mailbox = chain.connection.aleo.mailbox_program, .hook_manager = chain.connection.aleo.hook_manager_program, .ism_manager = chain.connection.aleo.ism_manager_program, .validator_announce = chain.connection.aleo.validator_announce_program, .hook = chain.contracts.merkle_tree_hook, .domain = chain.domain };
        if (consensus) {
            for (role.rpcs) |rpc| {
                if (rpc.public and !role.allow_public_rpcs) return error.PublicRpcRequiresOptIn;
                try add(a, &slots, transport, native, rpc.url, network, config);
            }
        } else for (chain.rpc_urls) |url| try add(a, &slots, transport, native, url, network, config);
        if (slots.items.len == 0) return error.EmptyAleoEndpoints;
        self.* = .{ .allocator = a, .slots = try slots.toOwnedSlice(a), .consensus = consensus, .domain = chain.domain, .hook = chain.contracts.merkle_tree_hook };
        return self;
    }
    fn add(a: std.mem.Allocator, slots: *std.ArrayList(*Slot), transport: http.Transport, native: *crypto.Crypto, url: []const u8, network: u16, config: contracts.Config) !void {
        var owned = try endpoint.OwnedEndpoint.parse(a, url);
        errdefer owned.deinit();
        for (slots.items) |slot| if (std.mem.eql(u8, slot.endpoint.identity, owned.identity)) {
            owned.deinit();
            return;
        };
        const slot = try a.create(Slot);
        errdefer a.destroy(slot);
        slot.endpoint = owned;
        slot.rest_endpoint = .{owned.endpoint};
        slot.provider = .{ .client = try rest.Client.init(a, transport, &slot.rest_endpoint, network), .native = native };
        slot.chain = try contracts.Contracts.init(&slot.provider, config);
        try slots.append(a, slot);
    }
    pub fn deinit(self: *Source) void {
        const a = self.allocator;
        for (self.slots) |slot| {
            slot.endpoint.deinit();
            a.destroy(slot);
        }
        a.free(self.slots);
        a.destroy(self);
    }
    pub fn endpointCount(self: *const Source) usize {
        return if (self.consensus) self.slots.len else 1;
    }
    pub fn interface(self: *Source) driver.Source {
        return .{ .context = self, .finalized_height = height, .insertion = insertion, .checkpoint = checkpoint };
    }
    pub fn tick(self: *Source, state: *service.Service, signer: service.Signer, publisher: service.Publisher, timestamp: u64, limits: driver.Limits) !driver.Progress {
        if (state.options.domain != self.domain or !std.mem.eql(u8, &state.options.hook, &self.hook) or state.options.endpoint_count != self.endpointCount()) return error.WrongAleoValidatorContext;
        return driver.tick(state, self.interface(), signer, publisher, timestamp, limits);
    }
    fn height(context: *anyopaque, _: objects.ReorgPeriod) !u64 {
        const self: *Source = @ptrCast(@alignCast(context));
        var last: anyerror = error.NoHealthyAleoEndpoint;
        for (self.slots) |slot| {
            return slot.provider.height() catch |err| {
                last = err;
                continue;
            };
        }
        return last;
    }
    fn insertion(context: *anyopaque, index: u32, finalized: u64) !?service.Observation {
        const self: *Source = @ptrCast(@alignCast(context));
        var last: anyerror = error.NoHealthyAleoEndpoint;
        for (self.slots) |slot| {
            return readInsertion(slot, index, finalized) catch |err| {
                last = err;
                continue;
            };
        }
        return last;
    }
    fn readInsertion(slot: *Slot, index: u32, finalized: u64) !?service.Observation {
        const a = slot.provider.client.allocator;
        const hook = try slot.provider.native.addressText(a, slot.chain.config.hook);
        defer a.free(hook);
        const key = try std.fmt.allocPrint(a, "{{hook: {s}, index: {d}u32}}", .{ hook, index });
        defer a.free(key);
        var result = try slot.provider.mapping(slot.chain.config.hook_manager, "inserted_into_tree_events", key, true);
        defer result.deinit();
        const value = result.value() orelse return null;
        const event = try codec.insertion(value);
        if (event.index != index) return error.InconsistentAleoEventIndex;
        const actual = result.height orelse return error.MissingAleoMappingHeight;
        if (actual > finalized) return null;
        const block = try slot.provider.header(actual);
        return .{ .message_id = event.id, .block_height = actual, .block_hash = block.hash };
    }
    fn checkpoint(context: *anyopaque, index: usize, _: objects.ReorgPeriod) !?service.Checkpoint {
        const self: *Source = @ptrCast(@alignCast(context));
        if (self.consensus) {
            if (index >= self.slots.len) return error.AleoEndpointPoolChanged;
            return self.vote(self.slots[index]);
        }
        if (index != 0) return error.AleoEndpointPoolChanged;
        var last: anyerror = error.NoHealthyAleoEndpoint;
        for (self.slots) |slot| {
            return self.vote(slot) catch |err| {
                last = err;
                continue;
            };
        }
        return last;
    }
    fn vote(self: *Source, slot: *Slot) !?service.Checkpoint {
        const actual = slot.chain.latestCheckpoint() catch |err| switch (err) {
            error.EmptyAleoMerkleTree => return null,
            else => return err,
        };
        const insertion_ = try readInsertion(slot, actual.index, std.math.maxInt(u64)) orelse return null;
        return .{ .merkle_tree_hook_address = self.hook, .mailbox_domain = self.domain, .root = actual.root, .index = actual.index, .message_id = insertion_.message_id };
    }
};
