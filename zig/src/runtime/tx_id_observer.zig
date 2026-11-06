//! Canonical dispatch notification only. It neither admits public messages nor
//! changes cursor/authority state; the bounded consumer owns all subsequent I/O.
pub const Notification = struct { transaction: [64]u8, block_number: u64 };
pub const Observer = struct {
    context: *anyopaque,
    notify_fn: *const fn (*anyopaque, Notification) anyerror!void,
    pub fn notify(self: Observer, value: Notification) !void {
        try self.notify_fn(self.context, value);
    }
};
