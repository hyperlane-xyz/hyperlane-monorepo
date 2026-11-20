//! `-Dparity-hooks` builds only: the control port of parity/hooks/ts-hooks.mjs
//! (HTTP on 127.0.0.1:PARITY_HOOK_PORT, one request per connection), driving
//! `Server.hook*`. Parity scenarios use it to hold and release write callbacks
//! and to run the heartbeat on demand, identically on both runtimes.
const std = @import("std");
const live = @import("server.zig");
const protocol = @import("protocol.zig");

const Server = live.Server;

/// Starts the control thread (detached; it lives as long as the process).
pub fn start(server: *Server) !void {
    const raw = std.posix.getenv("PARITY_HOOK_PORT") orelse return error.MissingParityHookPort;
    const port = std.fmt.parseInt(u16, raw, 10) catch return error.InvalidParityHookPort;
    if (port == 0) return error.InvalidParityHookPort;
    const address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, port);
    const listener = try address.listen(.{ .reuse_address = true });
    const thread = try std.Thread.spawn(.{}, serve, .{ server, listener });
    thread.detach();
}

fn serve(server: *Server, listener_in: std.net.Server) void {
    var listener = listener_in;
    while (true) {
        const connection = listener.accept() catch continue;
        handle(server, connection.stream) catch {};
        connection.stream.close();
    }
}

fn handle(server: *Server, stream: std.net.Stream) !void {
    var buffer: [4096]u8 = undefined;
    var len: usize = 0;
    // The request head (no body is read).
    while (std.mem.indexOf(u8, buffer[0..len], "\r\n\r\n") == null) {
        if (len == buffer.len) return error.RequestTooLarge;
        const n = try stream.read(buffer[len..]);
        if (n == 0) return error.Closed;
        len += n;
    }
    const line_end = std.mem.indexOf(u8, buffer[0..len], "\r\n").?;
    var parts = std.mem.splitScalar(u8, buffer[0..line_end], ' ');
    const method = parts.next() orelse return error.BadRequest;
    const target = parts.next() orelse return error.BadRequest;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const query_at = std.mem.indexOfScalar(u8, target, '?');
    const path = target[0 .. query_at orelse target.len];
    const params = protocol.QueryParams.fromUrl(a, target) catch return error.OutOfMemory;
    const body = try respond(a, server, method, path, &params);
    var head: [160]u8 = undefined;
    const head_text = try std.fmt.bufPrint(&head, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n", .{body.len});
    try stream.writeAll(head_text);
    try stream.writeAll(body);
}

fn respond(a: std.mem.Allocator, server: *Server, method: []const u8, path: []const u8, params: *const protocol.QueryParams) ![]const u8 {
    if (std.mem.eql(u8, method, "GET") and std.mem.eql(u8, path, "/held"))
        return std.fmt.allocPrint(a, "{{\"held\":{d}}}", .{server.hookHeld()});
    if (!std.mem.eql(u8, method, "POST")) return "{\"error\":\"method\"}";
    if (std.mem.eql(u8, path, "/hold")) {
        const wanted = params.get("mode") orelse return "{\"error\":\"mode\"}";
        const mode: Server.Hooks.Mode = if (std.mem.eql(u8, wanted, "all"))
            .all
        else if (std.mem.eql(u8, wanted, "first-explorer"))
            .first_explorer
        else if (std.mem.eql(u8, wanted, "off"))
            .off
        else
            return "{\"error\":\"mode\"}";
        server.hookMode(mode);
        return std.fmt.allocPrint(a, "{{\"mode\":\"{s}\"}}", .{wanted});
    }
    if (std.mem.eql(u8, path, "/release")) {
        const result = server.hookRelease(params.get("error"));
        return std.fmt.allocPrint(a, "{{\"released\":{},\"held\":{d}}}", .{ result.released, result.held });
    }
    if (std.mem.eql(u8, path, "/release-all"))
        return std.fmt.allocPrint(a, "{{\"released\":{d},\"held\":0}}", .{server.hookReleaseAll()});
    if (std.mem.eql(u8, path, "/tick"))
        return std.fmt.allocPrint(a, "{{\"ticked\":{d}}}", .{server.hookTick()});
    return "{\"error\":\"path\"}";
}
