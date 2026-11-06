//! Serialize a whole borrowed-client operation, with cancellation while waiting.
const std = @import("std");
pub const Gate = struct {
    mutex: std.Thread.Mutex = .{},
    pub fn lock(self: *Gate, cancel: *const std.atomic.Value(bool)) !void {
        while (!self.mutex.tryLock()) {
            if (cancel.load(.acquire)) return error.RequestCancelled;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        if (cancel.load(.acquire)) {
            self.mutex.unlock();
            return error.RequestCancelled;
        }
    }
    pub fn unlock(self: *Gate) void {
        self.mutex.unlock();
    }
};
test "cancelled gate waiter cannot bind or release another operation's client" {
    const Waiter = struct {
        gate: *Gate,
        cancel: std.atomic.Value(bool) = .init(false),
        entered: std.Thread.Semaphore = .{},
        result: ?anyerror = null,
        fn run(self: *@This()) void {
            self.entered.post();
            self.gate.lock(&self.cancel) catch |err| {
                self.result = err;
                return;
            };
            self.gate.unlock();
        }
    };
    var gate: Gate = .{};
    var owner_cancel: std.atomic.Value(bool) = .init(false);
    try gate.lock(&owner_cancel);
    var waiter: Waiter = .{ .gate = &gate };
    const thread = try std.Thread.spawn(.{}, Waiter.run, .{&waiter});
    waiter.entered.wait();
    waiter.cancel.store(true, .release);
    thread.join();
    try std.testing.expectEqual(error.RequestCancelled, waiter.result.?);
    try std.testing.expect(!gate.mutex.tryLock());
    gate.unlock();
    try gate.lock(&owner_cancel);
    gate.unlock();
    owner_cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, gate.lock(&owner_cancel));
    try std.testing.expect(gate.mutex.tryLock());
    gate.mutex.unlock();
}
