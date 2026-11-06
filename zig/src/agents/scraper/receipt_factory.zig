//! One independently owned chain client per receipt worker. Bindings borrow
//! those clients and the chain settings; the heap allocation stabilizes contexts.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const enrich = @import("enrichment.zig");
const evm = @import("receipts_evm.zig");
const svm = @import("receipts_sealevel.zig");
const cosmos = @import("receipts_cosmos.zig");
const radix = @import("receipts_radix.zig");
const tron = @import("receipts_tron.zig");
const starknet = @import("receipts_starknet.zig");
const aleo = @import("receipts_aleo.zig");
const Http = @import("../../cloud/http.zig").HttpTransport;
pub const Clients = union(enum) {
    ethereum: *@import("../../evm/provider.zig").RpcClient,
    sealevel: *@import("../../sealevel/provider.zig").Client,
    cosmos: @import("../../cosmos/tendermint.zig").Client,
    radix: struct { client: @import("../../radix/provider.zig").Client, http_owner: *Http },
    tron: struct { provider: *@import("../../tron/provider.zig").Provider, http_owner: *Http },
    starknet: struct { provider: *@import("../../starknet/provider.zig").Provider, http_owner: *Http },
    aleo: struct { provider: *@import("../../aleo/provider.zig").Provider, decoder: @import("../../aleo/events.zig").NativeDecoder, http_owner: *Http },
};
pub const Options = struct { allow_std_fixture: bool = false };
pub const Factory = struct {
    allocator: std.mem.Allocator,
    programs: [3][32]u8,
    implementation: union(enum) { ethereum: evm.Evm, sealevel: svm.Sealevel, cosmos: cosmos.Cosmos, radix: radix.Radix, tron: tron.Tron, starknet: starknet.Starknet, aleo: aleo.Aleo },
    pub fn init(a: std.mem.Allocator, clients: Clients, chain: *const settings.Chain, options: Options) !*Factory {
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
        const self = try a.create(Factory);
        errdefer a.destroy(self);
        self.allocator = a;
        self.programs = .{ chain.contracts.mailbox, chain.contracts.merkle_tree_hook, chain.contracts.interchain_gas_paymaster };
        self.implementation = switch (clients) {
            .ethereum => |client| blk: {
                if (client.options.native_transport == null and !options.allow_std_fixture) return error.NativeReceiptTransportRequired;
                break :blk .{ .ethereum = .{ .rpc_client = client, .allow_std_fixture = options.allow_std_fixture } };
            },
            .sealevel => |client| blk: {
                if (client.rpc_client.options.native_transport == null and !options.allow_std_fixture) return error.NativeReceiptTransportRequired;
                if (client.commitment != .finalized or chain.connection != .sealevel) return error.FinalizedSvmScraperRequired;
                if (chain.native_token.decimals > 18) return error.InvalidNativeTokenDecimals;
                break :blk .{ .sealevel = .{ .client = client, .programs = &self.programs, .native_decimals = chain.native_token.decimals, .max_transaction_version = chain.connection.sealevel.max_supported_transaction_version, .allow_std_fixture = options.allow_std_fixture } };
            },
            .cosmos => |client| blk: {
                if (client.rpc_client.options.native_transport == null and !options.allow_std_fixture) return error.NativeReceiptTransportRequired;
                if (!std.mem.eql(u8, client.chain_id, chain.chain_id)) return error.WrongCosmosChainId;
                const config = switch (chain.connection) {
                    .cosmos => |config| config,
                    .cosmosnative => |config| config,
                    else => return error.WrongScraperProtocol,
                };
                if (chain.native_token.decimals > 18) return error.InvalidNativeTokenDecimals;
                break :blk .{ .cosmos = .{ .client = client, .config = .{ .native = chain.protocol == .cosmosnative, .bech32_prefix = config.bech32_prefix, .gas_denom = config.gas_price.denom, .native_denom = chain.native_token.denom, .native_decimals = chain.native_token.decimals }, .allow_std_fixture = options.allow_std_fixture } };
            },
            .radix => |client| blk: {
                if (chain.connection != .radix or !std.mem.eql(u8, chain.connection.radix.network_name, client.client.network.logical_name)) return error.WrongRadixNetwork;
                try verify(client.http_owner, client.client.transport, options);
                break :blk .{ .radix = .{ .client = client.client, .http_owner = client.http_owner, .allow_std_fixture = options.allow_std_fixture } };
            },
            .tron => |client| blk: {
                try verify(client.http_owner, client.provider.jsonrpc.transport, options);
                try verify(client.http_owner, client.provider.solidity.transport, options);
                break :blk .{ .tron = .{ .provider = client.provider, .http_owner = client.http_owner, .allow_std_fixture = options.allow_std_fixture } };
            },
            .starknet => |client| blk: {
                try verify(client.http_owner, client.provider.client.transport, options);
                break :blk .{ .starknet = .{ .provider = client.provider, .http_owner = client.http_owner, .allow_std_fixture = options.allow_std_fixture } };
            },
            .aleo => |client| blk: {
                try verify(client.http_owner, client.provider.client.transport, options);
                break :blk .{ .aleo = .{ .provider = client.provider, .decoder = client.decoder, .http_owner = client.http_owner, .allow_std_fixture = options.allow_std_fixture } };
            },
        };
        return self;
    }
    fn verify(owner: *Http, transport: @import("../../cloud/http.zig").Transport, options: Options) !void {
        const bounded: @import("receipts_common.zig").DeadlineTransport = .{ .rpc_read = true, .owner = owner, .deadline_ns = 0, .allow_std_fixture = options.allow_std_fixture };
        try bounded.verify(transport);
    }
    pub fn interface(self: *Factory) enrich.Fetcher {
        return switch (self.implementation) {
            inline else => |*implementation| implementation.interface(),
        };
    }
    pub fn deinit(self: *Factory) void {
        const a = self.allocator;
        a.destroy(self);
    }
};

test "scraper receipt factory rejects protocol mismatch and production unbounded transports before I/O" {
    var chain: settings.Chain = undefined;
    chain.protocol = .aleo;
    try std.testing.expectError(error.WrongScraperProtocol, Factory.init(std.testing.allocator, .{ .ethereum = undefined }, &chain, .{}));
    chain.protocol = .ethereum;
    chain.contracts = .{ .mailbox = .{1} ** 32, .merkle_tree_hook = .{2} ** 32, .interchain_gas_paymaster = .{3} ** 32, .validator_announce = .{4} ** 32 };
    var rpc = try @import("../../evm/provider.zig").RpcClient.init(std.testing.allocator, "https://fixture.invalid", .{});
    defer rpc.deinit();
    try std.testing.expectError(error.NativeReceiptTransportRequired, Factory.init(std.testing.allocator, .{ .ethereum = &rpc }, &chain, .{}));
    const factory = try Factory.init(std.testing.allocator, .{ .ethereum = &rpc }, &chain, .{ .allow_std_fixture = true });
    defer factory.deinit();
    _ = factory.interface();
}
