//! Read-only owned membership; status/retry fields are NEVER cached here.
//! The lane is the sole publisher. HTTP captures hold references, not Active
//! pointers. All live/retired rows, capacity and capture arrays charge one
//! existing role budget until their last owner releases them.
const std = @import("std");
const native = @import("../store.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);

pub const Budget = struct {
    context: *anyopaque,
    reserve_fn: *const fn (*anyopaque, usize) bool,
    release_fn: *const fn (*anyopaque, usize) void,
    fn reserve(self: Budget, bytes: usize) !void {
        if (bytes != 0 and !self.reserve_fn(self.context, bytes)) return error.ProcessorCapacityUnavailable;
    }
    fn release(self: Budget, bytes: usize) void {
        if (bytes != 0) self.release_fn(self.context, bytes);
    }
};

pub const Row = struct {
    allocator: A,
    budget: Budget,
    retained_bytes: usize,
    references: std.atomic.Value(usize) = .init(1),
    origin_index: usize,
    store: *native.Store,
    message: native.OwnedMessage,
    app_context: ?[]u8,

    fn retain(self: *Row) void {
        const old = self.references.fetchAdd(1, .monotonic);
        std.debug.assert(old > 0 and old < std.math.maxInt(usize));
    }
    pub fn release(self: *Row) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        const a = self.allocator;
        const budget = self.budget;
        const bytes = self.retained_bytes;
        self.message.deinit();
        if (self.app_context) |value| a.free(value);
        a.destroy(self);
        budget.release(bytes);
    }
};

/// Owned pointer storage, including partial constructions and HTTP captures.
pub const Rows = struct {
    allocator: A,
    budget: Budget,
    storage: []*Row,
    count: usize = 0,
    generation: u64 = 0,
    pub fn items(self: *const Rows) []*Row {
        return self.storage[0..self.count];
    }
    pub fn appendAssumeCapacity(self: *Rows, row: *Row) void {
        std.debug.assert(self.count < self.storage.len);
        self.storage[self.count] = row;
        self.count += 1;
    }
    pub fn deinit(self: *Rows) void {
        for (self.items()) |row| row.release();
        const bytes = self.storage.len * @sizeOf(*Row);
        self.allocator.free(self.storage);
        self.budget.release(bytes);
        self.* = undefined;
    }
};

pub const Admission = struct {
    ready: *const std.atomic.Value(bool),
    halted: *const std.atomic.Value(bool),
    fn allowed(self: Admission) bool {
        return self.ready.load(.acquire) and !self.halted.load(.acquire);
    }
};

pub const View = struct {
    allocator: A,
    budget: ?Budget = null,
    owner_budget: ?Budget = null,
    retained_bytes: std.atomic.Value(usize) = .init(0),
    maximum_rows: usize = 0,
    admission: ?Admission = null,
    started: bool = false,
    mutex: std.Thread.Mutex = .{},
    rows: std.ArrayList(*Row) = .empty,
    generation: u64 = 0,
    valid: bool = false,

    pub fn bind(self: *View, budget: Budget, maximum_rows: usize, admission: Admission) void {
        std.debug.assert(maximum_rows > 0 and maximum_rows <= 4096);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.budget) |previous| {
            _ = previous;
            std.debug.assert(self.owner_budget.?.context == budget.context and self.maximum_rows == maximum_rows);
            return;
        }
        self.owner_budget = budget;
        self.budget = .{ .context = self, .reserve_fn = reserve, .release_fn = release };
        self.maximum_rows = maximum_rows;
        self.admission = admission;
    }
    fn reserve(context: *anyopaque, bytes: usize) bool {
        const self: *View = @ptrCast(@alignCast(context));
        const owner = self.owner_budget.?;
        if (!owner.reserve_fn(owner.context, bytes)) return false;
        _ = self.retained_bytes.fetchAdd(bytes, .monotonic);
        return true;
    }
    fn release(context: *anyopaque, bytes: usize) void {
        const self: *View = @ptrCast(@alignCast(context));
        const old = self.retained_bytes.fetchSub(bytes, .monotonic);
        std.debug.assert(old >= bytes);
        const owner = self.owner_budget.?;
        owner.release_fn(owner.context, bytes);
    }
    pub fn retainedBytes(self: *const View) usize {
        return self.retained_bytes.load(.acquire);
    }
    pub fn published(self: *View) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.valid;
    }
    pub fn activate(self: *View) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!(self.admission orelse return error.QueueViewUnavailable).allowed()) return error.QueueViewUnavailable;
        if (!self.started) {
            self.started = true;
            self.valid = true;
        }
    }
    pub fn ensureCapacity(self: *View, required: usize) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const budget = self.budget orelse return error.QueueViewUnavailable;
        if (required > self.maximum_rows) return error.ProcessorCapacityUnavailable;
        if (required <= self.rows.capacity) return;
        const extra = try std.math.mul(usize, required - self.rows.capacity, @sizeOf(*Row));
        try budget.reserve(extra);
        errdefer budget.release(extra);
        try self.rows.ensureTotalCapacityPrecise(self.allocator, required);
        std.debug.assert(self.rows.capacity == required);
    }
    pub fn allocateRows(self: *View, count: usize) !Rows {
        const budget = self.budget orelse return error.QueueViewUnavailable;
        if (count > self.maximum_rows) return error.ProcessorCapacityUnavailable;
        const bytes = try std.math.mul(usize, count, @sizeOf(*Row));
        try budget.reserve(bytes);
        errdefer budget.release(bytes);
        return .{ .allocator = self.allocator, .budget = budget, .storage = try self.allocator.alloc(*Row, count) };
    }
    pub fn prepare(self: *View, store: *native.Store, origin_index: usize, message: protocol.Message, app_context: ?[]const u8) !*Row {
        const budget = self.budget orelse return error.QueueViewUnavailable;
        const context_bytes = if (app_context) |value| value.len else 0;
        const bytes = try std.math.add(usize, @sizeOf(Row), try std.math.add(usize, message.encodedLen(), context_bytes));
        try budget.reserve(bytes);
        errdefer budget.release(bytes);
        const encoded = try message.encodeAlloc(self.allocator);
        errdefer self.allocator.free(encoded);
        const context = if (app_context) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (context) |value| self.allocator.free(value);
        const row = try self.allocator.create(Row);
        errdefer self.allocator.destroy(row);
        row.* = .{ .allocator = self.allocator, .budget = budget, .retained_bytes = bytes, .origin_index = origin_index, .store = store, .message = .{ .allocator = self.allocator, .bytes = encoded, .value = try protocol.Message.decode(encoded) }, .app_context = context };
        return row;
    }
    /// Begin only after all fallible preparation; no view is served mid-mutation.
    pub fn invalidate(self: *View) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.generation +%= 1;
        self.valid = false;
    }
    /// Short publication transaction only: never allocate, read a Store or
    /// perform native I/O between beginPublish and finishPublish.
    pub fn beginPublish(self: *View) void {
        self.mutex.lock();
        self.generation +%= 1;
        self.valid = false;
    }
    pub fn appendLocked(self: *View, row: *Row) void {
        std.debug.assert(!self.valid);
        self.rows.appendAssumeCapacity(row);
    }
    pub fn removeLocked(self: *View, index: usize) *Row {
        std.debug.assert(!self.valid);
        return self.rows.swapRemove(index);
    }
    pub fn swapLocked(self: *View, replacement: *Rows) void {
        std.debug.assert(!self.valid and replacement.count == self.rows.items.len);
        for (self.rows.items, replacement.items()) |*old, *new| std.mem.swap(*Row, old, new);
    }
    pub fn finishPublish(self: *View) void {
        self.valid = self.started and self.budget != null;
        self.mutex.unlock();
    }
    pub fn capture(self: *View, cancel: Cancel) !Rows {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (!self.valid or !(self.admission orelse return error.QueueViewUnavailable).allowed()) return error.QueueViewUnavailable;
        var result = try self.allocateRows(self.rows.items.len);
        result.generation = self.generation;
        for (self.rows.items) |row| {
            row.retain();
            result.appendAssumeCapacity(row);
        }
        return result;
    }
    pub fn current(self: *View, generation: u64) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.valid and self.generation == generation and (self.admission orelse return false).allowed();
    }
    /// Stable allocator context survives every HTTP Response until Server.stop
    /// joins workers and frees their output. Charges construction, not merely
    /// the later HTTP response reservation; both quotas remain enforced.
    pub fn renderAllocator(self: *View) A {
        return .{ .ptr = self, .vtable = &.{ .alloc = renderAlloc, .resize = renderResize, .remap = renderRemap, .free = renderFree } };
    }
    fn renderAlloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, return_address: usize) ?[*]u8 {
        const self: *View = @ptrCast(@alignCast(context));
        const budget = self.budget orelse return null;
        budget.reserve(len) catch return null;
        const result = self.allocator.rawAlloc(len, alignment, return_address);
        if (result == null) budget.release(len);
        return result;
    }
    fn renderResize(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, new_len: usize, return_address: usize) bool {
        const self: *View = @ptrCast(@alignCast(context));
        const budget = self.budget orelse return false;
        const extra = new_len -| bytes.len;
        budget.reserve(extra) catch return false;
        if (!self.allocator.rawResize(bytes, alignment, new_len, return_address)) {
            budget.release(extra);
            return false;
        }
        if (new_len < bytes.len) budget.release(bytes.len - new_len);
        return true;
    }
    fn renderRemap(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, new_len: usize, return_address: usize) ?[*]u8 {
        const self: *View = @ptrCast(@alignCast(context));
        const budget = self.budget orelse return null;
        const extra = new_len -| bytes.len;
        budget.reserve(extra) catch return null;
        const result = self.allocator.rawRemap(bytes, alignment, new_len, return_address) orelse {
            budget.release(extra);
            return null;
        };
        if (new_len < bytes.len) budget.release(bytes.len - new_len);
        return result;
    }
    fn renderFree(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, return_address: usize) void {
        const self: *View = @ptrCast(@alignCast(context));
        self.allocator.rawFree(bytes, alignment, return_address);
        self.budget.?.release(bytes.len);
    }
    /// Only after HTTP callers AND their responses/captures have joined/freed.
    /// Row references can outlive Active retirement, NEVER this View.
    pub fn deinit(self: *View) void {
        for (self.rows.items) |row| row.release();
        if (self.budget) |budget| budget.release(self.rows.capacity * @sizeOf(*Row));
        self.rows.deinit(self.allocator);
        std.debug.assert(self.retainedBytes() == 0);
        self.* = undefined;
    }
};

const TestBudget = struct {
    used: usize = 0,
    maximum: usize = 1024 * 1024,
    fn reserve(context: *anyopaque, bytes: usize) bool {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (bytes > self.maximum - self.used) return false;
        self.used += bytes;
        return true;
    }
    fn release(context: *anyopaque, bytes: usize) void {
        const self: *@This() = @ptrCast(@alignCast(context));
        std.debug.assert(self.used >= bytes);
        self.used -= bytes;
    }
    fn interface(self: *@This()) Budget {
        return .{ .context = self, .reserve_fn = reserve, .release_fn = release };
    }
};
fn testMessage() protocol.Message {
    return .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "body" };
}

test "queue view retains retired message and charges every HTTP reference array" {
    const a = std.testing.allocator;
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var store: native.Store = undefined; // Never dereferenced by pure ownership tests.
    var view: View = .{ .allocator = a };
    view.bind(budget.interface(), 2, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    try view.ensureCapacity(2);
    const row = try view.prepare(&store, 0, testMessage(), "application");
    view.beginPublish();
    view.appendLocked(row);
    view.finishPublish();
    var cancel = std.atomic.Value(bool).init(false);
    var copy = try view.capture(&cancel);
    const charged = budget.used;
    try std.testing.expectEqual(charged, view.retainedBytes());
    view.beginPublish();
    const retired = view.removeLocked(0);
    view.finishPublish();
    retired.release();
    try std.testing.expectEqual(charged, budget.used);
    try std.testing.expectEqualStrings("body", copy.items()[0].message.value.body);
    try std.testing.expectEqualStrings("application", copy.items()[0].app_context.?);
    try std.testing.expect(!view.current(copy.generation));
    copy.deinit();
    try std.testing.expectEqual(2 * @sizeOf(*Row), budget.used);
    view.deinit();
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}

test "queue view cannot bypass startup cancellation halt or generation change" {
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(false);
    var halt = std.atomic.Value(bool).init(false);
    var cancel = std.atomic.Value(bool).init(false);
    var view: View = .{ .allocator = std.testing.allocator };
    defer view.deinit();
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try std.testing.expectError(error.QueueViewUnavailable, view.capture(&cancel));
    try std.testing.expectError(error.QueueViewUnavailable, view.activate());
    ready.store(true, .release);
    try std.testing.expectError(error.QueueViewUnavailable, view.capture(&cancel));
    try view.activate();
    var rows = try view.capture(&cancel);
    defer rows.deinit();
    try std.testing.expect(view.current(rows.generation));
    halt.store(true, .release);
    try std.testing.expectError(error.QueueViewUnavailable, view.capture(&cancel));
    try std.testing.expect(!view.current(rows.generation));
    halt.store(false, .release);
    ready.store(false, .release);
    try std.testing.expect(!view.current(rows.generation));
    ready.store(true, .release);
    view.invalidate();
    try std.testing.expectError(error.QueueViewUnavailable, view.capture(&cancel));
    view.beginPublish();
    view.finishPublish();
    try std.testing.expect(!view.current(rows.generation));
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, view.capture(&cancel));
}

test "queue view concurrent captures cannot exceed original retained byte budget" {
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var cancel = std.atomic.Value(bool).init(false);
    var store: native.Store = undefined;
    var view: View = .{ .allocator = std.testing.allocator };
    defer view.deinit();
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    try view.ensureCapacity(1);
    const prepared = try view.prepare(&store, 0, testMessage(), null);
    view.beginPublish();
    view.appendLocked(prepared);
    view.finishPublish();
    const baseline = budget.used;
    budget.maximum = baseline + 2 * @sizeOf(*Row);
    var first = try view.capture(&cancel);
    defer first.deinit();
    var second = try view.capture(&cancel);
    defer second.deinit();
    try std.testing.expectError(error.ProcessorCapacityUnavailable, view.capture(&cancel));
    try std.testing.expectEqual(budget.maximum, view.retainedBytes());
    try std.testing.expectEqual(@as(usize, 3), first.items()[0].references.load(.acquire));
}

fn allocationSweep(a: A) !void {
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var cancel = std.atomic.Value(bool).init(false);
    var store: native.Store = undefined;
    var view: View = .{ .allocator = a };
    defer {
        view.deinit();
        std.debug.assert(budget.used == 0);
    }
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    try view.ensureCapacity(1);
    const row = try view.prepare(&store, 0, testMessage(), "context");
    view.beginPublish();
    view.appendLocked(row);
    view.finishPublish();
    var rows = try view.capture(&cancel);
    defer rows.deinit();
    var replacement = try view.allocateRows(1);
    defer replacement.deinit();
    replacement.appendAssumeCapacity(try view.prepare(&store, 0, testMessage(), "replacement"));
    view.beginPublish();
    view.swapLocked(&replacement);
    view.finishPublish();
    try std.testing.expectEqualStrings("replacement", view.rows.items[0].app_context.?);
    try std.testing.expectEqualStrings("context", rows.items()[0].app_context.?);
}

test "queue view every allocation failure retires view rows captures and accounting" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

test "queue view render arena and owned response remain charged after membership retirement" {
    const http = @import("../../ops/http.zig");
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var store: native.Store = undefined;
    var view: View = .{ .allocator = std.testing.allocator };
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    try view.ensureCapacity(1);
    const prepared = try view.prepare(&store, 0, testMessage(), null);
    view.beginPublish();
    view.appendLocked(prepared);
    view.finishPublish();
    const allocator = view.renderAllocator();
    var arena = std.heap.ArenaAllocator.init(allocator);
    const scratch = try arena.allocator().alloc(u8, 4096);
    @memset(scratch, 'x');
    var response = try http.Response.init(allocator, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, "body");
    const before = budget.used;
    arena.deinit();
    try std.testing.expect(budget.used < before);
    view.beginPublish();
    const row = view.removeLocked(0);
    view.finishPublish();
    row.release();
    const response_bytes = response.storage.len + response.header_storage.len * @sizeOf(http.Header);
    try std.testing.expectEqual(@sizeOf(*Row) + response_bytes, budget.used);
    try std.testing.expectEqualStrings("body", response.body);
    // HTTP Response must release its stable View allocator BEFORE View teardown.
    response.deinit();
    try std.testing.expectEqual(@sizeOf(*Row), budget.used);
    view.deinit();
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}

fn renderAllocationSweep(a: A) !void {
    const http = @import("../../ops/http.zig");
    var budget: TestBudget = .{};
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var view: View = .{ .allocator = a };
    defer {
        view.deinit();
        std.debug.assert(budget.used == 0);
    }
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    const allocator = view.renderAllocator();
    var bytes: std.ArrayList(u8) = .empty;
    defer bytes.deinit(allocator);
    try bytes.appendNTimes(allocator, 'x', 8);
    try bytes.appendNTimes(allocator, 'y', 8192);
    try bytes.ensureTotalCapacityPrecise(allocator, 32768);
    var response = try http.Response.init(allocator, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, bytes.items);
    defer response.deinit();
    try std.testing.expectEqual(view.retainedBytes(), budget.used);
}

test "queue view render quota allocation resize remap and failures release exact ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, renderAllocationSweep, .{});
    var budget: TestBudget = .{ .maximum = 16 };
    var ready = std.atomic.Value(bool).init(true);
    var halt = std.atomic.Value(bool).init(false);
    var view: View = .{ .allocator = std.testing.allocator };
    defer view.deinit();
    view.bind(budget.interface(), 1, .{ .ready = &ready, .halted = &halt });
    try view.activate();
    const allocator = view.renderAllocator();
    const bytes = try allocator.alloc(u8, 16);
    try std.testing.expectEqual(@as(usize, 16), budget.used);
    try std.testing.expectError(error.OutOfMemory, allocator.realloc(bytes, 17));
    try std.testing.expectEqual(@as(usize, 16), budget.used);
    allocator.free(bytes);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}
