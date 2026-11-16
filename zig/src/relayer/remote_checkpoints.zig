//! One native HTTP owner for all remote checkpoint sessions. A metadata worker
//! waits for a whole quorum, never occupies a worker per HTTP peer. Locations
//! are retained snapshots: rotation cannot swap an unchecked backend into fetch.
//! Security tightening: unreadable guards make that peer unusable (diagnostic),
//! whereas Rust's cached-backend recheck can assume no reorg after a read error.
const std = @import("std");
const fiber = @import("../runtime/fiber.zig");
const multi = @import("../net/curl_multi.zig");
const cloud = @import("../cloud/storage.zig");
const http = @import("../cloud/http.zig");
const objects = @import("../storage/objects.zig");
const quorum = @import("quorum.zig");
const local = @import("checkpoint_pool.zig");
const io = @import("../runtime/io_pool.zig");
const A = std.mem.Allocator;
pub const Address = [20]u8;
pub const RemoteReader = struct { origin: u32, validator: Address, location_id: [32]u8, backend: cloud.Backend, ignore_reorg_reports: bool = false };
pub const Candidate = union(enum) { remote: RemoteReader, disk: local.Reader };
pub const Config = struct { multi: multi.Config, timeout_ms: u32 = 30000, max_sessions: u16 = 32, max_readers: u16 = 4096, allow_insecure_loopback: bool = false };
const Registration = struct {
    allocator: A,
    references: std.atomic.Value(usize) = .init(1),
    arena: std.heap.ArenaAllocator,
    value: Candidate,
    alternates: []*Registration = &.{},
    /// Local storage whose inline read exceeded slow_disk_ns; its reads use
    /// the lazily started disk workers from then on (owner thread only).
    slow_disk: bool = false,
    fn at(self: *Registration, index: usize) *Registration {
        return if (index == 0) self else self.alternates[index - 1];
    }
    fn origin(self: *const Registration) u32 {
        return switch (self.value) {
            .remote => |r| r.origin,
            .disk => |r| r.origin,
        };
    }
    fn validator(self: *const Registration) Address {
        return switch (self.value) {
            .remote => |r| r.validator,
            .disk => |r| r.validator,
        };
    }
    fn ignore(self: *const Registration) bool {
        return switch (self.value) {
            .remote => |r| r.ignore_reorg_reports,
            .disk => |r| r.ignore_reorg_reports,
        };
    }
    fn retain(self: *Registration) void {
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(self: *Registration) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        for (self.alternates) |registration| registration.release();
        if (self.value == .disk) if (self.value.disk.release) |release_| release_(self.value.disk.context);
        self.arena.deinit();
        const allocator = self.allocator;
        allocator.destroy(self);
    }
};
const Kind = enum { checkpoint, latest };
const ReadValue = union(Kind) { checkpoint: ?objects.SignedCheckpoint, latest: ?u32 };
const Arrival = struct { index: usize, result: anyerror!ReadValue };
const Stage = enum { guard_root, guard_folder, guarded, read, done };
const Peer = struct {
    registration: ?*Registration,
    candidate: usize = 0,
    stage: Stage = .guard_folder,
    http_id: ?multi.Id = null,
    disk_id: ?DiskPool.JobId = null,
    fn selected(self: Peer) *Registration {
        return self.registration.?.at(self.candidate);
    }
    fn next(self: *Peer) bool {
        if (self.candidate >= self.registration.?.alternates.len) {
            self.stage = .done;
            return false;
        }
        self.candidate += 1;
        self.stage = guardStage(self.selected());
        return true;
    }
};
const Session = struct {
    allocator: A,
    references: std.atomic.Value(usize) = .init(1),
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    closed: std.atomic.Value(bool) = .init(false),
    peers: []Peer,
    kind: Kind,
    index: u32,
    deadline_ms: u64,
    /// Engine clock origin of deadline_ms: readers enforce the deadline
    /// themselves even while the owner is inside an inline disk read.
    clock: std.time.Instant,
    phase: enum { guard, read } = .guard,
    /// One per peer: each peer pushes exactly once, when it reaches done.
    arrivals: []Arrival,
    length: usize = 0,
    consumed: usize = 0,
    diagnostics: usize = 0,
    fatal: ?anyerror = null,
    finished: bool = false,
    /// Session mutex: the parked fiber / blocked thread in ReadRequest.wait.
    waiter: ?*fiber.Waiter = null,
    fn retain(self: *Session) void {
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(self: *Session) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        for (self.peers) |peer| if (peer.registration) |registration| registration.release();
        self.allocator.free(self.peers);
        self.allocator.free(self.arrivals);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
    fn push(self: *Session, value: Arrival) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.closed.load(.acquire)) return;
        std.debug.assert(self.length < self.arrivals.len);
        self.arrivals[self.length] = value;
        self.length += 1;
        self.wake.signal();
        self.wakeWaiterLocked();
    }
    /// Mutex held: wake (under it, so the Waiter is alive) a waiting reader.
    fn wakeWaiterLocked(self: *Session) void {
        const waiter = self.waiter orelse return;
        self.waiter = null;
        waiter.wake();
    }
    /// Register `waiter` unless an arrival or terminal state is already
    /// visible; false means poll now.
    fn armWaiter(self: *Session, waiter: *fiber.Waiter) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.fatal != null or self.finished or self.consumed < self.length) return false;
        self.waiter = waiter;
        return true;
    }
    fn disarmWaiter(self: *Session, waiter: *fiber.Waiter) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.waiter == waiter) self.waiter = null;
    }
    fn diagnostic(self: *Session) void {
        self.mutex.lock();
        self.diagnostics += 1;
        self.mutex.unlock();
    }
    fn remainingMs(self: *const Session) u64 {
        const now = std.time.Instant.now() catch return 0;
        return self.deadline_ms -| now.since(self.clock) / std.time.ns_per_ms;
    }
    /// Mutex held. Mirrors the owner's deadline failure.
    fn expireLocked(self: *Session) bool {
        if (self.finished or self.remainingMs() != 0) return false;
        self.closed.store(true, .release);
        return true;
    }
    fn fail(self: *Session, err: anyerror) void {
        self.mutex.lock();
        self.fatal = err;
        self.closed.store(true, .release);
        self.wake.broadcast();
        self.wakeWaiterLocked();
        self.mutex.unlock();
    }
    const Poll = union(enum) { pending, done, arrival: Arrival };
    fn poll(self: *Session) !Poll {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.fatal) |err| return err;
        if (self.expireLocked()) return error.RequestDeadlineExceeded;
        if (self.consumed < self.length) {
            const value = self.arrivals[self.consumed];
            self.consumed += 1;
            return .{ .arrival = value };
        }
        return if (self.finished) .done else .pending;
    }
    fn next(self: *Session, cancel: ?*const std.atomic.Value(bool)) !?Arrival {
        while (true) {
            if (cancel) |flag| if (flag.load(.acquire)) {
                self.closed.store(true, .release);
                return error.RequestCancelled;
            };
            self.mutex.lock();
            if (self.fatal) |err| {
                self.mutex.unlock();
                return err;
            }
            if (self.expireLocked()) {
                self.mutex.unlock();
                return error.RequestDeadlineExceeded;
            }
            if (self.consumed < self.length) {
                const value = self.arrivals[self.consumed];
                self.consumed += 1;
                self.mutex.unlock();
                return value;
            }
            if (self.finished) {
                self.mutex.unlock();
                return null;
            }
            self.wake.timedWait(&self.mutex, 25 * std.time.ns_per_ms) catch {};
            self.mutex.unlock();
        }
    }
};
const DiskInput = struct { session: *Session, peer: usize, registration: *Registration, guard: bool };
const DiskOutput = struct { session: *Session, peer: usize, guard: bool, result: anyerror!ReadValue };
const DiskPool = io.Pool(DiskInput, DiskOutput, Engine, 4, 512);

/// One retained logical lookup. Caller serializes poll/deinit and destroys this
/// before Engine. Engine/session own native cancellation and immutable location
/// snapshots. No caller cancellation pointer or validator slice is retained.
pub const ReadRequest = struct {
    allocator: A,
    session: *Session,
    /// Owned, sized to the validator count (fixed 256-entry arrays were
    /// filled per request in safety-checked builds).
    validators: []Address,
    count: usize,
    collector: ?quorum.Collector = null,
    latest: []?u32,
    storage_errors: usize = 0,
    diagnostics_reported: usize = 0,
    finished: bool = false,
    pub const Poll = union(enum) { pending, quorum: ?quorum.Quorum, latest: []const ?u32 };
    /// Terminal poll consumes the lookup; retained Source journals cache/clone
    /// its output themselves. Latest borrows this request; Quorum owns its usual
    /// result allocator. Reading storage_errors after each poll never adds twice.
    pub fn poll(self: *ReadRequest, cancel: ?*const std.atomic.Value(bool)) !Poll {
        if (self.finished) return error.RemoteReadAlreadyConsumed;
        if (cancel) |flag| if (flag.load(.acquire)) {
            self.finish();
            return error.RequestCancelled;
        };
        defer self.collectDiagnostics();
        while (true) {
            const ready = self.session.poll() catch |err| {
                self.finish();
                if (err == error.RequestDeadlineExceeded) {
                    self.session.mutex.lock();
                    self.storage_errors += self.count - self.session.consumed;
                    self.session.mutex.unlock();
                    return if (self.collector != null) .{ .quorum = null } else .{ .latest = self.latest[0..self.count] };
                }
                return err;
            };
            switch (ready) {
                .pending => return .pending,
                .done => {
                    self.finish();
                    return if (self.collector != null) .{ .quorum = null } else .{ .latest = self.latest[0..self.count] };
                },
                .arrival => |arrival| {
                    const value = arrival.result catch |err| {
                        if (err == error.OutOfMemory) {
                            self.finish();
                            return err;
                        }
                        self.storage_errors += 1;
                        continue;
                    };
                    if (self.collector) |*collector| {
                        if (value != .checkpoint) {
                            self.finish();
                            return error.WrongRemoteReadKind;
                        }
                        if (value.checkpoint) |signed| {
                            const result = collector.push(.{ .validator_index = arrival.index, .signed = signed }) catch |err| {
                                self.finish();
                                return err;
                            };
                            if (result) |found| {
                                self.finish();
                                return .{ .quorum = found };
                            }
                        }
                    } else {
                        if (value != .latest or arrival.index >= self.count) {
                            self.finish();
                            return error.WrongRemoteReadKind;
                        }
                        self.latest[arrival.index] = value.latest;
                    }
                },
            }
        }
    }
    /// Poll until terminal: a fiber parks (its worker runs other fibers) and a
    /// thread blocks until an arrival, completion or failure wakes it. The
    /// Engine enforces the session deadline; `cancel` has no notifier, so it
    /// is rechecked on a slice.
    pub fn wait(self: *ReadRequest, cancel: ?*const std.atomic.Value(bool)) !Poll {
        while (true) {
            const ready = try self.poll(cancel);
            if (ready != .pending) return ready;
            var waiter: fiber.Waiter = .{};
            if (!self.session.armWaiter(&waiter)) continue;
            const slice_ms: i64 = @min(@as(i64, if (cancel != null) cancel_slice_ms else 1000), @as(i64, @intCast(@min(self.session.remainingMs(), 1000))) + 1);
            _ = waiter.waitTimeout(fiber.monoMs() + slice_ms);
            self.session.disarmWaiter(&waiter);
        }
    }
    const cancel_slice_ms = 10;
    fn collectDiagnostics(self: *ReadRequest) void {
        self.session.mutex.lock();
        defer self.session.mutex.unlock();
        self.storage_errors += self.session.diagnostics - self.diagnostics_reported;
        self.diagnostics_reported = self.session.diagnostics;
    }
    fn finish(self: *ReadRequest) void {
        self.finished = true;
        self.session.closed.store(true, .release);
    }
    pub fn deinit(self: *ReadRequest) void {
        self.finish();
        self.session.release();
        if (self.collector) |*collector| collector.deinit();
        const a = self.allocator;
        a.free(self.validators);
        a.free(self.latest);
        a.destroy(self);
    }
};

const disk_wait_ns: u64 = 50 * std.time.ns_per_ms;
/// Local checkpoint files are small: an inline read slower than this marks
/// the storage slow and moves its later reads to disk workers.
const slow_disk_ns: u64 = 10 * std.time.ns_per_ms;
/// Bound on a socket wait, so caller closes (which have no notifier) and
/// session deadlines are still observed while HTTP transfers are in flight.
const http_wait_ms: u64 = disk_wait_ns / std.time.ns_per_ms;

pub const Engine = struct {
    allocator: A,
    config: Config,
    http_owner: *multi.Multi,
    /// Started on the first slow local storage; null while reads run inline.
    disk: ?*DiskPool = null,
    /// Owner thread: an inline disk read completed during this pass.
    inline_progress: bool = false,
    /// Disk workers exist (evidence that local reads otherwise run inline).
    disk_workers_started: std.atomic.Value(bool) = .init(false),
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    readers: []?*Registration,
    touched: []u64,
    sequence: u64 = 0,
    sessions: []?*Session,
    stopping: std.atomic.Value(bool) = .init(false),
    /// Disk completion or a new session since the loop last waited (mutex).
    kicked: bool = false,
    /// A failed socket wait, reported to live sessions like a failed poll.
    http_wait_failure: ?anyerror = null,
    /// Owner loop passes, for work-count evidence.
    loop_iterations: std.atomic.Value(u64) = .init(0),
    thread: std.Thread,
    started: std.time.Instant,
    /// Allocator must be thread-safe. Callers may register/read concurrently;
    /// deinit follows cancellation and joining of every metadata caller.
    pub fn start(allocator: A, config: Config) !*Engine {
        if (config.timeout_ms == 0 or config.timeout_ms > 300000 or config.max_sessions == 0 or config.max_sessions > 128 or config.max_readers == 0 or config.max_readers > 4096) return error.InvalidRemoteCheckpointConfig;
        const self = try allocator.create(Engine);
        errdefer allocator.destroy(self);
        const native = try multi.Multi.init(allocator, config.multi);
        errdefer native.deinit();
        const readers = try allocator.alloc(?*Registration, config.max_readers);
        errdefer allocator.free(readers);
        @memset(readers, null);
        const touched = try allocator.alloc(u64, config.max_readers);
        errdefer allocator.free(touched);
        @memset(touched, 0);
        const sessions = try allocator.alloc(?*Session, config.max_sessions);
        errdefer allocator.free(sessions);
        @memset(sessions, null);
        self.* = .{ .allocator = allocator, .config = config, .http_owner = native, .readers = readers, .touched = touched, .sessions = sessions, .thread = undefined, .started = try std.time.Instant.now() };
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        return self;
    }
    pub fn deinit(self: *Engine) void {
        self.stopping.store(true, .release);
        self.mutex.lock();
        // An inline disk read observes its session's closed flag.
        for (self.sessions) |entry| if (entry) |session| session.closed.store(true, .release);
        self.wake.signal();
        self.mutex.unlock();
        self.http_owner.wakeup();
        self.thread.join();
        if (self.disk) |disk| disk.deinit();
        self.http_owner.deinit();
        for (self.readers) |registration| if (registration) |value| value.release();
        self.allocator.free(self.readers);
        self.allocator.free(self.touched);
        self.allocator.free(self.sessions);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
    fn now(self: *Engine) u64 {
        return (std.time.Instant.now() catch self.started).since(self.started) / std.time.ns_per_ms;
    }
    fn unusedTransport(_: *anyopaque, _: A, _: http.Request) !http.Response {
        return error.AsyncTransportOnly;
    }
    pub fn register(self: *Engine, reader: RemoteReader) !void {
        return self.registerLocations(reader.origin, reader.validator, &.{.{ .remote = reader }});
    }
    pub fn registerLocal(self: *Engine, reader: local.Reader) !void {
        return self.registerLocations(reader.origin, reader.validator, &.{.{ .disk = reader }});
    }
    /// Latest-first ordered locations. Every candidate is retained in the same
    /// immutable registration snapshot; fallback occurs only during guard phase.
    pub fn registerLocations(self: *Engine, origin: u32, validator: Address, candidates: []const Candidate) !void {
        if (candidates.len == 0) {
            self.unregister(origin, validator);
            return;
        }
        if (candidates.len > 256) return error.InvalidCheckpointLocationCount;
        var size: usize = 0;
        for (candidates) |candidate| {
            const matches = switch (candidate) {
                .remote => |reader| reader.origin == origin and std.mem.eql(u8, &reader.validator, &validator),
                .disk => |reader| reader.origin == origin and std.mem.eql(u8, &reader.validator, &validator),
            };
            if (!matches) return error.WrongCheckpointLocationIdentity;
            if (candidate == .remote) size = try std.math.add(usize, size, try backendSize(candidate.remote.backend));
        }
        if (size > 65536) return error.RemoteCheckpointDescriptorTooLarge;
        var root: ?*Registration = null;
        errdefer if (root) |registration| registration.release();
        var alternates: []*Registration = &.{};
        for (candidates) |candidate| {
            const registration = self.buildRegistration(candidate) catch |err| {
                if (err == error.OutOfMemory) return err;
                continue; // invalid candidate cannot shadow an older valid one
            };
            if (root) |first| {
                alternates[first.alternates.len] = registration;
                first.alternates = alternates[0 .. first.alternates.len + 1];
            } else {
                root = registration;
                alternates = try registration.arena.allocator().alloc(*Registration, candidates.len - 1);
            }
        }
        const selected = root orelse {
            self.unregister(origin, validator);
            return error.NoUsableCheckpointLocations;
        };
        try self.install(selected);
    }
    pub fn unregister(self: *Engine, origin: u32, validator: Address) void {
        self.mutex.lock();
        var removed: ?*Registration = null;
        for (self.readers) |*entry| if (entry.*) |registration| {
            if (registration.origin() != origin or !std.mem.eql(u8, &registration.validator(), &validator)) continue;
            removed = registration;
            entry.* = null;
            break;
        };
        self.mutex.unlock();
        if (removed) |registration| registration.release();
    }

    fn buildRegistration(self: *Engine, candidate: Candidate) !*Registration {
        const registration = try self.allocator.create(Registration);
        errdefer self.allocator.destroy(registration);
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const owned: Candidate = switch (candidate) {
            .remote => |reader| blk: {
                var checked = try cloud.Store.init(self.allocator, .{ .context = self, .send_fn = unusedTransport }, reader.backend, .{});
                var prepared = try checked.prepareRead(self.allocator, .reorg_flag, false, self.config.allow_insecure_loopback);
                prepared.deinit();
                var result = reader;
                result.backend = try duplicateBackend(arena.allocator(), reader.backend);
                break :blk .{ .remote = result };
            },
            .disk => |reader| blk: {
                if (reader.validate == null) return error.LocalCheckpointGuardRequired;
                if ((reader.retain == null) != (reader.release == null)) return error.UnpairedCheckpointReaderRetention;
                if (reader.retain) |retain| retain(reader.context);
                break :blk .{ .disk = reader };
            },
        };
        registration.* = .{ .allocator = self.allocator, .arena = arena, .value = owned };
        return registration;
    }
    fn install(self: *Engine, registration: *Registration) !void {
        self.mutex.lock();
        if (self.stopping.load(.acquire)) {
            self.mutex.unlock();
            return error.RemoteCheckpointEngineStopped;
        }
        var selected: ?usize = null;
        var oldest: usize = 0;
        for (self.readers, 0..) |entry, index| {
            if (entry) |previous| {
                if (previous.origin() == registration.origin() and std.mem.eql(u8, &previous.validator(), &registration.validator())) {
                    selected = index;
                    break;
                }
            } else if (selected == null) selected = index;
            if (self.touched[index] < self.touched[oldest]) oldest = index;
        }
        const index = selected orelse oldest;
        const previous = self.readers[index];
        self.readers[index] = registration;
        self.sequence +|= 1;
        self.touched[index] = self.sequence;
        self.mutex.unlock();
        if (previous) |value| value.release();
    }
    pub fn hasReader(self: *Engine, origin: u32, validator: Address) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.readers) |entry| if (entry) |reader| if (reader.origin() == origin and std.mem.eql(u8, &reader.validator(), &validator)) return true;
        return false;
    }
    pub fn hasLocation(self: *Engine, origin: u32, validator: Address, location_id: [32]u8) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.readers) |entry| if (entry) |reader| {
            if (reader.origin() != origin or !std.mem.eql(u8, &reader.validator(), &validator)) continue;
            const current = switch (reader.value) {
                .remote => |remote| remote.location_id,
                .disk => |disk| disk.location_id,
            };
            return std.mem.eql(u8, &current, &location_id);
        };
        return false;
    }
    fn enqueue(self: *Engine, origin: u32, validators: []const Address, kind: Kind, index: u32) !*Session {
        if (validators.len > 256) return error.InvalidValidatorCount;
        const session = try self.allocator.create(Session);
        errdefer self.allocator.destroy(session);
        const peers = try self.allocator.alloc(Peer, validators.len);
        errdefer self.allocator.free(peers);
        @memset(peers, .{ .registration = null, .stage = .done });
        const arrivals = try self.allocator.alloc(Arrival, validators.len);
        errdefer self.allocator.free(arrivals);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopping.load(.acquire)) return error.RemoteCheckpointEngineStopped;
        const slot = for (self.sessions, 0..) |active, i| {
            if (active == null) break i;
        } else return error.RemoteCheckpointSessionsFull;
        for (validators, peers) |validator, *peer| for (self.readers, 0..) |entry, i| if (entry) |registration| {
            if (registration.origin() != origin or !std.mem.eql(u8, &registration.validator(), &validator)) continue;
            registration.retain();
            peer.registration = registration;
            peer.stage = guardStage(registration);
            self.sequence +|= 1;
            self.touched[i] = self.sequence;
            break;
        };
        session.* = .{ .allocator = self.allocator, .peers = peers, .arrivals = arrivals, .kind = kind, .index = index, .deadline_ms = self.now() +| self.config.timeout_ms, .clock = self.started };
        session.retain(); // dedicated owner reference, released after work drains
        self.sessions[slot] = session;
        self.kicked = true;
        self.wake.signal();
        self.http_owner.wakeup();
        return session;
    }
    /// Nonblocking submission; current ordered registrations are retained once
    /// across guard-all and fetch phases. Result allocator outlives the request.
    pub fn submitQuorum(self: *Engine, origin: u32, allocator: A, validators: []const Address, threshold: usize, index: u32) !*ReadRequest {
        // Validate before enqueueing work or copying an oversized slice.
        var collector = try quorum.Collector.init(allocator, validators, threshold, index, .standard);
        errdefer collector.deinit();
        const request = try self.newRequest(origin, validators, .checkpoint, index);
        collector.validators = request.validators;
        request.collector = collector;
        return request;
    }
    pub fn submitLatest(self: *Engine, origin: u32, validators: []const Address) !*ReadRequest {
        if (validators.len > 256) return error.InvalidLatestIndicesLength;
        return self.newRequest(origin, validators, .latest, 0);
    }
    fn newRequest(self: *Engine, origin: u32, validators: []const Address, kind: Kind, index: u32) !*ReadRequest {
        const request = try self.allocator.create(ReadRequest);
        errdefer self.allocator.destroy(request);
        const owned = try self.allocator.dupe(Address, validators);
        errdefer self.allocator.free(owned);
        const latest = try self.allocator.alloc(?u32, validators.len);
        errdefer self.allocator.free(latest);
        @memset(latest, null);
        request.* = .{ .allocator = self.allocator, .session = try self.enqueue(origin, validators, kind, index), .validators = owned, .latest = latest, .count = validators.len };
        return request;
    }
    pub fn fetchQuorum(self: *Engine, origin: u32, allocator: A, validators: []const Address, threshold: usize, index: u32, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) !?quorum.Quorum {
        var collector = try quorum.Collector.init(allocator, validators, threshold, index, .standard);
        defer collector.deinit();
        const session = try self.enqueue(origin, validators, .checkpoint, index);
        defer {
            session.closed.store(true, .release);
            session.release();
            self.http_owner.wakeup();
        }
        defer {
            session.mutex.lock();
            storage_errors.* += session.diagnostics;
            session.mutex.unlock();
        }
        while (session.next(cancel) catch |err| {
            if (err == error.RequestDeadlineExceeded) {
                storage_errors.* += validators.len - session.consumed;
                return null;
            }
            return err;
        }) |arrival| {
            const value = arrival.result catch |err| {
                if (err == error.OutOfMemory) return err;
                storage_errors.* += 1;
                continue;
            };
            if (value.checkpoint) |signed| if (try collector.push(.{ .validator_index = arrival.index, .signed = signed })) |result| return result;
        }
        return null;
    }
    pub fn latestIndices(self: *Engine, origin: u32, validators: []const Address, output: []?u32, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) !void {
        if (output.len != validators.len or validators.len > 256) return error.InvalidLatestIndicesLength;
        @memset(output, null);
        const session = try self.enqueue(origin, validators, .latest, 0);
        defer {
            session.closed.store(true, .release);
            session.release();
            self.http_owner.wakeup();
        }
        defer {
            session.mutex.lock();
            storage_errors.* += session.diagnostics;
            session.mutex.unlock();
        }
        while (session.next(cancel) catch |err| {
            if (err == error.RequestDeadlineExceeded) {
                storage_errors.* += validators.len - session.consumed;
                return;
            }
            return err;
        }) |arrival| {
            const value = arrival.result catch |err| {
                if (err == error.OutOfMemory) return err;
                storage_errors.* += 1;
                continue;
            };
            output[arrival.index] = value.latest;
        }
    }
    fn readDisk(session: *const Session, registration: *Registration, guard: bool, cancel: *const std.atomic.Value(bool)) anyerror!ReadValue {
        const reader = registration.value.disk;
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (guard) {
            if (reader.validate) |validate| try validate(reader.context, cancel);
            return switch (session.kind) {
                .checkpoint => .{ .checkpoint = null },
                .latest => .{ .latest = null },
            };
        }
        return switch (session.kind) {
            .checkpoint => .{ .checkpoint = try reader.fetch(reader.context, session.index, cancel) },
            .latest => .{ .latest = try reader.latest(reader.context, cancel) },
        };
    }
    fn diskRun(_: *Engine, input: DiskInput, cancel: *const std.atomic.Value(bool)) !DiskOutput {
        const result = readDisk(input.session, input.registration, input.guard, cancel);
        input.session.retain(); // output outlives input cleanup
        return .{ .session = input.session, .peer = input.peer, .guard = input.guard, .result = result };
    }
    fn startDisk(self: *Engine) !*DiskPool {
        const disk = try DiskPool.start(self.allocator, self, diskRun, diskFreeInput, diskFreeOutput);
        disk.completion_hook = .{ .context = self, .call_fn = diskCompleted };
        self.disk = disk;
        self.disk_workers_started.store(true, .release);
        return disk;
    }
    fn diskFreeInput(_: *Engine, input: DiskInput) void {
        input.session.release();
    }
    fn diskFreeOutput(_: *Engine, output: DiskOutput) void {
        output.session.release();
    }
    /// Disk worker completion: end the owner's wait instead of a 1ms poll.
    fn diskCompleted(context: *anyopaque) void {
        const self: *Engine = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.kicked = true;
        self.wake.signal();
        self.http_owner.wakeup();
    }
    fn httpNext(self: *Engine, now_ms: u64) !?multi.Completion {
        if (self.http_wait_failure) |err| {
            self.http_wait_failure = null;
            return err;
        }
        // The loop waits on sockets whenever transfers are pending and a pass
        // progressed nothing, so readiness is gathered by that wait.
        return self.http_owner.advance(now_ms);
    }
    fn run(self: *Engine) void {
        while (true) {
            _ = self.loop_iterations.fetchAdd(1, .monotonic);
            var http_pending = false;
            var snapshot: [128]?*Session = @splat(null);
            self.mutex.lock();
            for (self.sessions, snapshot[0..self.sessions.len]) |session, *out| {
                out.* = session;
                if (session) |value| value.retain();
            }
            self.mutex.unlock();
            var any = false;
            // Completions mutate session state whose follow-up runs in the next
            // pass's progress: such a pass loops again instead of waiting.
            var progressed = false;
            self.inline_progress = false;
            var next_deadline: u64 = std.math.maxInt(u64);
            const now_ms = self.now();
            for (snapshot[0..self.sessions.len]) |entry| if (entry) |session| {
                any = true;
                if (self.stopping.load(.acquire)) session.fail(error.RemoteCheckpointEngineStopped);
                self.progress(session, now_ms) catch |err| session.fail(err);
                next_deadline = @min(next_deadline, session.deadline_ms);
            };
            while (self.httpNext(now_ms) catch |err| blk: {
                for (snapshot) |entry| if (entry) |session| session.fail(err);
                break :blk null;
            }) |value| {
                progressed = true;
                var completion = value;
                defer completion.deinit();
                for (snapshot) |entry| if (entry) |session| {
                    const found = for (session.peers, 0..) |*peer, index| {
                        if (peer.http_id) |id| if (std.meta.eql(id, completion.id)) {
                            peer.http_id = null;
                            self.httpResult(session, index, completion.result) catch |err| session.fail(err);
                            break true;
                        };
                    } else false;
                    if (found) break;
                };
            }
            progressed = progressed or self.inline_progress;
            if (self.disk) |disk| while (disk.poll(now_ms)) |completion| : (progressed = true) switch (completion.result) {
                .value => |output| {
                    output.session.peers[output.peer].disk_id = null;
                    self.acceptResult(output.session, output.peer, output.guard, output.result) catch |err| output.session.fail(err);
                    disk.release(output);
                },
                .failure => |err| for (snapshot) |entry| if (entry) |session| for (session.peers, 0..) |*peer, index| if (peer.disk_id) |id| if (std.meta.eql(id, completion.id)) {
                    peer.disk_id = null;
                    self.acceptResult(session, index, session.phase == .guard, err) catch |failure| session.fail(failure);
                },
            };
            for (snapshot[0..self.sessions.len], 0..) |entry, index| if (entry) |session| {
                for (session.peers) |peer| http_pending = http_pending or peer.http_id != null;
                const drained = for (session.peers) |peer| {
                    if (peer.http_id != null or peer.disk_id != null) break false;
                } else true;
                const all_done = for (session.peers) |peer| {
                    if (peer.stage != .done) break false;
                } else true;
                if (drained and (session.closed.load(.acquire) or (session.phase == .read and all_done))) {
                    session.mutex.lock();
                    session.finished = true;
                    session.wake.broadcast();
                    session.wakeWaiterLocked();
                    session.mutex.unlock();
                    self.mutex.lock();
                    self.sessions[index] = null;
                    self.mutex.unlock();
                    session.release(); // owner
                }
                session.release(); // snapshot
            };
            if (self.stopping.load(.acquire) and !any) return;
            if (!any) {
                self.mutex.lock();
                const empty_sessions = for (self.sessions) |entry| {
                    if (entry != null) break false;
                } else true;
                if (empty_sessions and !self.stopping.load(.acquire)) self.wake.timedWait(&self.mutex, std.time.ns_per_s) catch {};
                self.kicked = false;
                self.mutex.unlock();
            } else if (http_pending) {
                // Block on sockets, libcurl timers and transfer deadlines; a
                // kick (new session, disk completion, stop) wakes the multi.
                if (!progressed) {
                    const wait_ms = self.now();
                    self.http_owner.wait(wait_ms, @intCast(@min(http_wait_ms, next_deadline -| wait_ms))) catch |err| {
                        self.http_wait_failure = err;
                    };
                }
            } else {
                // Disk-only sessions: an inline read's follow-up runs at once;
                // otherwise sleep until a disk completion or new session
                // (bounded, so session deadlines and closes are seen).
                self.mutex.lock();
                if (!progressed and !self.kicked and !self.stopping.load(.acquire)) self.wake.timedWait(&self.mutex, disk_wait_ns) catch {};
                self.kicked = false;
                self.mutex.unlock();
            }
        }
    }
    fn progress(self: *Engine, session: *Session, now_ms: u64) !void {
        if (!session.closed.load(.acquire) and now_ms >= session.deadline_ms) session.fail(error.RequestDeadlineExceeded);
        if (session.closed.load(.acquire)) {
            for (session.peers) |*peer| {
                if (peer.http_id) |id| self.http_owner.cancel(id) catch {};
                if (peer.disk_id) |id| {
                    if (self.disk) |disk| _ = disk.cancel(id) catch {};
                    peer.disk_id = null;
                }
            }
            return;
        }
        if (session.phase == .guard) {
            const guarded = for (session.peers) |peer| {
                if (peer.stage != .guarded and peer.stage != .done) break false;
            } else true;
            if (guarded) {
                session.phase = .read;
                for (session.peers, 0..) |*peer, index| if (peer.stage == .guarded) {
                    peer.stage = .read;
                } else session.push(.{ .index = index, .result = empty(session.kind) });
            }
        }
        var submitted: usize = 0;
        for (session.peers, 0..) |*peer, index| {
            if (peer.stage == .done or peer.stage == .guarded or peer.http_id != null or peer.disk_id != null) continue;
            if (submitted >= 16) break;
            if (peer.registration == null) continue;
            const registration = peer.selected();
            if (registration.value == .disk) {
                const guard = session.phase == .guard;
                if (!registration.slow_disk) {
                    // Small local files: read inline on the owner thread, with
                    // no worker handoff per read. The session's closed flag
                    // cancels it and readers enforce the deadline meanwhile.
                    const begin = std.time.Instant.now() catch null;
                    const value = readDisk(session, registration, guard, &session.closed);
                    if (begin) |started| if ((std.time.Instant.now() catch started).since(started) > slow_disk_ns) {
                        registration.slow_disk = true;
                    };
                    self.inline_progress = true;
                    submitted += 1;
                    try self.acceptResult(session, index, guard, value);
                    continue;
                }
                const disk = self.disk orelse try self.startDisk();
                session.retain();
                peer.disk_id = disk.submit(.{ .session = session, .peer = index, .registration = registration, .guard = guard }, now_ms, session.deadline_ms) catch |err| {
                    session.release();
                    if (err == error.IoPoolFull) continue;
                    return err;
                };
            } else {
                var store = try cloud.Store.init(self.allocator, .{ .context = self, .send_fn = unusedTransport }, registration.value.remote.backend, .{});
                const object: cloud.Object = if (session.phase == .guard) .reorg_flag else switch (session.kind) {
                    .checkpoint => .{ .checkpoint = session.index },
                    .latest => .latest_index,
                };
                var request = try store.prepareRead(self.allocator, object, peer.stage == .guard_root, self.config.allow_insecure_loopback);
                defer request.deinit();
                request.request.cancel = &session.closed;
                request.request.timeout_ms = @intCast(@min(session.deadline_ms - now_ms, request.request.timeout_ms));
                request.request.connect_timeout_ms = @min(request.request.connect_timeout_ms, request.request.timeout_ms);
                peer.http_id = self.http_owner.submit(request.request, now_ms) catch |err| {
                    if (err == error.CurlMultiQueueFull or err == error.CurlMultiByteBudgetExceeded) continue;
                    return err;
                };
            }
            submitted += 1;
        }
    }
    fn acceptResult(_: *Engine, session: *Session, index: usize, guard: bool, value: anyerror!ReadValue) !void {
        if (session.closed.load(.acquire)) return;
        const peer = &session.peers[index];
        if (guard) {
            _ = value catch |err| {
                if (err == error.OutOfMemory) return err;
                if (err == error.ValidatorReorg or err == error.ReorgHalted) {
                    if (!peer.selected().ignore()) return error.ValidatorReorg;
                } else session.diagnostic();
                _ = peer.next();
                return;
            };
            peer.stage = .guarded;
        } else {
            peer.stage = .done;
            session.push(.{ .index = index, .result = value });
        }
    }
    fn httpResult(self: *Engine, session: *Session, index: usize, result_: multi.Result) !void {
        if (session.closed.load(.acquire)) return;
        const peer = &session.peers[index];
        const guard = session.phase == .guard;
        const response = switch (result_) {
            .response => |response| response,
            .failure => |err| return self.acceptResult(session, index, guard, err),
        };
        const backend = peer.selected().value.remote.backend;
        const missing = response.status == 404 and (backend == .gcs or std.mem.indexOf(u8, response.body, "<Code>NoSuchKey</Code>") != null);
        if (!missing and !http.isSuccess(response.status)) return self.acceptResult(session, index, guard, error.CloudObjectReadFailed);
        if (guard) {
            if (!missing) return self.acceptResult(session, index, true, error.ValidatorReorg); // existence, even malformed bytes, is authoritative
            if (peer.stage == .guard_root) {
                peer.stage = .guard_folder;
                return;
            }
            return self.acceptResult(session, index, true, empty(session.kind));
        }
        if (missing) return self.acceptResult(session, index, false, empty(session.kind));
        switch (session.kind) {
            .checkpoint => {
                const signed = objects.SignedCheckpoint.parse(self.allocator, response.body) catch |err| return self.acceptResult(session, index, false, err);
                if (signed.value.index != session.index) return self.acceptResult(session, index, false, error.WrongCheckpointIndex);
                return self.acceptResult(session, index, false, .{ .checkpoint = signed });
            },
            .latest => {
                const parsed = std.json.parseFromSlice(u32, self.allocator, response.body, .{}) catch |err| return self.acceptResult(session, index, false, err);
                defer parsed.deinit();
                return self.acceptResult(session, index, false, .{ .latest = parsed.value });
            },
        }
    }
};
fn empty(kind: Kind) ReadValue {
    return switch (kind) {
        .checkpoint => .{ .checkpoint = null },
        .latest => .{ .latest = null },
    };
}
fn duplicateBackend(a: A, backend: cloud.Backend) !cloud.Backend {
    return switch (backend) {
        .s3 => |config| .{ .s3 = .{ .endpoint = try a.dupe(u8, config.endpoint), .bucket = try a.dupe(u8, config.bucket), .region = try a.dupe(u8, config.region), .folder = if (config.folder) |folder| try a.dupe(u8, folder) else null, .credentials = if (config.credentials) |credentials| .{ .access_key_id = try a.dupe(u8, credentials.access_key_id), .secret_access_key = try a.dupe(u8, credentials.secret_access_key), .session_token = if (credentials.session_token) |token| try a.dupe(u8, token) else null } else null } },
        .gcs => |config| .{ .gcs = .{ .endpoint = try a.dupe(u8, config.endpoint), .bucket = try a.dupe(u8, config.bucket), .folder = if (config.folder) |folder| try a.dupe(u8, folder) else null, .bearer_token = if (config.bearer_token) |token| try a.dupe(u8, token) else null } },
    };
}

test "remote checkpoint engine validates configuration without native loading" {
    try std.testing.expectError(error.InvalidRemoteCheckpointConfig, Engine.start(std.testing.allocator, .{ .multi = .{ .library_path = "/never/load" }, .timeout_ms = 0 }));
}

fn backendSize(backend: cloud.Backend) !usize {
    var size: usize = 0;
    switch (backend) {
        .s3 => |config| {
            for ([_][]const u8{ config.endpoint, config.bucket, config.region, config.folder orelse "" }) |bytes| size = try std.math.add(usize, size, bytes.len);
            if (config.credentials) |credentials| for ([_][]const u8{ credentials.access_key_id, credentials.secret_access_key, credentials.session_token orelse "" }) |bytes| {
                size = try std.math.add(usize, size, bytes.len);
            };
        },
        .gcs => |config| for ([_][]const u8{ config.endpoint, config.bucket, config.folder orelse "", config.bearer_token orelse "" }) |bytes| {
            size = try std.math.add(usize, size, bytes.len);
        },
    }
    return size;
}
test {
    _ = @import("remote_checkpoints_testing.zig");
}

fn guardStage(registration: *Registration) Stage {
    return if (registration.value == .remote and registration.value.remote.backend == .gcs and registration.value.remote.backend.gcs.folder != null) .guard_root else .guard_folder;
}
