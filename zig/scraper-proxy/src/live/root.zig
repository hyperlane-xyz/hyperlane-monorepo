//! live module: `/agents` and `/messages` WebSocket event streams.
const std = @import("std");

pub const protocol = @import("protocol.zig");
pub const runtime = @import("runtime.zig");
pub const NotificationWorker = @import("notification_worker.zig").NotificationWorker;
pub const confirmation_stream = @import("confirmation_stream.zig");
pub const event_store = @import("event_store.zig");
pub const frames = @import("frames.zig");
pub const agent_subscription = @import("agent_subscription.zig");
pub const server = @import("server.zig");
pub const EventWebSocketServer = @import("event_websocket.zig").EventWebSocketServer;

test {
    std.testing.refAllDecls(@This());
    // Analyze the main.zig entry points without building the exe.
    inline for (.{ "init", "start", "stop", "deinit", "upgradeHandler", "metricsProvider" }) |name|
        _ = &@field(EventWebSocketServer, name);
    _ = @import("protocol_test.zig");
    _ = @import("notification_worker_test.zig");
    _ = @import("confirmation_stream_test.zig");
    _ = @import("event_store_test.zig");
    _ = @import("server_test.zig");
    _ = @import("notification_queue.zig");
    _ = @import("runtime_test.zig");
    _ = @import("coalesce_test.zig");
}
