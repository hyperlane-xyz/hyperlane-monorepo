//! Source-exact common monitor queries over existing typed chain clients. A
//! fork borrows its parent's pools/runtime, owns IDs/journals, and has no signer.
const std = @import("std");
const resources = @import("chain_source.zig");
const clients_module = @import("scraper/factory.zig");
const settings = @import("../settings/types.zig");
const monitor = @import("health_metrics.zig");
const json = @import("../cosmos/types.zig");
const abi = @import("../evm/codecs.zig");
const proto = @import("../cosmos/proto.zig");
const sbor = @import("../radix/sbor.zig");
const radix_address = @import("../radix/address.zig");
const A = std.mem.Allocator;
pub const Adapter = struct {
    allocator: A,
    owner: *resources.Resources,
    /// Independent construction from immutable settings/options. Supplying a
    /// borrowed RPC pool preserves its existing I/O owner; otherwise normal
    /// Resources construction owns one bounded pool for this chain. HTTP always
    /// shares the role runtime/budget. No network or key reads during open.
    pub fn openFromSettings(a: A, chain_config: *const settings.Chain, environment: *const std.process.EnvMap, provided: resources.Options) !*Adapter {
        var config = chain_config.*;
        config.signer = null;
        config.identity = null;
        config.ccs_signer = null;
        var options = provided;
        options.operation = .agent_metrics;
        options.indexer_tip_cache = false;
        options.cooperative_reads = true;
        const child = try resources.Resources.open(a, &config, environment, options);
        errdefer child.deinit();
        const self = try a.create(Adapter);
        self.* = .{ .allocator = a, .owner = child };
        return self;
    }
    pub fn openFork(a: A, parent: *resources.Resources) !*Adapter {
        const child = try parent.forkReadFor(a, .agent_metrics);
        errdefer child.deinit();
        const self = try a.create(Adapter);
        self.* = .{ .allocator = a, .owner = child };
        return self;
    }
    /// Stop and drain every borrowing monitor before closing this fork. Parent
    /// resources/settings/shared runtimes/Registry outlive the fork.
    pub fn deinit(self: *Adapter) void {
        self.owner.deinit();
        self.allocator.destroy(self);
    }
    pub fn interface(self: *Adapter) monitor.Provider {
        return .{ .context = self, .begin_fn = begin, .end_fn = end, .commit_fn = commit, .balance_fn = balance, .chain_fn = chain };
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn begin(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        try cast(context).owner.beginReadPass(cancel);
    }
    fn end(context: *anyopaque, failure: ?anyerror) void {
        cast(context).owner.endReadPass(failure);
    }
    fn commit(context: *anyopaque) !void {
        try cast(context).owner.commitReadSection();
    }
    fn balance(context: *anyopaque, address: []const u8) !u256 {
        const owner = cast(context).owner;
        return queryBalance(owner.allocator, owner.clients, &owner.chain, address);
    }
    fn chain(context: *anyopaque) !?monitor.ChainInfo {
        const owner = cast(context).owner;
        return queryChain(owner.clients);
    }
};

pub fn queryChain(clients: clients_module.Clients) !?monitor.ChainInfo {
    return switch (clients) {
        .ethereum => |client| blk: {
            var response = try client.call("eth_getBlockByNumber", .{ "latest", false });
            defer response.deinit();
            const value = response.value();
            if (value == .null) break :blk null;
            const number = try abi.quantity(try json.string(try json.field(value, "number")));
            const gas = value.object.get("baseFeePerGas") orelse .null;
            break :blk .{ .block_height = number, .min_gas_price = if (gas == .null) null else try abi.quantityAs(u256, try json.string(gas)) };
        },
        .sealevel => |client| blk: {
            var response = try client.call("getSlot", .{.{ .commitment = "finalized" }});
            defer response.deinit();
            break :blk .{ .block_height = try @import("../sealevel/provider.zig").uint(response.value()) };
        },
        .cosmos => |client| blk: {
            // Source Tendermint latest_block(), not status and not gRPC latest.
            var response = try client.tendermint.rpc_client.call("block", .{ .height = @as(?u64, null) });
            defer response.deinit();
            const header = try json.field(try json.field(response.value(), "block"), "header");
            if (!std.mem.eql(u8, try json.string(try json.field(header, "chain_id")), client.tendermint.chain_id)) return error.WrongCosmosChainId;
            break :blk .{ .block_height = try json.uint(try json.field(header, "height")) };
        },
        .radix => |client| .{ .block_height = (try client.gatewayState()).state_version },
        .tron => |client| .{ .block_height = (try client.finalizedBlock()).number },
        .starknet => |factory| .{ .block_height = try factory.provider.blockNumber() },
        .aleo => |factory| .{ .block_height = try factory.provider.height() },
    };
}

pub fn queryBalance(a: A, clients: clients_module.Clients, chain_config: *const settings.Chain, address: []const u8) !u256 {
    return switch (clients) {
        .ethereum => |client| blk: {
            _ = try abi.fixedHex(20, address);
            var response = try client.call("eth_getBalance", .{ address, "latest" });
            defer response.deinit();
            break :blk try abi.quantityAs(u256, try json.string(response.value()));
        },
        .sealevel => |client| blk: {
            _ = try @import("../sealevel/provider.zig").decodeKey(a, address);
            var response = try client.call("getBalance", .{ address, .{ .commitment = "processed" } });
            defer response.deinit();
            _ = try @import("../sealevel/provider.zig").uint(try json.field(try json.field(response.value(), "context"), "slot"));
            break :blk try @import("../sealevel/provider.zig").uint(try json.field(response.value(), "value"));
        },
        .cosmos => |client| blk: {
            const config = switch (chain_config.connection) {
                .cosmos => |c| c,
                .cosmosnative => |c| c,
                else => return error.WrongHealthProtocol,
            };
            _ = try json.decodeAddress(address, config.bech32_prefix);
            const request = try proto.queryPair(a, address, config.canonical_asset);
            defer a.free(request);
            var response = try client.tendermint.abciQuery(proto.paths.balance, request, null, false);
            defer response.deinit();
            const coin = try proto.bytesField(response.value, 1) orelse return error.MissingHealthBalance;
            break :blk try std.fmt.parseInt(u256, try proto.textField(coin, 2), 10);
        },
        .radix => |client| radixBalance(a, client, address),
        .tron => |client| blk: {
            const hash = try @import("../settings/root.zig").address(a, address);
            if (!std.mem.allEqual(u8, hash[0..12], 0)) return error.InvalidHealthWalletAddress;
            break :blk try client.balance(hash[12..32].*);
        },
        .starknet => |factory| blk: {
            const token = try @import("../starknet/codec.zig").Felt.fromBytes(chain_config.connection.starknet.native_token);
            const owner = try @import("../starknet/codec.zig").Felt.fromHex(address);
            break :blk try factory.provider.balance(token, owner);
        },
        .aleo => |factory| try factory.provider.balance(try factory.provider.native.address(address)),
    };
}
fn radixBalance(a: A, client: @import("../radix/provider.zig").Client, account_text: []const u8) !u256 {
    var account: [30]u8 = undefined;
    if ((try radix_address.decode(client.network, "account", account_text, &account)).len != 30) return error.InvalidHealthWalletAddress;
    // XRD's node ID is network-independent; SDK constants::XRD. The RPC target
    // must retain the account HRP (Client.callMethod targets component HRPs).
    var xrd: [30]u8 = undefined;
    if ((try radix_address.decode(.mainnet, "resource", "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd", &xrd)).len != 30) return error.InvalidHealthXrd;
    var writer: sbor.Writer = .{ .allocator = a };
    defer writer.deinit();
    try writer.byte(0x4d);
    try writer.address(xrd);
    const argument = try json.hex(a, writer.list.items);
    defer a.free(argument);
    var response = try client.call(client.core, "/transaction/call-preview", .{ .network = client.network.logical_name, .target = .{ .type = "Method", .component_address = account_text, .method_name = "balance" }, .arguments = [_][]const u8{argument} });
    defer response.deinit();
    const value = response.value();
    if (!std.mem.eql(u8, try json.string(try json.field(value, "status")), "Succeeded")) return error.RadixPreviewFailed;
    _ = try json.uint(try json.field(try json.field(value, "at_ledger_state"), "state_version"));
    const encoded = try json.string(try json.field(try json.field(value, "output"), "hex"));
    if (encoded.len % 2 != 0 or encoded.len > 128) return error.InvalidHealthBalance;
    var bytes: [64]u8 = undefined;
    const decoded = try std.fmt.hexToBytes(&bytes, encoded);
    const amount = try sbor.decimalAttos(try sbor.decode(decoded, .scrypto));
    return if (amount < 0) 0 else @intCast(amount);
}
