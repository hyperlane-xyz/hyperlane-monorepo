//! Bounded concurrent checkpoint reads. Each metadata request owns an arrival
//! queue; the first valid root to reach threshold wins. Storage callbacks run
//! without owner locks and must honor cancellation/deadlines. No signer here.
const std = @import("std");
const objects = @import("../storage/objects.zig");
const quorum = @import("quorum.zig");
const io = @import("../runtime/io_pool.zig");
const Allocator = std.mem.Allocator;
pub const Address = [20]u8;
pub const Reader = struct {
    origin: u32 = 0,
    validator: Address,
    location_id: [32]u8 = @splat(0),
    context: *anyopaque,
    retain: ?*const fn (*anyopaque) void = null,
    release: ?*const fn (*anyopaque) void = null,
    validate: ?*const fn (*anyopaque, *const std.atomic.Value(bool)) anyerror!void = null,
    ignore_reorg_reports: bool = false,
    fetch: *const fn (*anyopaque, u32, *const std.atomic.Value(bool)) anyerror!?objects.SignedCheckpoint,
    latest: *const fn (*anyopaque, *const std.atomic.Value(bool)) anyerror!?u32,
};
pub const Clock = struct { context: *anyopaque, now_ms: *const fn (*anyopaque) u64 };
const Kind = enum { checkpoint, latest, guard };
const Value = union(Kind) { checkpoint: ?objects.SignedCheckpoint, latest: ?u32, guard: bool };
const Arrival = struct { validator_index: usize, result: anyerror!Value };
const Job = struct {
    allocator: Allocator,
    references: std.atomic.Value(usize) = .init(1),
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    closed: bool = false,
    queue: [256]Arrival = undefined,
    length: usize = 0,
    consumed: usize = 0,

    fn create(allocator: Allocator) !*Job {
        const self = try allocator.create(Job);
        self.* = .{ .allocator = allocator };
        return self;
    }
    fn retain(self: *Job) void {
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(self: *Job) void {
        if (self.references.fetchSub(1, .acq_rel) == 1) self.allocator.destroy(self);
    }
    fn push(self: *Job, result: Arrival) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.closed) return;
        std.debug.assert(self.length < self.queue.len);
        self.queue[self.length] = result;
        self.length += 1;
        self.wake.signal();
    }
};
const Input = struct { job: *Job, kind: Kind, index: u32, validator_index: usize, reader: Reader };
const Workers = io.Pool(Input, void, ReaderPool, 8, 512);

pub const ReaderPool = struct {
    allocator: Allocator,
    readers: []Reader,
    readers_len: usize = 0,
    reader_mutex: std.Thread.Mutex = .{},
    reader_touched: [4096]u64 = @splat(0),
    reader_sequence: u64 = 0,
    workers: *Workers,
    started: std.time.Instant,
    clock: ?Clock,
    timeout_ms: u64,

    /// Allocator must support concurrent allocation. Reader contexts are stable
    /// and borrowed until every metadata caller and worker has joined.
    pub fn start(allocator: Allocator, readers: []const Reader, timeout_ms: u64, clock: ?Clock) !*ReaderPool {
        if (timeout_ms == 0 or timeout_ms > 300000 or readers.len > 4096) return error.InvalidCheckpointPool;
        for (readers, 0..) |reader, i| for (readers[0..i]) |previous| {
            if (reader.origin == previous.origin and std.mem.eql(u8, &reader.validator, &previous.validator)) return error.DuplicateCheckpointReader;
        };
        const self = try allocator.create(ReaderPool);
        errdefer allocator.destroy(self);
        const owned = try allocator.alloc(Reader, 4096);
        errdefer allocator.free(owned);
        self.* = .{ .allocator = allocator, .readers = owned, .workers = undefined, .started = try std.time.Instant.now(), .timeout_ms = timeout_ms, .clock = clock };
        self.workers = try Workers.start(allocator, self, run, freeInput, freeOutput);
        for (readers) |reader| self.register(reader);
        return self;
    }

    /// All calls to fetchQuorum/latestIndices must have returned before deinit.
    pub fn deinit(self: *ReaderPool) void {
        self.workers.deinit();
        for (self.readers[0..self.readers_len]) |reader| releaseReader(reader);
        self.allocator.free(self.readers);
        const allocator = self.allocator;
        allocator.destroy(self);
    }

    fn now(self: *ReaderPool) !u64 {
        if (self.clock) |clock| return clock.now_ms(clock.context);
        return (try std.time.Instant.now()).since(self.started) / std.time.ns_per_ms;
    }

    fn retainReader(reader: Reader) void {
        if (reader.retain) |retain| retain(reader.context);
    }
    fn releaseReader(reader: Reader) void {
        if (reader.release) |release_| release_(reader.context);
    }

    /// One retained registration per (origin, validator). Replacement drops only
    /// the registry reference: in-flight requests keep their previous reader
    /// alive until their callbacks return. Capacity eviction is similarly safe.
    pub fn register(self: *ReaderPool, reader: Reader) void {
        retainReader(reader);
        self.reader_mutex.lock();
        var selected: ?usize = null;
        for (self.readers[0..self.readers_len], 0..) |previous, i| {
            if (previous.origin == reader.origin and std.mem.eql(u8, &previous.validator, &reader.validator)) {
                selected = i;
                break;
            }
        }
        var old: ?Reader = null;
        const index = selected orelse if (self.readers_len < self.readers.len) append: {
            const index = self.readers_len;
            self.readers_len += 1;
            break :append index;
        } else evict: {
            var index: usize = 0;
            for (self.reader_touched[0..self.readers_len], 0..) |touched, i| if (touched < self.reader_touched[index]) {
                index = i;
            };
            old = self.readers[index];
            break :evict index;
        };
        if (selected != null) old = self.readers[index];
        self.readers[index] = reader;
        self.reader_sequence +|= 1;
        self.reader_touched[index] = self.reader_sequence;
        self.reader_mutex.unlock();
        if (old) |previous| releaseReader(previous);
    }

    pub fn hasReader(self: *ReaderPool, origin: u32, validator: Address) bool {
        self.reader_mutex.lock();
        defer self.reader_mutex.unlock();
        for (self.readers[0..self.readers_len]) |reader| if (reader.origin == origin and std.mem.eql(u8, &reader.validator, &validator)) return true;
        return false;
    }

    fn lookup(self: *ReaderPool, origin: u32, validator: Address) ?Reader {
        self.reader_mutex.lock();
        defer self.reader_mutex.unlock();
        for (self.readers[0..self.readers_len], 0..) |reader, i| {
            if (reader.origin != origin or !std.mem.eql(u8, &reader.validator, &validator)) continue;
            retainReader(reader);
            self.reader_sequence +|= 1;
            self.reader_touched[i] = self.reader_sequence;
            return reader;
        }
        return null;
    }

    fn run(_: *ReaderPool, input: Input, cancel: *const std.atomic.Value(bool)) !void {
        const reader = input.reader;
        const result: anyerror!Value = value: {
            if (cancel.load(.acquire)) break :value error.RequestCancelled;
            break :value switch (input.kind) {
                .checkpoint => .{ .checkpoint = reader.fetch(reader.context, input.index, cancel) catch |err| break :value err },
                .latest => .{ .latest = reader.latest(reader.context, cancel) catch |err| break :value err },
                .guard => guarded: {
                    if (reader.validate) |validate| validate(reader.context, cancel) catch |err| break :value err;
                    break :guarded .{ .guard = true };
                },
            };
        };
        input.job.push(.{ .validator_index = input.validator_index, .result = result });
    }
    fn freeInput(_: *ReaderPool, input: Input) void {
        input.job.release();
        releaseReader(input.reader);
    }
    fn freeOutput(_: *ReaderPool, _: void) void {}

    fn drain(self: *ReaderPool, now_ms: u64) void {
        // Results already reside in their request's arrival queue. Native pool
        // completions only release slots; any concurrent caller may drain them.
        while (self.workers.poll(now_ms)) |_| {}
    }

    const Request = struct {
        job: *Job,
        ids: [256]?Workers.JobId = @splat(null),
        deadline_ms: u64,
        count: usize,
        snapshots: [256]?Reader = @splat(null),
    };

    fn submit(self: *ReaderPool, origin: u32, validators: []const Address, index: u32, kind: Kind, snapshots: ?[]const ?Reader, allowed: ?[]const bool) !Request {
        if (validators.len > 256) return error.InvalidValidatorCount;
        if ((snapshots != null and snapshots.?.len != validators.len) or (allowed != null and allowed.?.len != validators.len)) return error.InvalidReaderSnapshot;
        const now_ms = try self.now();
        self.drain(now_ms);
        var request: Request = .{ .job = try Job.create(self.allocator), .deadline_ms = now_ms +| self.timeout_ms, .count = validators.len };
        errdefer self.finish(&request);
        for (validators, 0..) |validator, validator_index| {
            const selected: ?Reader = selected: {
                if (allowed) |mask| if (!mask[validator_index]) break :selected null;
                if (snapshots) |saved| {
                    if (saved[validator_index]) |reader| {
                        retainReader(reader);
                        break :selected reader;
                    }
                    break :selected null;
                }
                break :selected self.lookup(origin, validator);
            };
            if (selected) |reader| {
                request.snapshots[validator_index] = reader;
                retainReader(reader);
                request.job.retain();
                request.ids[validator_index] = self.workers.submit(.{ .job = request.job, .kind = kind, .index = index, .validator_index = validator_index, .reader = reader }, now_ms, request.deadline_ms) catch |err| {
                    request.job.release();
                    releaseReader(reader);
                    return err;
                };
            } else request.job.push(.{ .validator_index = validator_index, .result = switch (kind) {
                .checkpoint => .{ .checkpoint = null },
                .latest => .{ .latest = null },
                .guard => .{ .guard = false },
            } });
        }
        return request;
    }

    fn finish(self: *ReaderPool, request: *Request) void {
        request.job.mutex.lock();
        request.job.closed = true;
        request.job.mutex.unlock();
        for (request.ids[0..request.count]) |maybe| if (maybe) |id| {
            _ = self.workers.cancel(id) catch {};
        };
        for (request.snapshots[0..request.count]) |maybe| if (maybe) |reader| releaseReader(reader);
        request.job.release();
    }

    fn collectGuards(self: *ReaderPool, request: *Request, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) ![256]bool {
        var allowed: [256]bool = @splat(false);
        for (0..request.count) |received| {
            const arrival = self.next(request, cancel) catch |err| {
                if (err != error.CheckpointReadTimeout) return err;
                storage_errors.* += request.count - received;
                return allowed;
            };
            const value = arrival.result catch |err| {
                if (err == error.OutOfMemory) return err;
                if (err == error.ValidatorReorg and !request.snapshots[arrival.validator_index].?.ignore_reorg_reports) return err;
                storage_errors.* += 1;
                continue;
            };
            allowed[arrival.validator_index] = value.guard;
        }
        return allowed;
    }

    fn next(self: *ReaderPool, request: *Request, cancel: ?*const std.atomic.Value(bool)) !Arrival {
        while (true) {
            if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            const now_ms = try self.now();
            self.drain(now_ms);
            request.job.mutex.lock();
            if (now_ms >= request.deadline_ms) {
                request.job.mutex.unlock();
                return error.CheckpointReadTimeout;
            }
            if (request.job.consumed < request.job.length) {
                const arrival = request.job.queue[request.job.consumed];
                request.job.consumed += 1;
                request.job.mutex.unlock();
                return arrival;
            }
            request.job.wake.timedWait(&request.job.mutex, @as(u64, @min(25, request.deadline_ms - now_ms)) * std.time.ns_per_ms) catch {};
            request.job.mutex.unlock();
        }
    }

    pub fn fetchQuorum(self: *ReaderPool, origin: u32, allocator: Allocator, validators: []const Address, threshold: usize, index: u32, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) !?quorum.Quorum {
        var collector = try quorum.Collector.init(allocator, validators, threshold, index, .standard);
        // A reorg flag at ANY selected backend aborts the whole build. Check
        // every peer before early quorum; retain the exact checked locations
        // across phases even if registrations rotate concurrently.
        var guards = try self.submit(origin, validators, 0, .guard, null, null);
        defer self.finish(&guards);
        const allowed = try self.collectGuards(&guards, storage_errors, cancel);
        var request = try self.submit(origin, validators, index, .checkpoint, guards.snapshots[0..validators.len], allowed[0..validators.len]);
        defer self.finish(&request);
        for (0..validators.len) |received| {
            const arrival = self.next(&request, cancel) catch |err| {
                if (err != error.CheckpointReadTimeout) return err;
                storage_errors.* += validators.len - received;
                return null;
            };
            const value = arrival.result catch |err| {
                if (err == error.OutOfMemory or (err == error.ValidatorReorg and !request.snapshots[arrival.validator_index].?.ignore_reorg_reports)) return err;
                storage_errors.* += 1;
                continue;
            };
            if (value.checkpoint) |signed| if (try collector.push(.{ .validator_index = arrival.validator_index, .signed = signed })) |result| return result;
        }
        return null;
    }

    pub fn latestIndices(self: *ReaderPool, origin: u32, validators: []const Address, output: []?u32, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) !void {
        if (output.len != validators.len) return error.InvalidLatestIndicesLength;
        @memset(output, null);
        var guards = try self.submit(origin, validators, 0, .guard, null, null);
        defer self.finish(&guards);
        const allowed = try self.collectGuards(&guards, storage_errors, cancel);
        var request = try self.submit(origin, validators, 0, .latest, guards.snapshots[0..validators.len], allowed[0..validators.len]);
        defer self.finish(&request);
        for (0..validators.len) |received| {
            const arrival = self.next(&request, cancel) catch |err| {
                if (err != error.CheckpointReadTimeout) return err;
                storage_errors.* += validators.len - received;
                return;
            };
            const value = arrival.result catch |err| {
                if (err == error.OutOfMemory or (err == error.ValidatorReorg and !request.snapshots[arrival.validator_index].?.ignore_reorg_reports)) return err;
                storage_errors.* += 1;
                continue;
            };
            output[arrival.validator_index] = value.latest;
        }
    }
};

const TestReader = struct {
    signed: objects.SignedCheckpoint,
    mode: enum { ready, wait_for_cancel, failure } = .ready,
    latest_index: u32 = 0,
    flagged: bool = false,
    guard_delay_ms: u64 = 0,
    swap_pool: ?*ReaderPool = null,
    replacement: ?Reader = null,
    retained: std.atomic.Value(usize) = .init(0),
    released: std.atomic.Value(usize) = .init(0),
    fn interface(self: *TestReader) !Reader {
        return .{ .validator = try self.signed.recover(), .context = self, .fetch = fetch, .latest = latest, .validate = validate, .retain = retain, .release = release };
    }
    fn retain(context: *anyopaque) void {
        const self: *TestReader = @ptrCast(@alignCast(context));
        _ = self.retained.fetchAdd(1, .acq_rel);
    }
    fn release(context: *anyopaque) void {
        const self: *TestReader = @ptrCast(@alignCast(context));
        _ = self.released.fetchAdd(1, .acq_rel);
    }
    fn validate(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *TestReader = @ptrCast(@alignCast(context));
        if (self.guard_delay_ms > 0) std.Thread.sleep(self.guard_delay_ms * std.time.ns_per_ms);
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.swap_pool) |pool| {
            pool.register(self.replacement.?);
            self.swap_pool = null;
        }
        if (self.flagged) return error.ValidatorReorg;
    }
    fn fetch(context: *anyopaque, _: u32, cancel: *const std.atomic.Value(bool)) !?objects.SignedCheckpoint {
        const self: *TestReader = @ptrCast(@alignCast(context));
        if (self.mode == .failure) return error.MockStorageUnavailable;
        if (self.mode == .wait_for_cancel) {
            var timer = try std.time.Timer.start();
            while (!cancel.load(.acquire)) {
                if (timer.read() > 5 * std.time.ns_per_s) return error.MockStorageNotCancelled;
                std.Thread.sleep(100 * std.time.ns_per_us);
            }
            return error.RequestCancelled;
        }
        return self.signed;
    }
    fn latest(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !?u32 {
        const self: *TestReader = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.mode == .failure) return error.MockStorageUnavailable;
        return self.latest_index;
    }
};

fn checkpoint() @import("../protocol/root.zig").Checkpoint {
    return .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(1), .root = @splat(2), .index = 3, .message_id = @splat(4) };
}

test "parallel checkpoint quorum returns first root without waiting for slow configured validators" {
    const allocator = std.testing.allocator;
    var sources: [4]TestReader = undefined;
    var readers: [4]Reader = undefined;
    var validators: [4]Address = undefined;
    for (&sources, &readers, &validators, 0..) |*source, *reader, *validator, i| {
        var value = checkpoint();
        if (i < 2) value.root = @splat(9);
        source.* = .{ .signed = try objects.SignedCheckpoint.sign(value, @splat(@as(u8, @intCast(0x11 + i))), null), .mode = if (i < 2) .wait_for_cancel else .ready };
        reader.* = try source.interface();
        validator.* = reader.validator;
    }
    const pool = try ReaderPool.start(allocator, &readers, 10000, null);
    defer pool.deinit();
    var errors: usize = 0;
    var result = (try pool.fetchQuorum(0, allocator, &validators, 2, 3, &errors, null)).?;
    defer result.deinit();
    try std.testing.expectEqualSlices(u8, &checkpoint().root, &result.checkpoint.root);
    try std.testing.expectEqual(@as(usize, 0), errors);
    try std.testing.expectEqualSlices(u8, &validators[2], &try result.signatures[0].recover(result.checkpoint.digest()));
    try std.testing.expectEqualSlices(u8, &validators[3], &try result.signatures[1].recover(result.checkpoint.digest()));
}

test "parallel checkpoint latest queries retain validator positions and report failed storage" {
    const allocator = std.testing.allocator;
    var sources: [3]TestReader = undefined;
    var readers: [3]Reader = undefined;
    var validators: [3]Address = undefined;
    for (&sources, &readers, &validators, 0..) |*source, *reader, *validator, i| {
        source.* = .{ .signed = try objects.SignedCheckpoint.sign(checkpoint(), @splat(@as(u8, @intCast(0x11 + i))), null), .latest_index = @intCast(i + 5), .mode = if (i == 1) .failure else .ready };
        reader.* = try source.interface();
        validator.* = reader.validator;
    }
    const pool = try ReaderPool.start(allocator, &readers, 10000, null);
    defer pool.deinit();
    var output: [3]?u32 = undefined;
    var errors: usize = 0;
    try pool.latestIndices(0, &validators, &output, &errors, null);
    try std.testing.expectEqualSlices(?u32, &.{ 5, null, 7 }, &output);
    try std.testing.expectEqual(@as(usize, 1), errors);
    var result = (try pool.fetchQuorum(0, allocator, &validators, 2, 3, &errors, null)).?;
    defer result.deinit();
    // The failed peer may still be in flight when quorum succeeds; only
    // observed failures contribute to diagnostics before pending work cancels.
    try std.testing.expect(errors >= 1 and errors <= 2);
}

test "parallel checkpoint guards await every selected backend before early quorum" {
    const allocator = std.testing.allocator;
    var sources: [3]TestReader = undefined;
    var readers: [3]Reader = undefined;
    var validators: [3]Address = undefined;
    for (&sources, &readers, &validators, 0..) |*source, *reader, *validator, i| {
        source.* = .{ .signed = try objects.SignedCheckpoint.sign(checkpoint(), @splat(@as(u8, @intCast(0x11 + i))), null), .flagged = i == 2, .guard_delay_ms = if (i == 2) 2 else 0 };
        reader.* = try source.interface();
        validator.* = reader.validator;
    }
    const pool = try ReaderPool.start(allocator, &readers, 10000, null);
    var live = true;
    defer if (live) pool.deinit();
    var errors: usize = 0;
    try std.testing.expectError(error.ValidatorReorg, pool.fetchQuorum(0, allocator, &validators, 2, 3, &errors, null));
    readers[2].ignore_reorg_reports = true;
    pool.register(readers[2]);
    var selected = (try pool.fetchQuorum(0, allocator, &validators, 2, 3, &errors, null)).?;
    selected.deinit();
    try std.testing.expectEqual(@as(usize, 1), errors);
    pool.deinit();
    live = false;
    for (&sources) |*source| try std.testing.expectEqual(source.retained.load(.acquire), source.released.load(.acquire));
}

test "parallel checkpoint validation and reads retain the same locations during registry rotation" {
    const allocator = std.testing.allocator;
    var old: TestReader = .{ .signed = try objects.SignedCheckpoint.sign(checkpoint(), @splat(0x11), null) };
    var changed = checkpoint();
    changed.root = @splat(9);
    var replacement: TestReader = .{ .signed = try objects.SignedCheckpoint.sign(changed, @splat(0x11), null) };
    const reader = try old.interface();
    const pool = try ReaderPool.start(allocator, &.{reader}, 10000, null);
    var live = true;
    defer if (live) pool.deinit();
    old.swap_pool = pool;
    old.replacement = try replacement.interface();
    var errors: usize = 0;
    var selected = (try pool.fetchQuorum(0, allocator, &.{reader.validator}, 1, 3, &errors, null)).?;
    try std.testing.expectEqualSlices(u8, &checkpoint().root, &selected.checkpoint.root);
    selected.deinit();
    pool.deinit();
    live = false;
    try std.testing.expectEqual(old.retained.load(.acquire), old.released.load(.acquire));
    try std.testing.expectEqual(replacement.retained.load(.acquire), replacement.released.load(.acquire));
}
