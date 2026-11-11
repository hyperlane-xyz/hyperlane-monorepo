//! `openDiagnostics(url)` from `src/diagnostics/service.ts`: a lazy read-only
//! pool (max 3) plus LISTEN connections with a 30s `SELECT 1` health check.
const std = @import("std");
const Allocator = std.mem.Allocator;
const core = @import("core");
const db = @import("db");
const js = @import("js.zig");
const service_mod = @import("service.zig");
const Service = service_mod.Service;

const LISTENER_HEALTH_MS = 30_000;
const logger = core.log.child("Diagnostics");

pub const Diagnostics = struct {
    gpa: Allocator,
    pool: *db.Pool,
    conn: db.ConnOptions,
    url: []u8,
    service: Service,

    /// No connection is made until the first query or listener.
    pub fn open(gpa: Allocator, url: []const u8) !*Diagnostics {
        const self = try gpa.create(Diagnostics);
        errdefer gpa.destroy(self);
        const own_url = try gpa.dupe(u8, url);
        errdefer gpa.free(own_url);
        const conn: db.ConnOptions = .{
            .conninfo = own_url,
            .connect_timeout_ms = 5_000,
            .query_timeout_ms = 5_000,
            .statement_timeout_ms = 4_000,
            .options = "-c default_transaction_read_only=on",
        };
        const pool = try db.Pool.init(gpa, .{
            .conn = conn,
            .max = 3,
            .on_idle_error = .{ .ctx = self, .func = onPoolError },
        });
        self.* = .{
            .gpa = gpa,
            .pool = pool,
            .conn = conn,
            .url = own_url,
            .service = .{
                .db = .{ .ctx = self, .query = query },
                .listen = .{ .ctx = self, .open = listen },
            },
        };
        return self;
    }

    /// `pool.end()` and free. Streams using `service` must be stopped first.
    pub fn close(self: *Diagnostics) void {
        self.pool.deinit();
        self.gpa.free(self.url);
        self.gpa.destroy(self);
    }

    fn onPoolError(_: *anyopaque, _: []const u8) void {
        logger.warn("Diagnostics database connection failed", .{});
    }

    fn query(ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const ?[]const u8) anyerror![]const js.Value {
        const self: *Diagnostics = @ptrCast(@alignCast(ctx));
        const values = try arena.alloc(db.Value, params.len);
        for (params, values) |param, *value| value.* = if (param) |text| .{ .string = text } else .null;
        const result = try self.pool.query(arena, sql, values, null);
        const rows = try arena.alloc(js.Value, result.rows.len);
        for (result.rows, rows) |row, *out| out.* = try js.fromCore(arena, row);
        return rows;
    }

    const Connection = struct {
        gpa: Allocator,
        handler: Service.Handler,
        listener: *db.Listener = undefined,

        fn onNotification(ctx: *anyopaque, channel: []const u8, payload: []const u8) void {
            const self: *Connection = @ptrCast(@alignCast(ctx));
            if (std.mem.eql(u8, channel, service_mod.MESSAGE_ACTIVITY_CHANNEL) and payload.len > 0)
                self.handler.notify(self.handler.ctx, payload);
        }

        fn onDisconnect(ctx: *anyopaque, _: ?[]const u8) void {
            const self: *Connection = @ptrCast(@alignCast(ctx));
            self.handler.disconnect(self.handler.ctx);
        }

        fn stop(ctx: *anyopaque) void {
            const self: *Connection = @ptrCast(@alignCast(ctx));
            self.listener.stop();
            self.gpa.destroy(self);
        }
    };

    fn listen(ctx: *anyopaque, handler: Service.Handler) anyerror!Service.Listener {
        const self: *Diagnostics = @ptrCast(@alignCast(ctx));
        const connection = try self.gpa.create(Connection);
        errdefer self.gpa.destroy(connection);
        connection.* = .{ .gpa = self.gpa, .handler = handler };
        var scratch = std.heap.ArenaAllocator.init(self.gpa);
        defer scratch.deinit();
        connection.listener = try db.Listener.start(
            self.gpa,
            self.conn,
            &.{service_mod.MESSAGE_ACTIVITY_CHANNEL},
            .{ .ctx = connection, .on_notification = Connection.onNotification, .on_disconnect = Connection.onDisconnect },
            .{ .health_check_ms = LISTENER_HEALTH_MS },
            scratch.allocator(),
            null,
        );
        return .{ .ctx = connection, .stop = Connection.stop };
    }
};
