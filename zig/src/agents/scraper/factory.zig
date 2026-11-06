//! Heap-stable source bindings over concrete borrowed chain clients. Endpoint
//! construction, provider fallback pools and worker cancellation remain owned by
//! the parent runtime; every binding here executes actual protocol indexing.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const src = @import("source.zig");
const evm = @import("evm.zig");
const svm = @import("sealevel.zig");
const cosmos = @import("cosmos.zig");
const radix = @import("radix.zig");
const tron = @import("tron.zig");
const starknet = @import("starknet.zig");
const aleo = @import("aleo.zig");
pub const CosmosClients = struct { tendermint: @import("../../cosmos/tendermint.zig").Client, queries: @import("../../cosmos/contracts.zig").Client };
pub const Clients = union(enum) {
    ethereum: *@import("../../evm/provider.zig").RpcClient,
    sealevel: *@import("../../sealevel/provider.zig").Client,
    cosmos: CosmosClients, // both CosmWasm and CosmosNative, selected by chain.protocol
    radix: @import("../../radix/provider.zig").Client,
    tron: *@import("../../tron/provider.zig").Provider,
    starknet: *starknet.Factory,
    aleo: *aleo.Factory,
};
pub const Factory = struct {
    allocator: std.mem.Allocator,
    implementation: union(enum) { ethereum: evm.Evm, sealevel: *svm.Adapter, cosmos: cosmos.Adapter, radix: radix.Adapter, tron: tron.Adapter, starknet: *starknet.Factory, aleo: *aleo.Factory },
    pub fn init(allocator: std.mem.Allocator, clients: Clients, chain: *const settings.Chain) !*Factory {
        if (chain.index.chunk == 0) return error.InvalidScraperChunk;
        const matches = switch (clients) {
            .ethereum => chain.protocol == .ethereum,
            .sealevel => chain.protocol == .sealevel,
            .cosmos => chain.protocol == .cosmos or chain.protocol == .cosmosnative,
            .radix => chain.protocol == .radix,
            .tron => chain.protocol == .tron,
            .starknet => chain.protocol == .starknet,
            .aleo => chain.protocol == .aleo,
        };
        if (!matches) return error.WrongScraperProtocol;
        const self = try allocator.create(Factory);
        errdefer allocator.destroy(self);
        const configured: src.Contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster };
        self.allocator = allocator;
        self.implementation = switch (clients) {
            .ethereum => |client| blk: {
                if (client.options.native_transport == null) return error.NativeScraperTransportRequired;
                try client.checkChain(try std.fmt.parseInt(u256, chain.chain_id, if (std.mem.startsWith(u8, chain.chain_id, "0x")) 0 else 10));
                break :blk .{ .ethereum = .{ .rpc_client = client, .contracts = configured, .domain = chain.domain } };
            },
            .sealevel => |client| blk: {
                if (client.rpc_client.options.native_transport == null) return error.NativeScraperTransportRequired;
                break :blk .{ .sealevel = try svm.Adapter.fromChain(allocator, client, chain) };
            },
            .cosmos => |clients_| .{ .cosmos = try cosmos.Adapter.fromChain(clients_.tendermint, clients_.queries, chain) },
            .radix => |client| .{ .radix = try radix.Adapter.fromChain(client, chain) },
            .tron => |client| .{ .tron = try tron.Adapter.fromChain(client, chain) },
            .starknet => |client| if (client.configuration.domain == chain.domain) .{ .starknet = client } else return error.WrongScraperDomain,
            .aleo => |client| if (client.configuration.domain == chain.domain) .{ .aleo = client } else return error.WrongScraperDomain,
        };
        return self;
    }
    pub fn interface(self: *Factory) !src.Source {
        return switch (self.implementation) {
            .ethereum => |*value| value.interface(),
            .sealevel => |value| value.interface(),
            .cosmos => |*value| value.interface(),
            .radix => |*value| value.interface(),
            .tron => |*value| value.interface(),
            .starknet => |value| try value.interface(),
            .aleo => |value| value.interface(),
        };
    }
    pub fn deinit(self: *Factory) void {
        if (self.implementation == .sealevel) self.implementation.sealevel.deinit();
        const allocator = self.allocator;
        allocator.destroy(self);
    }
};
test "scraper concrete source factory rejects mismatched clients before reading resources" {
    var chain: settings.Chain = undefined;
    chain.protocol = .aleo;
    chain.index.chunk = 1;
    try std.testing.expectError(error.WrongScraperProtocol, Factory.init(std.testing.allocator, .{ .tron = undefined }, &chain));
}
