const std = @import("std");
/// Shared retained-wire quota. All Replay producers must be joined/destroyed
/// before this caller-owned object; mutex protects concurrent metadata forks.
pub const Budget = struct {
    maximum: usize = 128 * 1024 * 1024,
    used: usize = 0,
    mutex: std.Thread.Mutex = .{},
    pub fn reserve(self: *Budget, bytes: usize) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (bytes > self.maximum -| self.used) return error.ReadReplayGlobalByteBudgetExceeded;
        self.used += bytes;
    }
    pub fn release(self: *Budget, bytes: usize) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        std.debug.assert(bytes <= self.used);
        self.used -= bytes;
    }
};
