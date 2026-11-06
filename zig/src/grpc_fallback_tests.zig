const std = @import("std");
test {
    std.testing.refAllDecls(@import("cosmos/fallback_grpc.zig"));
    std.testing.refAllDecls(@import("cosmos/fallback_grpc.zig").Client);
}
