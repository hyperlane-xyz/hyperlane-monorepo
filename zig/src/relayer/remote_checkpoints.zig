//! One native HTTP owner for all remote checkpoint sessions. A metadata worker
//! waits for a whole quorum, never occupies a worker per HTTP peer. Locations
//! are retained snapshots: rotation cannot swap an unchecked backend into fetch.
//! Security tightening: unreadable guards make that peer unusable (diagnostic),
//! whereas Rust's cached-backend recheck can assume no reorg after a read error.
const std = @import("std");
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
    phase: enum { guard, read } = .guard,
    arrivals: [256]Arrival = undefined,
    length: usize = 0,
    consumed: usize = 0,
    diagnostics: usize = 0,
    fatal: ?anyerror = null,
    finished: bool = false,
    fn retain(self: *Session) void {
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(self: *Session) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        for (self.peers) |peer| if (peer.registration) |registration| registration.release();
        self.allocator.free(self.peers);
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
    }
    fn diagnostic(self: *Session) void {
        self.mutex.lock();
        self.diagnostics += 1;
        self.mutex.unlock();
    }
    fn fail(self: *Session, err: anyerror) void {
        self.mutex.lock();
        self.fatal = err;
        self.closed.store(true, .release);
        self.wake.broadcast();
        self.mutex.unlock();
    }
    const Poll = union(enum) { pending, done, arrival: Arrival };
    fn poll(self: *Session) !Poll {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.fatal) |err| return err;
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
    validators: [256]Address = undefined,
    count: usize,
    collector: ?quorum.Collector = null,
    latest: [256]?u32 = @splat(null),
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
        const a = self.allocator;
        a.destroy(self);
    }
};

pub const Engine = struct {
    allocator: A,
    config: Config,
    http_owner: *multi.Multi,
    disk: *DiskPool,
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    readers: []?*Registration,
    touched: []u64,
    sequence: u64 = 0,
    sessions: []?*Session,
    stopping: std.atomic.Value(bool) = .init(false),
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
        self.* = .{ .allocator = allocator, .config = config, .http_owner = native, .readers = readers, .touched = touched, .sessions = sessions, .disk = undefined, .thread = undefined, .started = try std.time.Instant.now() };
        self.disk = try DiskPool.start(allocator, self, diskRun, diskFreeInput, diskFreeOutput);
        errdefer self.disk.deinit();
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        return self;
    }
    pub fn deinit(self: *Engine) void {
        self.stopping.store(true, .release);
        self.mutex.lock();
        self.wake.signal();
        self.mutex.unlock();
        self.thread.join();
        self.disk.deinit();
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
        session.* = .{ .allocator = self.allocator, .peers = peers, .kind = kind, .index = index, .deadline_ms = self.now() +| self.config.timeout_ms };
        session.retain(); // dedicated owner reference, released after work drains
        self.sessions[slot] = session;
        self.wake.signal();
        return session;
    }
    /// Nonblocking submission; current ordered registrations are retained once
    /// across guard-all and fetch phases. Result allocator outlives the request.
    pub fn submitQuorum(self: *Engine, origin: u32, allocator: A, validators: []const Address, threshold: usize, index: u32) !*ReadRequest {
        // Validate before enqueueing work or copying an oversized slice.
        var collector = try quorum.Collector.init(allocator, validators, threshold, index, .standard);
        const request = try self.allocator.create(ReadRequest);
        errdefer self.allocator.destroy(request);
        request.* = .{ .allocator = self.allocator, .session = try self.enqueue(origin, validators, .checkpoint, index), .count = validators.len };
        @memcpy(request.validators[0..validators.len], validators);
        collector.validators = request.validators[0..validators.len];
        request.collector = collector;
        return request;
    }
    pub fn submitLatest(self: *Engine, origin: u32, validators: []const Address) !*ReadRequest {
        if (validators.len > 256) return error.InvalidLatestIndicesLength;
        const request = try self.allocator.create(ReadRequest);
        errdefer self.allocator.destroy(request);
        request.* = .{ .allocator = self.allocator, .session = try self.enqueue(origin, validators, .latest, 0), .count = validators.len };
        @memcpy(request.validators[0..validators.len], validators);
        return request;
    }
    pub fn fetchQuorum(self: *Engine, origin: u32, allocator: A, validators: []const Address, threshold: usize, index: u32, storage_errors: *usize, cancel: ?*const std.atomic.Value(bool)) !?quorum.Quorum {
        var collector = try quorum.Collector.init(allocator, validators, threshold, index, .standard);
        const session = try self.enqueue(origin, validators, .checkpoint, index);
        defer {
            session.closed.store(true, .release);
            session.release();
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
    fn diskRun(_: *Engine, input: DiskInput, cancel: *const std.atomic.Value(bool)) !DiskOutput {
        const reader = input.registration.value.disk;
        const result: anyerror!ReadValue = blk: {
            if (cancel.load(.acquire)) break :blk error.RequestCancelled;
            if (input.guard) {
                if (reader.validate) |validate| validate(reader.context, cancel) catch |err| break :blk err;
                break :blk switch (input.session.kind) {
                    .checkpoint => .{ .checkpoint = null },
                    .latest => .{ .latest = null },
                };
            }
            break :blk switch (input.session.kind) {
                .checkpoint => .{ .checkpoint = reader.fetch(reader.context, input.session.index, cancel) catch |err| break :blk err },
                .latest => .{ .latest = reader.latest(reader.context, cancel) catch |err| break :blk err },
            };
        };
        input.session.retain(); // output outlives input cleanup
        return .{ .session = input.session, .peer = input.peer, .guard = input.guard, .result = result };
    }
    fn diskFreeInput(_: *Engine, input: DiskInput) void {
        input.session.release();
    }
    fn diskFreeOutput(_: *Engine, output: DiskOutput) void {
        output.session.release();
    }
    fn run(self: *Engine) void {
        while (true) {
            var snapshot: [128]?*Session = @splat(null);
            self.mutex.lock();
            for (self.sessions, snapshot[0..self.sessions.len]) |session, *out| {
                out.* = session;
                if (session) |value| value.retain();
            }
            self.mutex.unlock();
            var any = false;
            const now_ms = self.now();
            for (snapshot[0..self.sessions.len]) |entry| if (entry) |session| {
                any = true;
                if (self.stopping.load(.acquire)) session.fail(error.RemoteCheckpointEngineStopped);
                self.progress(session, now_ms) catch |err| session.fail(err);
            };
            while (self.http_owner.poll(now_ms) catch |err| blk: {
                for (snapshot) |entry| if (entry) |session| session.fail(err);
                break :blk null;
            }) |value| {
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
            while (self.disk.poll(now_ms)) |completion| switch (completion.result) {
                .value => |output| {
                    output.session.peers[output.peer].disk_id = null;
                    self.acceptResult(output.session, output.peer, output.guard, output.result) catch |err| output.session.fail(err);
                    self.disk.release(output);
                },
                .failure => |err| for (snapshot) |entry| if (entry) |session| for (session.peers, 0..) |*peer, index| if (peer.disk_id) |id| if (std.meta.eql(id, completion.id)) {
                    peer.disk_id = null;
                    self.acceptResult(session, index, session.phase == .guard, err) catch |failure| session.fail(failure);
                },
            };
            for (snapshot[0..self.sessions.len], 0..) |entry, index| if (entry) |session| {
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
                self.mutex.unlock();
            } else std.Thread.sleep(std.time.ns_per_ms);
        }
    }
    fn progress(self: *Engine, session: *Session, now_ms: u64) !void {
        if (!session.closed.load(.acquire) and now_ms >= session.deadline_ms) session.fail(error.RequestDeadlineExceeded);
        if (session.closed.load(.acquire)) {
            for (session.peers) |*peer| {
                if (peer.http_id) |id| self.http_owner.cancel(id) catch {};
                if (peer.disk_id) |id| {
                    _ = self.disk.cancel(id) catch {};
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
                session.retain();
                peer.disk_id = self.disk.submit(.{ .session = session, .peer = index, .registration = registration, .guard = session.phase == .guard }, now_ms, session.deadline_ms) catch |err| {
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
