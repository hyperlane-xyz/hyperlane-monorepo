//! Bounded exclusive libpq leases. Connections are lazy, deadlines include pool
//! wait/connect, and a broken or non-idle session is closed on release. The pool
//! never retries SQL: unknown COMMIT outcomes belong to durable-key recovery.
const std = @import("std");
const pg = @import("postgres.zig");
const A = std.mem.Allocator;
pub const Config = struct {
    max_connections: u8 = 5,
    connect_timeout_ms: u32 = 10000,
    acquire_timeout_ms: u32 = 15000,
    resolver: ?*@import("../net/curl.zig").Client = null,
    /// Applied once per new/reconnected session while its lease is exclusive.
    session_timeout_ms: ?u32 = null,
};
const Slot = struct {
    leased: bool = false,
    generation: u64 = 0,
    connection: ?pg.Connection = null,
    diagnostic: pg.Diagnostic = .{},
};
pub const Stats = struct { leased: usize = 0, opened: u64 = 0, discarded: u64 = 0, connect_failures: u64 = 0 };
pub const Pool = struct {
    allocator: A,
    conninfo: []u8,
    config: Config,
    slots: []Slot,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    stats: Stats = .{},
    closed: bool = false,
    /// Allocator must support concurrent calls (production uses libc/GPA with
    /// thread safety). Call deinit only after every job and lease has joined.
    pub fn init(a: A, conninfo: []const u8, config: Config) !*Pool {
        if (config.max_connections == 0 or config.max_connections > 64 or config.connect_timeout_ms == 0 or config.connect_timeout_ms > 300000 or config.acquire_timeout_ms == 0 or config.acquire_timeout_ms > 300000 or config.session_timeout_ms == 0) return error.InvalidPostgresPoolConfig;
        if (conninfo.len == 0 or conninfo.len > 65536 or std.mem.indexOfScalar(u8, conninfo, 0) != null) return error.InvalidConnectionInfo;
        const self = try a.create(Pool);
        errdefer a.destroy(self);
        const owned = try a.dupe(u8, conninfo);
        errdefer a.free(owned);
        const slots = try a.alloc(Slot, config.max_connections);
        @memset(slots, .{});
        self.* = .{ .allocator = a, .conninfo = owned, .config = config, .slots = slots };
        return self;
    }
    pub fn deinit(self: *Pool) void {
        self.mutex.lock();
        std.debug.assert(self.stats.leased == 0);
        self.closed = true;
        self.mutex.unlock();
        for (self.slots) |*slot| if (slot.connection) |*connection| connection.deinit();
        const a = self.allocator;
        a.free(self.conninfo);
        a.free(self.slots);
        a.destroy(self);
    }
    pub fn snapshot(self: *Pool) Stats {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.stats;
    }
    pub fn acquire(self: *Pool, requested: pg.IoOptions) !Lease {
        try requested.validate();
        const relative = (try pg.nowNs()) +| @as(u64, requested.timeout_ms) * std.time.ns_per_ms;
        const deadline = requested.deadline_ns orelse relative;
        const wait_deadline = @min(deadline, (try pg.nowNs()) +| @as(u64, self.config.acquire_timeout_ms) * std.time.ns_per_ms);
        var options = requested;
        options.deadline_ns = deadline;
        if (options.resolver == null) options.resolver = self.config.resolver;
        while (true) {
            try check(options, wait_deadline);
            self.mutex.lock();
            if (self.closed) {
                self.mutex.unlock();
                return error.PostgresPoolClosed;
            }
            var chosen: ?usize = null;
            for (self.slots, 0..) |slot, index| if (!slot.leased) {
                chosen = index;
                break;
            };
            if (chosen) |index| {
                const slot = &self.slots[index];
                if (slot.generation == std.math.maxInt(u64)) {
                    self.mutex.unlock();
                    return error.PostgresLeaseGenerationExhausted;
                }
                slot.leased = true;
                slot.generation += 1;
                self.stats.leased += 1;
                self.mutex.unlock();
                errdefer self.release(index, slot.generation, false);
                slot.diagnostic = .{};
                if (slot.connection) |*connection| {
                    // release ordinarily removes these; check also covers a
                    // peer disconnect observed by libpq since the last job.
                    if (!connection.reusable()) {
                        connection.deinit();
                        slot.connection = null;
                        self.mutex.lock();
                        self.stats.discarded += 1;
                        self.mutex.unlock();
                    }
                }
                if (slot.connection == null) {
                    var connect_options = options;
                    connect_options.timeout_ms = @min(options.timeout_ms, self.config.connect_timeout_ms);
                    slot.connection = pg.Connection.connectWithOptions(self.allocator, self.conninfo, &slot.diagnostic, connect_options) catch |err| {
                        self.mutex.lock();
                        self.stats.connect_failures += 1;
                        self.mutex.unlock();
                        return err;
                    };
                    slot.connection.?.io = options;
                    if (self.config.session_timeout_ms) |timeout| slot.connection.?.configureSessionTimeouts(timeout) catch |err| {
                        // Initialization failure must never expose a partially
                        // configured connection to this or a later borrower.
                        slot.connection.?.deinit();
                        slot.connection = null;
                        self.mutex.lock();
                        self.stats.discarded += 1;
                        self.mutex.unlock();
                        return err;
                    };
                    self.mutex.lock();
                    self.stats.opened += 1;
                    self.mutex.unlock();
                }
                slot.connection.?.io = options;
                try check(options, deadline);
                return .{ .pool = self, .index = index, .generation = slot.generation };
            }
            const current = pg.nowNs() catch |err| {
                self.mutex.unlock();
                return err;
            };
            const remaining = wait_deadline -| current;
            self.changed.timedWait(&self.mutex, @max(1, @min(remaining, 25 * std.time.ns_per_ms))) catch {};
            self.mutex.unlock();
        }
    }
    fn release(self: *Pool, index: usize, generation: u64, discard: bool) void {
        self.mutex.lock();
        const slot = &self.slots[index];
        if (!slot.leased or slot.generation != generation) {
            self.mutex.unlock();
            return;
        }
        // Keep leased while native close runs, outside the global mutex.
        self.mutex.unlock();
        var discarded = false;
        if (slot.connection) |*connection| {
            if (discard or !connection.reusable()) {
                connection.deinit();
                slot.connection = null;
                discarded = true;
            } else connection.io = .{}; // no borrowed job token retained idle
        }
        self.mutex.lock();
        slot.leased = false;
        self.stats.leased -= 1;
        self.stats.discarded += @intFromBool(discarded);
        self.changed.signal();
        self.mutex.unlock();
    }
};
fn check(options: pg.IoOptions, deadline: u64) !void {
    if (options.cancel) |cancel| if (cancel.load(.acquire)) return error.PostgresCancelled;
    if (try pg.nowNs() >= deadline) return error.PostgresDeadlineExceeded;
}
/// Move-only by contract: never copy a live lease or retain its connection after
/// deinit. Each worker owns its lease until all queries and result uses finish.
pub const Lease = struct {
    pool: ?*Pool,
    index: usize,
    generation: u64,
    discard: bool = false,
    pub fn connection(self: *Lease) *pg.Connection {
        return &self.pool.?.slots[self.index].connection.?;
    }
    pub fn diagnostic(self: *Lease) *pg.Diagnostic {
        return &self.pool.?.slots[self.index].diagnostic;
    }
    pub fn invalidate(self: *Lease) void {
        self.discard = true;
    }
    pub fn deinit(self: *Lease) void {
        if (self.pool) |pool| pool.release(self.index, self.generation, self.discard);
        self.pool = null;
    }
};

test "Postgres pool validates bounds and owns connection configuration without native I/O" {
    try std.testing.expectError(error.InvalidPostgresPoolConfig, Pool.init(std.testing.allocator, "host=127.0.0.1", .{ .max_connections = 0 }));
    try std.testing.expectError(error.InvalidPostgresPoolConfig, Pool.init(std.testing.allocator, "host=127.0.0.1", .{ .session_timeout_ms = 0 }));
    const pool = try Pool.init(std.testing.allocator, "host=127.0.0.1", .{});
    defer pool.deinit();
    try std.testing.expectEqualStrings("host=127.0.0.1", pool.conninfo);
    try std.testing.expectEqual(@as(usize, 0), pool.snapshot().leased);
}
