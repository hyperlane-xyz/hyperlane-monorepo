test {
    _ = @import("altvm/root.zig");
    _ = @import("sealevel/root.zig");
    _ = @import("cosmos/root.zig");
    _ = @import("radix/root.zig");
    _ = @import("evm/transaction.zig");
    _ = @import("evm/announce.zig");
    _ = @import("agents/scraper/receipts_sealevel.zig");
    _ = @import("agents/scraper/receipts_cosmos.zig");
    _ = @import("agents/scraper/receipts_radix.zig");
    _ = @import("agents/scraper/rpc_testing.zig");
}
