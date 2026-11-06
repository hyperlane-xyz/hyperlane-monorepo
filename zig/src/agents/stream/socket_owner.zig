//! One retained transport-only owner per scraper WebSocket. Controller, database,
//! checkpoint and signer state remain on the consuming agent worker. A wake flag
//! schedules that worker only after an owned event enters this bounded mailbox.
const std = @import("std");
const transport = @import("../../net/websocket/transport.zig");
const A = std.mem.Allocator;
pub const Config = struct {
    transport: transport.Config,
    retry_delay_ns: u64,
    wake: *std.atomic.Value(bool),
    connections: u8 = 1,
    initially_paused_mask: u8 = 0,
    max_bytes: usize = 64 * 1024 * 1024,
    max_events: usize = 1024,
    max_command_bytes: usize = 1024 * 1024,
    max_commands: usize = 16,
};
pub const Event = struct {
    lane: u8 = 0,
    generation: u64,
    kind: union(enum) { connected, text: []u8, closed, failed: anyerror },
    fn bytes(self: Event) usize {
        return if (self.kind == .text) self.kind.text.len else 0;
    }
    fn deinit(self: Event, a: A) void {
        if (self.kind == .text) a.free(self.kind.text);
    }
};
const Command = union(enum) {
    send: struct { lane: u8 = 0, generation: u64, text: []u8 },
    reconnect: struct { lane: u8 = 0, generation: u64, delay_ns: u64 },
    pause: struct { lane: u8, generation: u64 },
    fn lane(self: Command) u8 {
        return switch (self) {
            .send => |v| v.lane,
            .reconnect => |v| v.lane,
            .pause => |v| v.lane,
        };
    }
    fn generation(self: Command) u64 {
        return switch (self) {
            .send => |v| v.generation,
            .reconnect => |v| v.generation,
            .pause => |v| v.generation,
        };
    }
    fn bytes(self: Command) usize {
        return if (self == .send) self.send.text.len else 0;
    }
    fn deinit(self: Command, a: A) void {
        if (self == .send) a.free(self.send.text);
    }
};
pub const Snapshot = struct { queued_bytes: usize, retained_events: usize, command_bytes: usize, generation: u64, thread_started: bool, connections: u8 };
pub const Owner = struct {
    allocator: A,
    url: []u8,
    config: Config,
    thread: ?std.Thread = null,
    stop: std.atomic.Value(bool) = .init(false),
    generation: std.atomic.Value(u64) = .init(0),
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    events: std.ArrayList(Event) = .empty,
    head: usize = 0,
    retained_events: usize = 0,
    retained_bytes: usize = 0,
    commands: std.ArrayList(Command) = .empty,
    command_bytes: usize = 0,
    retained_commands: usize = 0,
    /// Allocation only. Allocator and wake flag must remain thread-safe/live
    /// until the consumer joins and releases every taken event before deinit.
    pub fn init(a: A, url: []const u8, config: Config) !*Owner {
        if (config.initially_paused_mask > 3 or (config.connections == 1 and config.initially_paused_mask > 1) or config.connections == 0 or config.connections > 2 or config.retry_delay_ns == 0 or config.max_bytes == 0 or config.max_events == 0 or config.max_events > 1024 or config.max_command_bytes == 0 or config.max_commands == 0 or config.max_commands > 16) return error.InvalidSocketOwnerConfig;
        if (!std.mem.startsWith(u8, url, "ws://") and !std.mem.startsWith(u8, url, "wss://")) return error.InvalidWebSocketUrl;
        const self = try a.create(Owner);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .url = try a.dupe(u8, url), .config = config };
        errdefer a.free(self.url);
        try self.events.ensureTotalCapacityPrecise(a, config.max_events);
        errdefer self.events.deinit(a);
        try self.commands.ensureTotalCapacityPrecise(a, config.max_commands);
        return self;
    }
    /// Start inside an agent I/O worker, never on the scheduling/signal owner.
    /// One fixed1MiB stack is retained, with no per-message/request threads.
    pub fn start(self: *Owner) !void {
        if (self.thread != null) return;
        if (self.stop.load(.acquire)) return error.SocketOwnerStopped;
        self.thread = try std.Thread.spawn(.{ .stack_size = 1024 * 1024 }, run, .{self});
    }
    pub fn requestStop(self: *Owner) void {
        self.stop.store(true, .release);
        self.mutex.lock();
        self.changed.broadcast();
        self.mutex.unlock();
    }
    pub fn deinit(self: *Owner) void {
        self.requestStop();
        if (self.thread) |thread| thread.join();
        for (self.events.items[self.head..]) |event| event.deinit(self.allocator);
        for (self.commands.items) |command| command.deinit(self.allocator);
        self.events.deinit(self.allocator);
        self.commands.deinit(self.allocator);
        self.allocator.free(self.url);
        self.allocator.destroy(self);
    }
    pub fn take(self: *Owner) ?Event {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.head == self.events.items.len) return null;
        const event = self.events.items[self.head];
        self.head += 1;
        return event;
    }
    pub fn release(self: *Owner, event: Event) void {
        event.deinit(self.allocator);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.retained_bytes -= event.bytes();
        self.retained_events -= 1;
        self.changed.broadcast();
    }
    pub fn snapshot(self: *Owner) Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .queued_bytes = self.retained_bytes, .retained_events = self.retained_events, .command_bytes = self.command_bytes, .generation = self.generation.load(.acquire), .thread_started = self.thread != null, .connections = self.config.connections };
    }
    pub fn sendText(self: *Owner, generation: u64, text: []const u8) !void {
        return self.sendTextFor(0, generation, text);
    }
    pub fn sendTextFor(self: *Owner, lane: u8, generation: u64, text: []const u8) !void {
        if (lane >= self.config.connections) return error.InvalidSocketLane;
        if (text.len > self.config.max_command_bytes) return error.StreamCommandTooLarge;
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.commandCapacity(text.len);
        const owned = try self.allocator.dupe(u8, text);
        self.commands.appendAssumeCapacity(.{ .send = .{ .lane = lane, .generation = generation, .text = owned } });
        self.command_bytes += owned.len;
        self.retained_commands += 1;
        self.changed.signal();
    }
    pub fn reconnect(self: *Owner, generation: u64, delay_ns: u64) !void {
        return self.reconnectFor(0, generation, delay_ns);
    }
    pub fn reconnectFor(self: *Owner, lane: u8, generation: u64, delay_ns: u64) !void {
        if (lane >= self.config.connections) return error.InvalidSocketLane;
        try self.enqueueCommand(.{ .reconnect = .{ .lane = lane, .generation = generation, .delay_ns = delay_ns } });
    }
    pub fn suspendFor(self: *Owner, lane: u8, generation: u64) !void {
        if (lane >= self.config.connections) return error.InvalidSocketLane;
        try self.enqueueCommand(.{ .pause = .{ .lane = lane, .generation = generation } });
    }
    fn commandCapacity(self: *Owner, bytes: usize) !void {
        if (self.stop.load(.acquire)) return error.SocketOwnerStopped;
        if (self.retained_commands >= self.config.max_commands or bytes > self.config.max_command_bytes - self.command_bytes) return error.StreamCommandQueueFull;
    }
    fn enqueueCommand(self: *Owner, command: Command) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.commandCapacity(command.bytes());
        self.commands.appendAssumeCapacity(command);
        self.command_bytes += command.bytes();
        self.retained_commands += 1;
        self.changed.signal();
    }
    fn takeCommand(self: *Owner) ?Command {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.commands.items.len == 0) return null;
        return self.commands.orderedRemove(0);
    }
    fn releaseCommand(self: *Owner, command: Command) void {
        command.deinit(self.allocator);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.command_bytes -= command.bytes();
        self.retained_commands -= 1;
    }
    fn publish(self: *Owner, generation: u64, kind: transport.Event.Kind) !void {
        return self.publishFor(0, generation, kind);
    }
    fn publishFor(self: *Owner, lane: u8, generation: u64, kind: transport.Event.Kind) !void {
        const bytes = if (kind == .text) kind.text.len else 0;
        if (bytes > self.config.max_bytes) return error.StreamMailboxMessageTooLarge;
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.retained_events >= self.config.max_events or bytes > self.config.max_bytes - self.retained_bytes) {
            if (self.stop.load(.acquire)) return error.SocketOwnerStopped;
            self.changed.timedWait(&self.mutex, 200 * std.time.ns_per_ms) catch {};
        }
        if (self.stop.load(.acquire)) return error.SocketOwnerStopped;
        // Check aggregate capacity before allocating the copy. The borrowed
        // transport message is separate from this mailbox's bounded ownership.
        const event: Event = .{ .lane = lane, .generation = generation, .kind = switch (kind) {
            .connected => .connected,
            .closed => .closed,
            .failed => |err| .{ .failed = err },
            .text => |text| .{ .text = try self.allocator.dupe(u8, text) },
        } };
        if (self.events.items.len == self.config.max_events and self.head > 0) {
            const remaining = self.events.items.len - self.head;
            std.mem.copyForwards(Event, self.events.items[0..remaining], self.events.items[self.head..]);
            self.events.items.len = remaining;
            self.head = 0;
        }
        self.events.appendAssumeCapacity(event);
        self.retained_events += 1;
        self.retained_bytes += bytes;
        self.config.wake.store(true, .release);
    }
    fn commandsPending(self: *Owner) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.commands.items.len > 0;
    }
    fn retryWait(self: *Owner, deadline: u64, timer: *std.time.Timer) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.stop.load(.acquire) and self.commands.items.len == 0 and timer.read() < deadline) {
            const remaining = deadline -| timer.read();
            self.changed.timedWait(&self.mutex, @min(remaining, 200 * std.time.ns_per_ms)) catch {};
        }
    }
    fn run(self: *Owner) void {
        var timer = std.time.Timer.start() catch |err| {
            self.publish(0, .{ .failed = err }) catch {};
            return;
        };
        var config = self.config.transport;
        config.cancel = &self.stop;
        const Slot = struct { client: ?transport.Client = null, active: bool = false, due: u64 = 0, generation: u64 = 0, suspended: bool = false };
        var slots: [2]Slot = .{ .{}, .{} };
        for (slots[0..self.config.connections], 0..) |*slot, lane| slot.suspended = self.config.initially_paused_mask & (@as(u8, 1) << @intCast(lane)) != 0;
        defer for (&slots) |*slot| if (slot.client) |*client| client.deinit();
        var next: usize = 0;
        while (!self.stop.load(.acquire)) {
            while (self.takeCommand()) |command| {
                defer self.releaseCommand(command);
                const slot = &slots[command.lane()];
                if (command.generation() != slot.generation) continue;
                switch (command) {
                    .send => |send| if (slot.active) {
                        slot.client.?.sendText(send.text) catch |err| {
                            self.publishFor(command.lane(), slot.generation, .{ .failed = err }) catch {};
                            slot.client.?.disconnect();
                            slot.active = false;
                            slot.due = std.math.maxInt(u64);
                        };
                    },
                    .reconnect => |request| {
                        const requested = timer.read() +| request.delay_ns;
                        slot.due = if (slot.active or slot.due == std.math.maxInt(u64)) requested else @max(slot.due, requested);
                        if (slot.client) |*client| client.disconnect();
                        slot.active = false;
                        slot.suspended = false;
                    },
                    .pause => {
                        if (slot.client) |*client| client.disconnect();
                        slot.active = false;
                        slot.suspended = true;
                        slot.due = std.math.maxInt(u64);
                    },
                }
            }
            for (0..self.config.connections) |offset| {
                const lane: u8 = @intCast((next + offset) % self.config.connections);
                const slot = &slots[lane];
                if (!slot.active and !slot.suspended and timer.read() >= slot.due) {
                    if (slot.client == null) slot.client = transport.Client.init(self.allocator, config) catch |err| {
                        self.publishFor(lane, slot.generation, .{ .failed = err }) catch {};
                        // Setup may fail before Client allocates a new generation.
                        // There is then no new-generation terminal for the consumer
                        // to retire. Keep a bounded normal reconnect deadline.
                        slot.due = timer.read() +| self.config.retry_delay_ns;
                        continue;
                    };
                    slot.client.?.connect(self.url) catch |err| {
                        self.publishFor(lane, slot.generation, .{ .failed = err }) catch {};
                        slot.client.?.disconnect();
                        slot.due = timer.read() +| self.config.retry_delay_ns;
                        continue;
                    };
                    slot.generation = slot.client.?.generation;
                    if (lane == 0) self.generation.store(slot.generation, .release);
                    slot.active = true;
                }
                if (!slot.active) continue;
                var received: usize = 0;
                while (received < 64 and !self.stop.load(.acquire)) : (received += 1) {
                    const event = slot.client.?.poll() catch |err| {
                        self.publishFor(lane, slot.generation, .{ .failed = err }) catch {};
                        slot.client.?.disconnect();
                        slot.active = false;
                        slot.due = std.math.maxInt(u64);
                        break;
                    } orelse break;
                    self.publishFor(lane, event.generation, event.kind) catch |err| {
                        if (err == error.SocketOwnerStopped) return;
                        self.publishFor(lane, event.generation, .{ .failed = err }) catch {};
                        slot.client.?.disconnect();
                        slot.active = false;
                        slot.due = std.math.maxInt(u64);
                        break;
                    };
                    if (event.kind == .closed or event.kind == .failed) {
                        slot.client.?.disconnect();
                        slot.active = false;
                        slot.due = std.math.maxInt(u64);
                        break;
                    }
                }
            }
            var waiting = false;
            for (0..self.config.connections) |offset| {
                const lane = (next + offset) % self.config.connections;
                const slot = &slots[lane];
                if (!slot.active) continue;
                slot.client.?.wait(200, &self.stop) catch |err| {
                    self.publishFor(@intCast(lane), slot.generation, .{ .failed = err }) catch {};
                    slot.client.?.disconnect();
                    slot.active = false;
                    slot.due = std.math.maxInt(u64);
                };
                waiting = true;
                break;
            }
            next = (next + 1) % self.config.connections;
            if (!waiting) {
                var due: u64 = std.math.maxInt(u64);
                for (slots[0..self.config.connections]) |slot| if (!slot.active and !slot.suspended) {
                    due = @min(due, slot.due);
                };
                self.retryWait(due, &timer);
            }
        }
    }
};

test "socket mailbox owns copied text counts borrowed bytes and backpressures before extra allocation" {
    const a = std.testing.allocator;
    var wake: std.atomic.Value(bool) = .init(false);
    const owner = try Owner.init(a, "ws://127.0.0.1:1", .{ .transport = .{ .library_path = "/no-library-constructor-only" }, .retry_delay_ns = 1, .wake = &wake, .max_bytes = 4, .max_events = 2 });
    defer owner.deinit();
    try std.testing.expect(!owner.snapshot().thread_started);
    var text: [4]u8 = .{ 'a', 'b', 'c', 'd' };
    try owner.publish(1, .connected);
    try owner.publish(1, .{ .text = &text });
    text[0] = 'z';
    owner.release(owner.take().?);
    const borrowed = owner.take().?;
    var released = false;
    defer if (!released) owner.release(borrowed);
    try std.testing.expectEqualStrings("abcd", borrowed.kind.text);
    try std.testing.expectEqual(@as(usize, 4), owner.snapshot().queued_bytes);
    try std.testing.expect(wake.load(.acquire));
    const Producer = struct {
        owner: *Owner,
        entered: std.Thread.Semaphore = .{},
        done: std.atomic.Value(bool) = .init(false),
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.entered.post();
            self.owner.publish(2, .{ .text = "e" }) catch |err| {
                self.failure = err;
            };
            self.done.store(true, .release);
        }
    };
    var producer: Producer = .{ .owner = owner };
    const thread = try std.Thread.spawn(.{}, Producer.run, .{&producer});
    var joined = false;
    defer if (!joined) {
        owner.requestStop();
        thread.join();
    };
    producer.entered.wait();
    std.Thread.sleep(10 * std.time.ns_per_ms);
    try std.testing.expect(!producer.done.load(.acquire));
    try std.testing.expectEqual(@as(usize, 4), owner.snapshot().queued_bytes);
    owner.release(borrowed);
    released = true;
    thread.join();
    joined = true;
    try std.testing.expect(producer.failure == null);
    const event = owner.take().?;
    try std.testing.expectEqual(@as(u64, 2), event.generation);
    try std.testing.expectEqualStrings("e", event.kind.text);
    owner.release(event);
    try std.testing.expectEqual(@as(usize, 0), owner.snapshot().retained_events);
    try std.testing.expectError(error.StreamMailboxMessageTooLarge, owner.publish(2, .{ .text = "oversized" }));
}
test "outbound command cap includes active owned command and stop rejects new effects" {
    var wake: std.atomic.Value(bool) = .init(false);
    const owner = try Owner.init(std.testing.allocator, "ws://127.0.0.1:1", .{ .transport = .{ .library_path = "/no-library-constructor-only" }, .retry_delay_ns = 1, .wake = &wake, .max_command_bytes = 4, .max_commands = 2 });
    defer owner.deinit();
    try owner.sendText(1, "1234");
    const command = owner.takeCommand().?;
    try std.testing.expectError(error.StreamCommandQueueFull, owner.sendText(1, "5"));
    owner.releaseCommand(command);
    try owner.reconnect(1, 10);
    try owner.reconnect(1, 20);
    try std.testing.expectError(error.StreamCommandQueueFull, owner.reconnect(1, 30));
    owner.requestStop();
    try std.testing.expectError(error.SocketOwnerStopped, owner.sendText(1, "1"));
}
test "socket owner every allocation failure frees constructor mailbox and pending command ownership" {
    const Fixture = struct {
        fn run(a: A) !void {
            var wake: std.atomic.Value(bool) = .init(false);
            const owner = try Owner.init(a, "wss://localhost:1", .{ .transport = .{ .library_path = "/no-library-constructor-only" }, .retry_delay_ns = 1, .wake = &wake });
            defer owner.deinit();
            try owner.publish(1, .{ .text = "owned event" });
            try owner.sendText(1, "owned command");
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Fixture.run, .{});
}
