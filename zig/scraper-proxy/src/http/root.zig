//! HTTP module: Node http + Fastify 5 + @fastify/cors equivalent server and
//! a `ws`-equivalent WebSocket server. See `IMPLEMENTATION.md`.
const std = @import("std");

pub const types = @import("types.zig");
pub const server = @import("server.zig");
pub const ws = @import("ws.zig");

pub const Request = types.Request;
pub const Reply = types.Reply;
pub const Route = types.Route;
pub const Hooks = types.Hooks;
pub const Header = types.Header;
pub const Body = types.Body;
pub const FastifyError = types.FastifyError;
pub const DoneReason = types.DoneReason;
pub const Server = server.Server;
pub const Options = server.Options;
pub const UpgradeHandler = server.UpgradeHandler;
pub const UpgradeSocket = server.UpgradeSocket;
pub const metricsRoute = @import("metrics_route.zig").route;

test {
    std.testing.refAllDecls(@This());
    std.testing.refAllDeclsRecursive(types);
    std.testing.refAllDeclsRecursive(server);
    std.testing.refAllDeclsRecursive(ws);
    std.testing.refAllDeclsRecursive(@import("parse.zig"));
    _ = @import("loop.zig");
    _ = @import("tests.zig");
    _ = @import("corpus_test.zig");
    _ = @import("bench_test.zig");
}
