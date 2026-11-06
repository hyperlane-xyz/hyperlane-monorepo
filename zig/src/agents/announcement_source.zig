//! Concrete eight-VM announcement discovery over a dedicated resource owner.
//! No constructor I/O. Keep this value and Resources stable through all registry
//! calls; do not share its mutable providers with indexing or receipt workers.
const std = @import("std");
const resources = @import("chain_source.zig");
const registry = @import("../relayer/announced_readers.zig");
const evm = @import("../evm/announce.zig");
const A = std.mem.Allocator;
pub const Factory = struct {
    resources: *resources.Resources,
    limits: evm.Limits = .{},
    pub fn init(owner: *resources.Resources) Factory {
        return .{ .resources = owner };
    }
    pub fn interface(self: *Factory) registry.LocationSource {
        return .{ .context = self, .fetch_fn = fetch, .begin_pass_fn = beginPass, .end_pass_fn = endPass };
    }
    fn beginPass(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *Factory = @ptrCast(@alignCast(context));
        try self.resources.beginReadPass(cancel);
    }
    fn endPass(context: *anyopaque, failure: ?anyerror) void {
        const self: *Factory = @ptrCast(@alignCast(context));
        self.resources.endReadPass(failure);
    }
    fn fetch(context: *anyopaque, a: A, validators: []const [20]u8, cancel: ?*const std.atomic.Value(bool)) !registry.Locations {
        const self: *Factory = @ptrCast(@alignCast(context));
        if (validators.len > self.limits.max_validators) return error.TooManyValidators;
        if (cancel) |token| if (token.load(.acquire)) return error.RequestCancelled;
        const owner = self.resources;
        owner.setCancellation(cancel);
        defer owner.setCancellation(null);
        // The same lazy source initialization performs configured identity and
        // contract capability checks before the first chain read.
        _ = try owner.source();
        const chain = &owner.chain;
        switch (owner.clients) {
            .ethereum => |client| {
                var raw = try evm.fetch(client, try address20(chain.contracts.validator_announce), validators, .latest, self.limits);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .sealevel => |client| {
                var raw = try @import("../sealevel/announcement.zig").locations(a, client, chain.contracts.validator_announce, validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .cosmos => |clients| {
                var queries = clients.queries;
                queries.cancel = cancel;
                var raw = if (chain.protocol == .cosmosnative) try queries.nativeLocations(chain.contracts.validator_announce, validators) else try queries.wasmLocations(chain.contracts.validator_announce, validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .radix => |client| {
                const contracts: @import("../radix/contracts.zig").Client = .{ .provider = client, .mailbox = try @import("../radix/address.zig").node(chain.contracts.mailbox), .domain = chain.domain };
                var raw = try contracts.locations(try @import("../radix/address.zig").node(chain.contracts.validator_announce), validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .tron => |client| {
                const contracts: @import("../tron/contracts.zig").Contracts = .{ .provider = client, .mailbox = try address20(chain.contracts.mailbox), .hook = try address20(chain.contracts.merkle_tree_hook), .domain = chain.domain };
                var raw = try contracts.announcedLocations(try address20(chain.contracts.validator_announce), validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .starknet => |client| {
                const Felt = @import("../starknet/codec.zig").Felt;
                const contracts: @import("../starknet/contracts.zig").Contracts = .{ .provider = &client.provider, .mailbox = try Felt.fromBytes(chain.contracts.mailbox), .hook = try Felt.fromBytes(chain.contracts.merkle_tree_hook), .domain = chain.domain };
                var raw = try contracts.announcedLocations(try Felt.fromBytes(chain.contracts.validator_announce), validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
            .aleo => |client| {
                var contracts = try @import("../aleo/contracts.zig").Contracts.init(&client.provider, client.configuration);
                var raw = try contracts.locations(validators);
                defer raw.deinit();
                return duplicate(a, raw.values, validators.len, self.limits);
            },
        }
    }
};
fn address20(value: [32]u8) ![20]u8 {
    if (!std.mem.allEqual(u8, value[0..12], 0)) return error.NonCanonicalAnnouncementAddress;
    return value[12..32].*;
}
fn duplicate(a: A, input: anytype, expected: usize, limits: evm.Limits) !registry.Locations {
    if (input.len != expected or expected > limits.max_validators) return error.WrongValidatorLocationsCount;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const values = try owned.alloc([][]const u8, input.len);
    var total_count: usize = 0;
    var total_bytes: usize = 0;
    for (input, values) |locations, *out| {
        if (locations.len > limits.max_per_validator) return error.TooManyAnnouncedLocations;
        total_count = try std.math.add(usize, total_count, locations.len);
        if (total_count > limits.max_total_locations) return error.TooManyAnnouncedLocations;
        out.* = try owned.alloc([]const u8, locations.len);
        for (locations, out.*) |location, *value| {
            if (location.len > limits.max_location_bytes or !std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementLocation;
            total_bytes = try std.math.add(usize, total_bytes, location.len);
            if (total_bytes > limits.max_total_bytes) return error.AnnouncementLocationsByteLimit;
            value.* = try owned.dupe(u8, location);
        }
    }
    return .{ .arena = arena, .values = values };
}
test "announcement source constructor does no I/O and cancelled callbacks cannot touch providers" {
    var owner: resources.Resources = undefined;
    var factory = Factory.init(&owner);
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, factory.interface().fetch_fn(&factory, std.testing.allocator, &.{.{1} ** 20}, &cancel));
}
fn allocationSweep(a: A) !void {
    const input = [_][]const []const u8{ &.{ "s3://first/region", "gs://second/folder" }, &.{}, &.{"file:///fixture"} };
    var result = try duplicate(a, &input, 3, .{});
    defer result.deinit();
    try std.testing.expectEqualStrings("s3://first/region", result.values[0][0]);
    try std.testing.expectEqual(@as(usize, 0), result.values[1].len);
    try std.testing.expectEqualStrings("file:///fixture", result.values[2][0]);
}
test "announcement source owns ordered lists bounds all bytes and cleans allocator failures" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
    const input = [_][]const []const u8{&.{"s3://first/region"}};
    try std.testing.expectError(error.AnnouncementLocationsByteLimit, duplicate(std.testing.allocator, &input, 1, .{ .max_total_bytes = 1 }));
    try std.testing.expectError(error.WrongValidatorLocationsCount, duplicate(std.testing.allocator, &input, 2, .{}));
}
