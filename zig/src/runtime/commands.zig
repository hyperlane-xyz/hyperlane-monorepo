//! Bounded commands from HTTP workers to a serialized role owner. Request and
//! response allocations belong to this queue's allocator. Timeout relinquishes
//! only the caller reference: queued/running jobs retain their own cancel token.
const std = @import("std");
const A = std.mem.Allocator;
pub fn Queue(comptime Request: type, comptime Response: type) type {
    return struct {
        const Self = @This();
        pub const Entry = struct {
            request: Request,
            cancel: std.atomic.Value(bool) = .init(false),
            state: enum { queued, running, done } = .queued,
            references: u2 = 2,
            result: ?(anyerror!Response) = null,
        };
        allocator: A,
        maximum: usize,
        drop_request: *const fn (A, *Request) void,
        drop_response: *const fn (A, *Response) void,
        mutex: std.Thread.Mutex = .{},
        changed: std.Thread.Condition = .{},
        queued: std.ArrayList(*Entry) = .empty,
        retained: usize = 0,
        closed: bool = false,
        wake: std.atomic.Value(bool) = .init(false),
        pub fn init(a: A, maximum: usize, drop_request: *const fn (A, *Request) void, drop_response: *const fn (A, *Response) void) !Self {
            if (maximum == 0 or maximum > 256) return error.InvalidCommandCapacity;
            return .{ .allocator = a, .maximum = maximum, .drop_request = drop_request, .drop_response = drop_response };
        }
        /// Consumes request on every path. Successful response transfers to the
        /// caller, which must destroy it with this queue's allocator/contract.
        pub fn call(self: *Self, request: Request, timeout_ms: u64, caller_cancel: *const std.atomic.Value(bool)) !Response {
            var owned_request = request;
            var transferred = false;
            defer if (!transferred) self.drop_request(self.allocator, &owned_request);
            if (timeout_ms == 0) return error.CommandDeadline;
            var timer = try std.time.Timer.start();
            const duration = timeout_ms *| std.time.ns_per_ms;
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.closed) return error.CommandQueueStopped;
            if (caller_cancel.load(.acquire)) return error.RequestCancelled;
            if (self.retained >= self.maximum) return error.CommandQueueFull;
            const entry = queued: {
                const value = try self.allocator.create(Entry);
                errdefer self.allocator.destroy(value);
                value.* = .{ .request = request };
                try self.queued.append(self.allocator, value);
                break :queued value;
            };
            self.retained += 1;
            transferred = true;
            self.wake.store(true, .release);
            self.changed.broadcast();
            while (entry.state != .done) {
                const elapsed = timer.read();
                const failure: ?anyerror = if (self.closed) error.CommandQueueStopped else if (caller_cancel.load(.acquire)) error.RequestCancelled else if (elapsed >= duration) error.CommandDeadline else null;
                if (failure) |err| {
                    entry.cancel.store(true, .release);
                    self.releaseLocked(entry);
                    return err;
                }
                self.changed.timedWait(&self.mutex, @min(duration - elapsed, 10 * std.time.ns_per_ms)) catch {};
            }
            const result = entry.result orelse unreachable;
            entry.result = null;
            self.releaseLocked(entry);
            return result;
        }
        pub fn take(self: *Self) ?*Entry {
            self.mutex.lock();
            defer self.mutex.unlock();
            const entry = if (self.queued.items.len > 0) self.queued.orderedRemove(0) else return null;
            entry.state = .running;
            if (self.closed) entry.cancel.store(true, .release);
            self.wake.store(self.queued.items.len > 0, .release);
            return entry;
        }
        /// Called exactly once by the owner for each take(), including cancelled
        /// commands. A detached caller never owns/destroys a running request.
        pub fn finish(self: *Self, entry: *Entry, result: anyerror!Response) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            std.debug.assert(entry.state == .running);
            entry.state = .done;
            entry.result = result;
            self.changed.broadcast();
            self.releaseLocked(entry);
        }
        fn releaseLocked(self: *Self, entry: *Entry) void {
            std.debug.assert(entry.references > 0);
            entry.references -= 1;
            if (entry.references != 0) return;
            self.drop_request(self.allocator, &entry.request);
            if (entry.result) |result| {
                if (result) |response| {
                    var owned = response;
                    self.drop_response(self.allocator, &owned);
                } else |_| {}
            }
            self.allocator.destroy(entry);
            self.retained -= 1;
        }
        pub fn close(self: *Self) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.closed = true;
            for (self.queued.items) |entry| entry.cancel.store(true, .release);
            self.changed.broadcast();
        }
        /// Call after HTTP callers and role workers join. Cancelled queued work
        /// is retired here without executing its mutation.
        pub fn deinit(self: *Self) void {
            self.close();
            while (self.take()) |entry| self.finish(entry, error.CommandQueueStopped);
            std.debug.assert(self.retained == 0);
            self.queued.deinit(self.allocator);
            self.* = undefined;
        }
    };
}
const TestRequest = struct { bytes: []u8 };
const TestResponse = struct { bytes: []u8 };
const TestQueue = Queue(TestRequest, TestResponse);
fn dropRequest(a: A, value: *TestRequest) void {
    a.free(value.bytes);
}
fn dropResponse(a: A, value: *TestResponse) void {
    a.free(value.bytes);
}
const Caller = struct {
    queue: *TestQueue,
    cancel: std.atomic.Value(bool) = .init(false),
    started: std.atomic.Value(bool) = .init(false),
    finished: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    timeout_ms: u64 = 5000,
    fn run(self: *Caller) void {
        self.started.store(true, .release);
        const bytes = self.queue.allocator.dupe(u8, "owned") catch unreachable;
        var result = self.queue.call(.{ .bytes = bytes }, self.timeout_ms, &self.cancel) catch |err| {
            self.failure = err;
            self.finished.store(true, .release);
            return;
        };
        dropResponse(self.queue.allocator, &result);
        self.finished.store(true, .release);
    }
};
test "command timeout retains running request and cancellation until actual owner retirement" {
    var queue = try TestQueue.init(std.testing.allocator, 1, dropRequest, dropResponse);
    defer queue.deinit();
    var caller: Caller = .{ .queue = &queue, .timeout_ms = 30 };
    const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    var entry: ?*TestQueue.Entry = null;
    while (entry == null) {
        entry = queue.take();
        if (entry == null) std.Thread.sleep(std.time.ns_per_ms);
    }
    while (!caller.finished.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    thread.join();
    try std.testing.expectEqual(error.CommandDeadline, caller.failure.?);
    try std.testing.expect(entry.?.cancel.load(.acquire));
    try std.testing.expectEqualStrings("owned", entry.?.request.bytes);
    try std.testing.expectEqual(@as(usize, 1), queue.retained);
    const response = try std.testing.allocator.dupe(u8, "late response");
    queue.finish(entry.?, .{ .bytes = response });
    try std.testing.expectEqual(@as(usize, 0), queue.retained);
}
test "cancelled queued command has no owner mutation and shutdown retires its owned payload" {
    var queue = try TestQueue.init(std.testing.allocator, 2, dropRequest, dropResponse);
    var caller: Caller = .{ .queue = &queue };
    const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    while (!queue.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    caller.cancel.store(true, .release);
    thread.join();
    try std.testing.expectEqual(error.RequestCancelled, caller.failure.?);
    try std.testing.expectEqual(@as(usize, 1), queue.retained);
    queue.deinit();
}
