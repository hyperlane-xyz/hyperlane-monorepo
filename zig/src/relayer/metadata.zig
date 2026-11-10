//! Protocol metadata construction with injected chain/storage operations. The
//! same builder runs against EVM I/O and scripted fault sources in tests.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const quorum = @import("quorum.zig");
const metadata_parallel = @import("metadata_parallel.zig");
const objects = @import("../storage/objects.zig");
pub const Observation = @import("../ops/validator_observability.zig").Observation;
pub const Address = [20]u8;
pub const ModuleType = enum(u8) {
    unused = 0,
    routing = 1,
    aggregation = 2,
    legacy_multisig = 3,
    merkle_root_multisig = 4,
    message_id_multisig = 5,
    null_ism = 6,
    ccip_read = 7,
    arb_l2_to_l1 = 8,
    weighted_merkle_root_multisig = 9,
    weighted_message_id_multisig = 10,
    op_l2_to_l1 = 11,
    polymer = 12,
    composite = 13,
};
pub fn ModuleMembers(comptime ModuleAddress: type) type {
    return struct { addresses: []ModuleAddress, threshold: usize };
}
pub const Members = ModuleMembers(Address);
pub const Diagnostics = struct {
    storage_errors: usize = 0,
    awaiting_signatures: usize = 0,
    verification_failures: usize = 0,
    verification_deadline: usize = 0,
    verification_rejected: usize = 0,
    verification_abi: usize = 0,
    verification_rpc: usize = 0,
    verification_other: usize = 0,

    /// Counts the same failures as before; classes retain no remote/error text.
    fn verificationFailure(self: *Diagnostics, failure: anyerror) void {
        self.verification_failures += 1;
        switch (failure) {
            error.RequestDeadlineExceeded, error.UpstreamReadTimeout => self.verification_deadline += 1,
            error.VerifyRejected => self.verification_rejected += 1,
            error.InvalidAbi, error.InvalidHex, error.InvalidQuantity, error.IntegerOverflow, error.InvalidGasEstimate => self.verification_abi += 1,
            error.RpcError, error.RpcRemoteError, error.RpcHttpStatus, error.RpcResponseDecode, error.RpcIdMismatch, error.InvalidRpcEnvelope, error.NoQuorumReached => self.verification_rpc += 1,
            else => self.verification_other += 1,
        }
    }
};
pub const Verification = struct { valid: bool, cost: ?u256 = null };
/// Refusal and cooperative-I/O control flow cannot become an absent validator
/// or an optional failed aggregation branch.
pub fn hardFailure(err: anyerror) bool {
    return switch (err) {
        error.OutOfMemory, error.ValidatorReorg, error.ReorgHalted, error.ReorgFlagPresent, error.RequestCancelled, error.Cancelled, error.PendingReadIo, error.PendingIo, error.MessageMetadataRefused => true,
        else => false,
    };
}

pub fn Builder(comptime Source: type) type {
    return struct {
        const Self = @This();
        const ModuleAddress = if (@hasDecl(Source, "ModuleAddress")) Source.ModuleAddress else Address;
        const Attempt = metadata_parallel.Attempt(Diagnostics);
        const VisitMemo = metadata_parallel.VisitMemo(Attempt);
        const Candidate = struct { index: usize, bytes: []u8, gas: ?u256, reserved: bool = false };
        const Mode = enum { discover, build, root };
        const Result = union(enum) { idle, discovered: ModuleType, verified: Candidate, failed: anyerror };
        const Operation = struct {
            const JobState = struct {
                job: metadata_parallel.Job = .{ .run_fn = run },
                operation: *Operation,
                address: ModuleAddress,
                index: usize,
                known_type: ?ModuleType,
                path: metadata_parallel.VisitPath,
                source: ?*Source = null,
                completion_next: ?*JobState = null,
                completed: bool = false,
                result: Result = .idle,

                fn closeSource(self: *JobState) void {
                    if (self.source) |source| source.deinitFork();
                    self.source = null;
                }

                fn finish(self: *JobState, result: Result) void {
                    self.operation.complete(self, result);
                    self.closeSource();
                    self.operation.release();
                }

                fn run(job: *metadata_parallel.Job) metadata_parallel.RunResult {
                    const self: *JobState = @alignCast(@fieldParentPtr("job", job));
                    const operation = self.operation;
                    const source = self.source.?;
                    if (operation.parentCancelled()) {
                        if (@hasDecl(Source, "endPass")) source.endPass(error.RequestCancelled);
                        self.finish(.idle);
                        return .done;
                    }
                    if (@hasDecl(Source, "setMetadataParent")) source.setMetadataParent(operation.link());
                    if (@hasDecl(Source, "beginPass")) source.beginPass(&operation.cancel) catch |err| {
                        self.finish(.{ .failed = err });
                        return .done;
                    };
                    var builder: Self = .{
                        .allocator = operation.allocator,
                        .source = source,
                        .max_depth = operation.max_depth,
                        .max_count = operation.max_count,
                        .executor = operation.executor,
                        .attempt = operation.attempt,
                        .observation = operation.observation,
                        .app_context = operation.app_context,
                        .cancel = &operation.cancel,
                        .parent_link = operation.link(),
                        .visit = operation.visit,
                        .visit_path = self.path,
                    };
                    const executed = self.execute(&builder);
                    const failure: ?anyerror = if (executed) |_| null else |err| err;
                    if (@hasDecl(Source, "endPass")) source.endPass(failure);
                    if (executed) |result| {
                        operation.attempt.mergeDiagnostics(builder.diagnostics);
                        self.finish(result);
                        return .done;
                    } else |err| {
                        if (err == error.PendingReadIo) return .suspended;
                        operation.attempt.mergeDiagnostics(builder.diagnostics);
                        self.finish(.{ .failed = err });
                        return .done;
                    }
                }

                fn execute(self: *JobState, builder: *Self) anyerror!Result {
                    const operation = self.operation;
                    const source = self.source.?;
                    if (operation.mode == .discover) return .{ .discovered = try source.moduleType(self.address) };
                    const bytes = if (self.known_type) |kind|
                        try builder.nodeTyped(self.address, operation.message, operation.depth, kind)
                    else
                        try builder.node(self.address, operation.message, operation.depth);
                    if (operation.cancel.load(.acquire)) {
                        operation.allocator.free(bytes);
                        return .idle;
                    }
                    if (operation.mode == .root) return .{ .verified = .{ .index = self.index, .bytes = bytes, .gas = null } };
                    const verified = (if (@hasDecl(Source, "verifyCandidate")) source.verifyCandidate(self.address, operation.message, bytes) else priced: {
                        break :priced verificationResult(source.verify(self.address, operation.message, bytes));
                    }) catch |err| {
                        operation.allocator.free(bytes);
                        if (err != error.PendingReadIo) builder.diagnostics.verificationFailure(err);
                        return err;
                    };
                    if (!verified.valid) {
                        operation.allocator.free(bytes);
                        builder.diagnostics.verificationFailure(error.VerifyRejected);
                        return error.VerifyRejected;
                    }
                    if (!operation.executor.reserveOutput(bytes.len)) {
                        operation.allocator.free(bytes);
                        return error.MetadataOutputBudgetExceeded;
                    }
                    return .{ .verified = .{ .index = self.index, .bytes = bytes, .gas = verified.cost, .reserved = true } };
                }
            };

            allocator: std.mem.Allocator,
            executor: *metadata_parallel.Executor,
            attempt: *Attempt,
            visit: *VisitMemo,
            observation: ?Observation,
            app_context: []u8,
            mode: Mode,
            depth: usize,
            max_depth: usize,
            max_count: usize,
            message: protocol.Message,
            jobs: []JobState,
            scheduled: usize = 0,
            finished: usize = 0,
            references: std.atomic.Value(usize) = std.atomic.Value(usize).init(1),
            cancel: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
            parent_cancel: ?*const std.atomic.Value(bool) = null,
            parent_link: ?metadata_parallel.CancelLink = null,
            mutex: std.Thread.Mutex = .{},
            changed: std.Thread.Condition = .{},
            stopped: bool = false,
            completion_head: ?*JobState = null,
            completion_tail: ?*JobState = null,

            fn create(allocator: std.mem.Allocator, executor: *metadata_parallel.Executor, attempt: *Attempt, parent_visit: ?*VisitMemo, parent_path: metadata_parallel.VisitPath, mode: Mode, depth: usize, max_depth: usize, max_count: usize, message: protocol.Message, addresses: []const ModuleAddress, indices: ?[]const usize, known_types: ?[]const ?ModuleType, observation: ?Observation, app_context: []const u8, parent_link: ?metadata_parallel.CancelLink) !*Operation {
                _ = try parent_path.child(0);
                const visit = if (parent_visit) |parent| blk: {
                    parent.retain();
                    break :blk parent;
                } else try VisitMemo.create(allocator);
                errdefer visit.release();
                const self = try allocator.create(Operation);
                errdefer allocator.destroy(self);
                const body = try allocator.dupe(u8, message.body);
                errdefer allocator.free(body);
                const owned_app_context = try allocator.dupe(u8, app_context);
                errdefer allocator.free(owned_app_context);
                const jobs = try allocator.alloc(JobState, addresses.len);
                errdefer allocator.free(jobs);
                var owned_message = message;
                owned_message.body = body;
                self.* = .{
                    .allocator = allocator,
                    .executor = executor,
                    .attempt = attempt,
                    .visit = visit,
                    .observation = observation,
                    .app_context = owned_app_context,
                    .mode = mode,
                    .depth = depth,
                    .max_depth = max_depth,
                    .max_count = max_count,
                    .message = owned_message,
                    .jobs = jobs,
                    .parent_link = parent_link,
                };
                if (parent_link) |link_value| link_value.retain();
                attempt.retain();
                for (jobs, addresses, 0..) |*job, address, index| job.* = .{
                    .operation = self,
                    .address = address,
                    .index = if (indices) |values| values[index] else index,
                    .known_type = if (known_types) |values| values[index] else null,
                    .path = parent_path.child(@intCast(if (indices) |values| values[index] else index)) catch unreachable,
                };
                return self;
            }

            fn parentCancelled(self: *Operation) bool {
                // stop() and this read synchronize detachment of a borrowed
                // caller flag. Never read that flag after stop() has returned.
                self.mutex.lock();
                const already_cancelled = self.cancel.load(.acquire);
                const external_cancelled = if (self.parent_cancel) |flag| flag.load(.acquire) else false;
                self.mutex.unlock();
                if (already_cancelled) return true;
                const ancestor_cancelled = if (self.parent_link) |link_value| link_value.poll() else false;
                if (external_cancelled or ancestor_cancelled) {
                    self.stop();
                    return true;
                }
                return false;
            }

            fn link(self: *Operation) metadata_parallel.CancelLink {
                return .{ .context = self, .poll_fn = pollLinked, .retain_fn = retainLinked, .release_fn = releaseLinked };
            }
            fn pollLinked(context: *anyopaque) bool {
                const self: *Operation = @ptrCast(@alignCast(context));
                return self.parentCancelled();
            }
            fn retainLinked(context: *anyopaque) void {
                const self: *Operation = @ptrCast(@alignCast(context));
                self.retain();
            }
            fn releaseLinked(context: *anyopaque) void {
                const self: *Operation = @ptrCast(@alignCast(context));
                self.release();
            }

            fn start(self: *Operation, source: *Source) !void {
                if (self.parentCancelled()) return error.RequestCancelled;
                errdefer self.stop();
                for (self.jobs) |*job| {
                    job.source = try source.fork(self.allocator, &self.cancel);
                    self.retain();
                    self.executor.submit(&job.job) catch |err| {
                        self.release();
                        self.stop();
                        return err;
                    };
                    self.scheduled += 1;
                }
            }

            fn retain(self: *Operation) void {
                _ = self.references.fetchAdd(1, .acq_rel);
            }

            fn release(self: *Operation) void {
                if (self.references.fetchSub(1, .acq_rel) != 1) return;
                for (self.jobs) |*job| {
                    job.closeSource();
                    self.freeResult(job.result);
                }
                self.attempt.release();
                self.visit.release();
                self.allocator.free(self.app_context);
                self.allocator.free(self.message.body);
                self.allocator.free(self.jobs);
                const parent_link = self.parent_link;
                self.allocator.destroy(self);
                if (parent_link) |link_value| link_value.release();
            }

            fn freeResult(self: *Operation, result: Result) void {
                switch (result) {
                    .verified => |candidate| {
                        if (candidate.reserved) self.executor.releaseOutput(candidate.bytes.len);
                        self.allocator.free(candidate.bytes);
                    },
                    else => {},
                }
            }

            fn complete(self: *Operation, job: *JobState, result: Result) void {
                self.mutex.lock();
                job.completed = true;
                self.finished += 1;
                const retain_result = !self.stopped and result != .idle;
                if (retain_result) {
                    job.result = result;
                    job.completion_next = null;
                    if (self.completion_tail) |tail| tail.completion_next = job else self.completion_head = job;
                    self.completion_tail = job;
                }
                self.mutex.unlock();
                self.changed.broadcast();
                if (!retain_result) self.freeResult(result);
            }

            fn stop(self: *Operation) void {
                self.mutex.lock();
                self.stopped = true;
                self.parent_cancel = null;
                self.cancel.store(true, .release);
                self.mutex.unlock();
                self.changed.broadcast();
            }

            fn wait(self: *Operation, expected: ?*JobState) !void {
                while (true) {
                    if (self.parentCancelled()) return error.RequestCancelled;
                    self.mutex.lock();
                    const ready = if (expected) |job| job.completed else self.completion_head != null or self.finished == self.scheduled;
                    self.mutex.unlock();
                    if (ready) return;
                    if (self.parentCancelled()) return error.RequestCancelled;
                    const assisted = if (expected) |job| self.executor.assistJob(&job.job) else self.executor.assist();
                    if (assisted) continue;
                    self.mutex.lock();
                    const still_waiting = if (expected) |job| !job.completed else self.completion_head == null and self.finished != self.scheduled;
                    if (still_waiting) self.changed.timedWait(&self.mutex, std.time.ns_per_ms) catch {};
                    self.mutex.unlock();
                }
            }

            fn next(self: *Operation) !?*JobState {
                while (true) {
                    if (self.parentCancelled()) return error.RequestCancelled;
                    self.mutex.lock();
                    if (self.completion_head) |job| {
                        self.completion_head = job.completion_next;
                        if (self.completion_head == null) self.completion_tail = null;
                        job.completion_next = null;
                        self.mutex.unlock();
                        return job;
                    }
                    const done = self.finished == self.scheduled;
                    self.mutex.unlock();
                    if (done) return null;
                    try self.wait(null);
                }
            }
        };

        allocator: std.mem.Allocator,
        source: *Source,
        max_depth: usize = 13,
        max_count: usize = 100,
        visited: usize = 0,
        diagnostics: Diagnostics = .{},
        observation: ?Observation = null,
        app_context: []const u8 = "",
        observation_started: bool = false,
        executor: ?*metadata_parallel.Executor = null,
        cancel: ?*const std.atomic.Value(bool) = null,
        parent_link: ?metadata_parallel.CancelLink = null,
        attempt: ?*Attempt = null,
        visit: ?*VisitMemo = null,
        visit_path: metadata_parallel.VisitPath = .{},

        pub fn build(self: *Self, address: ModuleAddress, message: protocol.Message) ![]u8 {
            if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            self.visited = 0;
            self.diagnostics = .{};
            self.observation_started = false;
            if (self.executor != null and self.attempt == null) {
                const attempt = try Attempt.create(self.allocator);
                self.attempt = attempt;
                defer {
                    attempt.mergeDiagnostics(self.diagnostics);
                    self.diagnostics = attempt.snapshotDiagnostics();
                    self.visited = attempt.visited.load(.acquire);
                    self.attempt = null;
                    attempt.release();
                }
                const kind = try self.source.moduleType(address);
                if (kind != .aggregation and @hasDecl(Source, "fork") and @hasDecl(Source, "deinitFork")) return self.buildRoot(address, message, kind);
                return self.nodeTyped(address, message, 0, kind);
            }
            return self.node(address, message, 0);
        }

        fn buildRoot(self: *Self, address: ModuleAddress, message: protocol.Message, kind: ModuleType) ![]u8 {
            const addresses = [_]ModuleAddress{address};
            const indices = [_]usize{0};
            const known = [_]?ModuleType{kind};
            const operation = try Operation.create(self.allocator, self.executor.?, self.attempt.?, null, self.visit_path, .root, 0, self.max_depth, self.max_count, message, &addresses, &indices, &known, self.observationBinding(), self.appContext(), self.parent_link);
            defer operation.release();
            operation.parent_cancel = self.cancel;
            try operation.start(self.source);
            defer operation.stop();
            const job = (try operation.next()) orelse return error.MetadataRootJobMissing;
            switch (job.result) {
                .verified => |candidate| {
                    job.result = .idle;
                    if (candidate.reserved) self.executor.?.releaseOutput(candidate.bytes.len);
                    return candidate.bytes;
                },
                .failed => |err| return err,
                else => return error.MetadataRootJobMissing,
            }
        }

        fn enter(self: *Self, depth: usize) !void {
            if (depth >= self.max_depth) return error.IsmDepthExceeded;
            if (self.attempt) |attempt| {
                if (self.visit) |visit| return visit.enter(attempt, self.visit_path, self.max_count);
                return attempt.enter(self.max_count);
            }
            if (self.visited >= self.max_count) return error.IsmCountExceeded;
            self.visited += 1;
        }

        fn node(self: *Self, address: ModuleAddress, message: protocol.Message, depth: usize) anyerror![]u8 {
            return self.nodeTyped(address, message, depth, try self.source.moduleType(address));
        }

        fn routing(self: *Self, address: ModuleAddress, message: protocol.Message, depth: usize) anyerror![]u8 {
            const next = try self.source.route(address, message);
            const previous = self.visit_path;
            self.visit_path = try previous.child(metadata_parallel.route_visit);
            defer self.visit_path = previous;
            return self.node(next, message, depth + 1);
        }

        fn publishLeaf(self: *Self, origin: u32, destination: u32, kind: ModuleType, success: bool) void {
            if (kind != .message_id_multisig and kind != .merkle_root_multisig and kind != .ccip_read) return;
            const observation = self.observationBinding() orelse return;
            const complete = observation.leaf_complete_fn orelse return;
            if (self.visit) |visit| if (!visit.recordLeaf(self.visit_path)) return;
            complete(observation.context, origin, destination, self.appContext(), @tagName(kind), success) catch {};
        }

        fn cancelled(self: *Self) bool {
            if (self.cancel) |flag| if (flag.load(.acquire)) return true;
            return if (self.parent_link) |link_value| link_value.poll() else false;
        }

        fn nodeTyped(self: *Self, address: ModuleAddress, message: protocol.Message, depth: usize, kind: ModuleType) anyerror![]u8 {
            if (self.cancelled()) return error.RequestCancelled;
            try self.enter(depth);
            const result = switch (kind) {
                .null_ism => self.allocator.alloc(u8, 0),
                .routing => self.routing(address, message, depth),
                .aggregation => self.aggregation(address, message, depth),
                .message_id_multisig => self.multisig(address, message, false),
                .merkle_root_multisig => self.multisig(address, message, true),
                .ccip_read => if (@hasDecl(Source, "ccipMetadata")) self.source.ccipMetadata(address, message) else error.UnsupportedIsmType,
                .composite => if (@hasDecl(Source, "compositeMetadata")) self.source.compositeMetadata(address, message) else error.UnsupportedIsmType,
                else => error.UnsupportedIsmType,
            };
            if (result) |bytes| {
                if (self.cancelled()) {
                    self.allocator.free(bytes);
                    return error.RequestCancelled;
                }
                self.publishLeaf(message.origin, message.destination, kind, true);
                return bytes;
            } else |err| {
                if (self.cancelled()) return error.RequestCancelled;
                if (err != error.PendingReadIo and err != error.PendingIo and err != error.RequestCancelled and err != error.Cancelled) self.publishLeaf(message.origin, message.destination, kind, false);
                return err;
            }
        }

        fn freeCandidate(self: *Self, candidate: Candidate) void {
            if (candidate.reserved) if (self.executor) |executor| executor.releaseOutput(candidate.bytes.len);
            self.allocator.free(candidate.bytes);
        }

        fn formatAggregation(self: *Self, candidates: []Candidate, threshold: usize, ism_count: usize) ![]u8 {
            const unpriced = for (candidates) |candidate| {
                if (candidate.gas == null) break true;
            } else false;
            std.mem.sort(Candidate, candidates, unpriced, struct {
                fn less(preserve_order: bool, left: Candidate, right: Candidate) bool {
                    if (preserve_order) return left.index < right.index;
                    return left.gas.? < right.gas.? or (left.gas.? == right.gas.? and left.index < right.index);
                }
            }.less);
            const parts = try self.allocator.alloc(?[]const u8, ism_count);
            defer self.allocator.free(parts);
            @memset(parts, null);
            var length = try std.math.mul(usize, parts.len, 8);
            for (candidates[0..threshold]) |candidate| {
                parts[candidate.index] = candidate.bytes;
                length = try std.math.add(usize, length, candidate.bytes.len);
            }
            const out = try self.allocator.alloc(u8, length);
            errdefer self.allocator.free(out);
            _ = try protocol.metadata.encodeAggregation(parts, out);
            return out;
        }

        fn aggregation(self: *Self, address: ModuleAddress, message: protocol.Message, depth: usize) ![]u8 {
            const members = try self.source.members(address, message, false);
            defer self.allocator.free(members.addresses);
            if (members.threshold == 0 or members.threshold > members.addresses.len or members.addresses.len > self.max_count) return error.InvalidIsmThreshold;
            if (self.executor != null) {
                if (!@hasDecl(Source, "fork") or !@hasDecl(Source, "deinitFork")) return error.SourceForkUnsupported;
                return self.aggregationParallel(message, depth, members.addresses, members.threshold);
            }
            return self.aggregationSerial(message, depth, members.addresses, members.threshold);
        }

        fn aggregationSerial(self: *Self, message: protocol.Message, depth: usize, addresses: []const ModuleAddress, threshold: usize) ![]u8 {
            var candidates: std.ArrayList(Candidate) = .empty;
            defer {
                for (candidates.items) |candidate| self.freeCandidate(candidate);
                candidates.deinit(self.allocator);
            }
            var all_errors_awaiting = true;
            var any_pending = false;
            var failures: usize = 0;
            for (addresses, 0..) |child, index| {
                const bytes = self.node(child, message, depth + 1) catch |err| switch (err) {
                    error.IsmDepthExceeded, error.IsmCountExceeded => return err,
                    error.CcipReadPending => {
                        any_pending = true;
                        all_errors_awaiting = false;
                        failures += 1;
                        continue;
                    },
                    error.AwaitingValidatorSignatures => {
                        failures += 1;
                        continue;
                    },
                    else => {
                        if (hardFailure(err)) return err;
                        all_errors_awaiting = false;
                        failures += 1;
                        continue;
                    },
                };
                const verification = (if (@hasDecl(Source, "verifyCandidate")) self.source.verifyCandidate(child, message, bytes) else priced: {
                    break :priced verificationResult(self.source.verify(child, message, bytes));
                }) catch |err| {
                    self.allocator.free(bytes);
                    if (hardFailure(err)) return err;
                    if (err == error.CcipReadPending) any_pending = true;
                    self.diagnostics.verificationFailure(err);
                    all_errors_awaiting = false;
                    failures += 1;
                    continue;
                };
                if (!verification.valid) {
                    self.allocator.free(bytes);
                    self.diagnostics.verificationFailure(error.VerifyRejected);
                    all_errors_awaiting = false;
                    failures += 1;
                    continue;
                }
                candidates.append(self.allocator, .{ .index = index, .bytes = bytes, .gas = verification.cost }) catch |err| {
                    self.allocator.free(bytes);
                    return err;
                };
            }
            if (candidates.items.len < threshold) {
                if (any_pending) return error.CcipReadPending;
                if (failures > 0 and all_errors_awaiting) return error.AwaitingValidatorSignatures;
                return error.AggregationThresholdNotMet;
            }
            return self.formatAggregation(candidates.items, threshold, addresses.len);
        }

        fn fatalParallelError(err: anyerror) bool {
            return hardFailure(err) or err == error.IsmDepthExceeded or err == error.IsmCountExceeded or err == error.MetadataExecutorSaturated or err == error.MetadataExecutorStopped or err == error.MetadataOutputBudgetExceeded;
        }

        fn aggregationParallel(self: *Self, message: protocol.Message, depth: usize, addresses: []const ModuleAddress, threshold: usize) ![]u8 {
            if (threshold == 1) {
                const discovered = try self.discover(message, depth, addresses);
                defer self.allocator.free(discovered.types);
                if (discovered.message_id_index) |index| {
                    if (try self.buildFastPath(message, depth, addresses[index], index, addresses.len)) |bytes| return bytes;
                }
                return self.buildGeneral(message, depth, addresses, threshold, discovered.types);
            }
            return self.buildGeneral(message, depth, addresses, threshold, null);
        }

        const Discovery = struct { types: []?ModuleType, message_id_index: ?usize };

        fn discover(self: *Self, message: protocol.Message, depth: usize, addresses: []const ModuleAddress) !Discovery {
            const types = try self.allocator.alloc(?ModuleType, addresses.len);
            errdefer self.allocator.free(types);
            @memset(types, null);
            const operation = try Operation.create(self.allocator, self.executor.?, self.attempt.?, self.visit, self.visit_path, .discover, depth + 1, self.max_depth, self.max_count, message, addresses, null, null, self.observationBinding(), self.appContext(), self.parent_link);
            defer operation.release();
            operation.parent_cancel = self.cancel;
            try operation.start(self.source);
            defer operation.stop();
            var selected: ?usize = null;
            for (operation.jobs, 0..) |*job, index| {
                try operation.wait(job);
                switch (job.result) {
                    .discovered => |kind| {
                        types[index] = kind;
                        if (kind == .message_id_multisig) {
                            selected = index;
                            break;
                        }
                    },
                    .failed => |err| if (fatalParallelError(err)) return err,
                    else => {},
                }
            }
            return .{ .types = types, .message_id_index = selected };
        }

        fn buildFastPath(self: *Self, message: protocol.Message, depth: usize, address: ModuleAddress, index: usize, ism_count: usize) !?[]u8 {
            const addresses = [_]ModuleAddress{address};
            const indices = [_]usize{index};
            const known = [_]?ModuleType{.message_id_multisig};
            const path = try self.visit_path.child(metadata_parallel.fast_visit);
            const operation = try Operation.create(self.allocator, self.executor.?, self.attempt.?, self.visit, path, .build, depth + 1, self.max_depth, self.max_count, message, &addresses, &indices, &known, self.observationBinding(), self.appContext(), self.parent_link);
            defer operation.release();
            operation.parent_cancel = self.cancel;
            try operation.start(self.source);
            defer operation.stop();
            const job = (try operation.next()) orelse return null;
            switch (job.result) {
                .verified => |candidate| {
                    job.result = .idle;
                    defer self.freeCandidate(candidate);
                    var candidates = [_]Candidate{candidate};
                    return try self.formatAggregation(&candidates, 1, ism_count);
                },
                .failed => |err| {
                    if (fatalParallelError(err)) return err;
                    return null;
                },
                else => return null,
            }
        }

        fn buildGeneral(self: *Self, message: protocol.Message, depth: usize, addresses: []const ModuleAddress, threshold: usize, known_types: ?[]const ?ModuleType) ![]u8 {
            const candidates = try self.allocator.alloc(Candidate, addresses.len);
            defer self.allocator.free(candidates);
            var candidate_count: usize = 0;
            defer for (candidates[0..candidate_count]) |candidate| self.freeCandidate(candidate);
            const path = try self.visit_path.child(metadata_parallel.general_visit);
            const operation = try Operation.create(self.allocator, self.executor.?, self.attempt.?, self.visit, path, .build, depth + 1, self.max_depth, self.max_count, message, addresses, null, known_types, self.observationBinding(), self.appContext(), self.parent_link);
            defer operation.release();
            operation.parent_cancel = self.cancel;
            try operation.start(self.source);
            defer operation.stop();
            var all_errors_awaiting = true;
            var any_pending = false;
            var failures: usize = 0;
            while (try operation.next()) |job| {
                switch (job.result) {
                    .verified => |candidate| {
                        job.result = .idle;
                        candidates[candidate_count] = candidate;
                        candidate_count += 1;
                        if (candidate_count == threshold) return self.formatAggregation(candidates[0..candidate_count], threshold, addresses.len);
                    },
                    .failed => |err| {
                        if (fatalParallelError(err)) return err;
                        if (err == error.CcipReadPending) any_pending = true;
                        failures += 1;
                        if (err != error.AwaitingValidatorSignatures) all_errors_awaiting = false;
                    },
                    else => {},
                }
            }
            if (any_pending) return error.CcipReadPending;
            if (failures > 0 and all_errors_awaiting) return error.AwaitingValidatorSignatures;
            return error.AggregationThresholdNotMet;
        }

        fn observationBinding(self: *Self) ?Observation {
            if (@hasField(Source, "observation")) if (self.source.observation) |value| return value;
            return self.observation;
        }

        fn appContext(self: *Self) []const u8 {
            if (@hasField(Source, "app_context")) if (self.source.app_context) |value| return value;
            return self.app_context;
        }

        fn publishObservation(self: *Self, origin: u32, destination: u32, validators: []const Address, latest: []const ?u32) void {
            const observation = self.observationBinding() orelse return;
            if (self.visit) |visit| if (!visit.claimObservation(self.visit_path)) return;
            observation.latest_fn(observation.context, origin, destination, self.appContext(), validators, latest) catch {};
        }

        fn startObservation(self: *Self, origin: u32, destination: u32, validators: []const Address) anyerror!void {
            const observation = self.observationBinding() orelse return;
            const executor = self.executor orelse {
                var latest: [256]?u32 = @splat(null);
                if (@hasDecl(Source, "fetchLatestIndices")) {
                    var errors: usize = 0;
                    self.source.fetchLatestIndices(validators, latest[0..validators.len], &errors) catch return;
                } else if (@hasDecl(Source, "latestIndex")) {
                    for (validators, 0..) |validator, index| latest[index] = self.source.latestIndex(validator) catch null;
                } else return;
                self.publishObservation(origin, destination, validators, latest[0..validators.len]);
                return;
            };
            if (!@hasDecl(Source, "fork") or !@hasDecl(Source, "deinitFork")) return;
            if (self.visit) |visit| {
                if (!visit.claimObservation(self.visit_path)) return;
            } else {
                if (self.observation_started) return;
                self.observation_started = true;
            }
            errdefer if (self.visit) |visit| {
                visit.resetObservation(self.visit_path);
            } else {
                self.observation_started = false;
            };
            const Job = ObservationJob(Source);
            const job = try self.allocator.create(Job);
            errdefer self.allocator.destroy(job);
            const app_context = try self.allocator.dupe(u8, self.appContext());
            errdefer self.allocator.free(app_context);
            const owned_validators = try self.allocator.dupe(Address, validators);
            errdefer self.allocator.free(owned_validators);
            job.* = .{
                .allocator = self.allocator,
                .source = undefined,
                .observation = observation,
                .origin = origin,
                .destination = destination,
                .app_context = app_context,
                .validators = owned_validators,
                .cancel = executor.stopToken(),
            };
            const source = try self.source.fork(self.allocator, job.cancel);
            errdefer source.deinitFork();
            if (@hasDecl(Source, "setMetadataParent")) source.setMetadataParent(null);
            job.source = source;
            // On rejection the scoped errdefers still own all four resources.
            // On success the queued job takes them and destroys them once.
            try executor.submit(&job.job);
        }

        fn fetchAt(self: *Self, validators: []const Address, threshold: usize, index: u32) !?quorum.Quorum {
            if (@hasDecl(Source, "parallel_quorum")) {
                if (Source.parallel_quorum) return self.source.fetchQuorum(self.allocator, validators, threshold, index, &self.diagnostics.storage_errors);
            } else if (@hasDecl(Source, "fetchQuorum")) return self.source.fetchQuorum(self.allocator, validators, threshold, index, &self.diagnostics.storage_errors);
            var collector = try quorum.Collector.init(self.allocator, validators, threshold, index, .standard);
            for (validators, 0..) |validator, validator_index| {
                const signed = (self.source.fetchCheckpoint(validator, index) catch |err| {
                    if (hardFailure(err)) return err;
                    self.diagnostics.storage_errors += 1;
                    continue;
                }) orelse continue;
                if (try collector.push(.{ .validator_index = validator_index, .signed = signed })) |result| return result;
            }
            return null;
        }

        fn multisig(self: *Self, address: ModuleAddress, message: protocol.Message, with_proof: bool) ![]u8 {
            const members = try self.source.members(address, message, true);
            defer self.allocator.free(members.addresses);
            if (members.threshold == 0 or members.threshold > members.addresses.len or members.addresses.len > 256) return error.InvalidIsmThreshold;
            const leaf_index = (try self.source.leafIndex(message.id())) orelse return error.MessageNotInMerkleTree;
            var selected: ?quorum.Quorum = null;
            if (!with_proof) {
                // Rust joins the latest read but deliberately ignores its
                // result. Optional observation allocation/queue/storage limits
                // must likewise never veto an otherwise valid exact quorum.
                self.startObservation(message.origin, message.destination, members.addresses) catch |err| switch (err) {
                    error.RequestCancelled, error.Cancelled, error.MetadataExecutorStopped => return err,
                    else => {},
                };
                selected = try self.fetchAt(members.addresses, members.threshold, leaf_index);
            } else {
                const highest = (try self.source.highestKnownLeafIndex()) orelse return error.MessageNotInMerkleTree;
                var latest: [256]?u32 = @splat(null);
                if (@hasDecl(Source, "parallel_latest") and Source.parallel_latest) {
                    try self.source.fetchLatestIndices(members.addresses, latest[0..members.addresses.len], &self.diagnostics.storage_errors);
                } else {
                    for (members.addresses, 0..) |validator, i| {
                        latest[i] = self.source.latestIndex(validator) catch |err| {
                            if (hardFailure(err)) return err;
                            self.diagnostics.storage_errors += 1;
                            continue;
                        };
                    }
                }
                self.publishObservation(message.origin, message.destination, members.addresses, latest[0..members.addresses.len]);
                var index = (try quorum.rangeStart(latest[0..members.addresses.len], members.threshold, leaf_index, highest)) orelse return error.AwaitingValidatorSignatures;
                while (true) {
                    selected = self.fetchAt(members.addresses, members.threshold, index) catch |err| switch (err) {
                        error.InconsistentCheckpoints => null,
                        else => return err,
                    };
                    if (selected != null or index == leaf_index) break;
                    index -= 1;
                }
            }
            var signed = selected orelse {
                self.diagnostics.awaiting_signatures += 1;
                return error.AwaitingValidatorSignatures;
            };
            defer signed.deinit();
            if (signed.checkpoint.mailbox_domain != message.origin) return error.WrongCheckpointOrigin;
            const signatures = try self.allocator.alloc(u8, signed.signatures.len * 65);
            defer self.allocator.free(signatures);
            for (signed.signatures, 0..) |signature, i| signatures[i * 65 ..][0..65].* = signature.bytes();
            if (!with_proof) {
                if (!std.mem.eql(u8, &signed.checkpoint.message_id, &message.id())) return error.WrongCheckpointMessageId;
                const out = try self.allocator.alloc(u8, protocol.metadata.MessageIdMultisig.prefix_len + signatures.len);
                errdefer self.allocator.free(out);
                const metadata: protocol.metadata.MessageIdMultisig = .{ .hook = signed.checkpoint.merkle_tree_hook_address, .root = signed.checkpoint.root, .index = signed.checkpoint.index, .signatures = signatures };
                _ = try metadata.encode(out);
                return out;
            }
            const proof = try self.source.proof(leaf_index, signed.checkpoint);
            if (!std.mem.eql(u8, &proof.leaf, &message.id()) or proof.index != leaf_index or !proof.verify(signed.checkpoint.root)) return error.InvalidMerkleProof;
            const out = try self.allocator.alloc(u8, protocol.metadata.MerkleRootMultisig.prefix_len + signatures.len);
            errdefer self.allocator.free(out);
            const metadata: protocol.metadata.MerkleRootMultisig = .{ .hook = signed.checkpoint.merkle_tree_hook_address, .message_index = leaf_index, .signed_message_id = signed.checkpoint.message_id, .proof = proof.path, .signed_index = signed.checkpoint.index, .signatures = signatures };
            _ = try metadata.encode(out);
            return out;
        }
    };
}

fn ObservationJob(comptime Source: type) type {
    return struct {
        const Self = @This();
        job: metadata_parallel.Job = .{ .run_fn = run },
        allocator: std.mem.Allocator,
        source: *Source,
        observation: Observation,
        origin: u32,
        destination: u32,
        app_context: []u8,
        validators: []Address,
        latest: [256]?u32 = @splat(null),
        cancel: *const std.atomic.Value(bool),

        fn deinit(self: *Self) void {
            self.source.deinitFork();
            self.allocator.free(self.app_context);
            self.allocator.free(self.validators);
            self.allocator.destroy(self);
        }

        fn collect(self: *Self) !void {
            if (@hasDecl(Source, "fetchLatestIndices")) {
                var errors: usize = 0;
                return self.source.fetchLatestIndices(self.validators, self.latest[0..self.validators.len], &errors);
            }
            if (@hasDecl(Source, "latestIndex")) {
                var errors: usize = 0;
                for (self.validators, 0..) |validator, index| self.latest[index] = self.source.latestIndex(validator) catch |err| {
                    if (hardFailure(err)) return err;
                    errors += 1;
                    self.latest[index] = null;
                };
                return;
            }
            return error.UnsupportedObservationSource;
        }

        fn run(job: *metadata_parallel.Job) metadata_parallel.RunResult {
            const self: *Self = @alignCast(@fieldParentPtr("job", job));
            if (self.cancel.load(.acquire)) {
                self.deinit();
                return .done;
            }
            if (@hasDecl(Source, "beginPass")) self.source.beginPass(self.cancel) catch {
                self.deinit();
                return .done;
            };
            const result = self.collect();
            const failure: ?anyerror = if (result) |_| null else |err| err;
            if (@hasDecl(Source, "endPass")) self.source.endPass(failure);
            if (failure) |err| {
                if (err == error.PendingReadIo) return .suspended;
                self.deinit();
                return .done;
            }
            if (!self.cancel.load(.acquire)) self.observation.latest_fn(self.observation.context, self.origin, self.destination, self.app_context, self.validators, self.latest[0..self.validators.len]) catch {};
            self.deinit();
            return .done;
        }
    };
}

fn verificationResult(cost: anyerror!u256) !Verification {
    return .{ .valid = true, .cost = try cost };
}

const TestSource = struct {
    allocator: std.mem.Allocator,
    cycle: bool = false,
    invalid_child: bool = false,
    unpriced: bool = false,
    reverse_prices: bool = false,
    reject_candidate: bool = false,
    pending_child: bool = false,
    node_error: ?anyerror = null,
    verify_error: ?anyerror = null,
    checkpoint_error: ?anyerror = null,
    checkpoint_mode: bool = false,
    pub fn moduleType(self: *TestSource, address: Address) !ModuleType {
        if (self.checkpoint_mode) return .message_id_multisig;
        if (address[19] == 1) if (self.node_error) |err| return err;
        if (self.cycle) return .routing;
        return switch (address[19]) {
            0 => .aggregation,
            1 => .null_ism,
            2 => if (self.pending_child) .ccip_read else .null_ism,
            3 => .routing,
            else => error.UnsupportedIsmType,
        };
    }
    pub fn route(_: *TestSource, address: Address, _: protocol.Message) !Address {
        return address;
    }
    pub fn members(self: *TestSource, _: Address, _: protocol.Message, _: bool) !Members {
        const addresses = try self.allocator.alloc(Address, 2);
        addresses[0] = @splat(0);
        addresses[0][19] = 1;
        addresses[1] = @splat(0);
        addresses[1][19] = 2;
        return .{ .addresses = addresses, .threshold = 1 };
    }
    pub fn verify(self: *TestSource, address: Address, _: protocol.Message, _: []const u8) !u256 {
        if (address[19] == 1) if (self.verify_error) |err| return err;
        if (self.invalid_child and address[19] == 1) return error.VerifyRejected;
        return if ((address[19] == 1) != self.reverse_prices) 50 else 100;
    }
    pub fn verifyCandidate(self: *TestSource, address: Address, message: protocol.Message, bytes: []const u8) !Verification {
        if (self.reject_candidate and address[19] == 1) return .{ .valid = false };
        const cost = try self.verify(address, message, bytes);
        return .{ .valid = true, .cost = if (self.unpriced) null else cost };
    }
    pub fn ccipMetadata(_: *TestSource, _: Address, _: protocol.Message) ![]u8 {
        return error.CcipReadPending;
    }
    pub fn leafIndex(self: *TestSource, _: [32]u8) !?u32 {
        return if (self.checkpoint_mode) 0 else null;
    }
    pub fn highestKnownLeafIndex(_: *TestSource) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(self: *TestSource, _: Address, _: u32) !?objects.SignedCheckpoint {
        if (self.checkpoint_error) |err| return err;
        return null;
    }
    pub fn latestIndex(_: *TestSource, _: Address) !?u32 {
        return null;
    }
    pub fn proof(_: *TestSource, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
};

test "aggregation chooses cheapest verified child and preserves present empty metadata" {
    var source: TestSource = .{ .allocator = std.testing.allocator };
    var builder: Builder(TestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    const bytes = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(bytes);
    const aggregation = try protocol.metadata.Aggregation.decode(bytes, 2);
    try std.testing.expectEqual(@as(usize, 0), (try aggregation.metadataAt(0)).?.len);
    try std.testing.expectEqual(@as(?[]const u8, null), try aggregation.metadataAt(1));
    source.invalid_child = true;
    const fallback = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(fallback);
    const alternate = try protocol.metadata.Aggregation.decode(fallback, 2);
    try std.testing.expectEqual(@as(?[]const u8, null), try alternate.metadataAt(0));
    try std.testing.expectEqual(@as(usize, 0), (try alternate.metadataAt(1)).?.len);
    try std.testing.expectEqual(@as(usize, 1), builder.diagnostics.verification_failures);
}

test "recursive routing and cumulative ISM counts fail at the configured boundary" {
    var source: TestSource = .{ .allocator = std.testing.allocator, .cycle = true };
    var builder: Builder(TestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    try std.testing.expectError(error.IsmDepthExceeded, builder.build(@splat(0), message));
    source.cycle = false;
    builder.max_count = 2;
    try std.testing.expectError(error.IsmCountExceeded, builder.build(@splat(0), message));
}

test "aggregation preserves module order when verification is unpriced and rejects false verification" {
    var source: TestSource = .{ .allocator = std.testing.allocator, .reverse_prices = true };
    var builder: Builder(TestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    const priced = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(priced);
    const cheap_second = try protocol.metadata.Aggregation.decode(priced, 2);
    try std.testing.expect((try cheap_second.metadataAt(0)) == null);
    try std.testing.expect((try cheap_second.metadataAt(1)) != null);
    source.unpriced = true;
    const unpriced = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(unpriced);
    const original_order = try protocol.metadata.Aggregation.decode(unpriced, 2);
    try std.testing.expect((try original_order.metadataAt(0)) != null);
    try std.testing.expect((try original_order.metadataAt(1)) == null);
    source.reject_candidate = true;
    const rejected = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(rejected);
    const verified_second = try protocol.metadata.Aggregation.decode(rejected, 2);
    try std.testing.expect((try verified_second.metadataAt(0)) == null);
    try std.testing.expect((try verified_second.metadataAt(1)) != null);
    try std.testing.expectEqual(@as(usize, 1), builder.diagnostics.verification_failures);
}

test "CCIP pending is terminal only without threshold and never masks healthy metadata or refusal" {
    var source: TestSource = .{ .allocator = std.testing.allocator, .pending_child = true };
    var builder: Builder(TestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .origin = 1, .destination = 2 };
    source.reject_candidate = true;
    try std.testing.expectError(error.CcipReadPending, builder.build(@splat(0), message));
    source.node_error = error.MessageMetadataRefused;
    try std.testing.expectError(error.MessageMetadataRefused, builder.build(@splat(0), message));
    source.node_error = null;
    source.reject_candidate = false;
    const encoded = try builder.build(@splat(0), message);
    defer std.testing.allocator.free(encoded);
}

test "metadata refusals cancellation and pending IO propagate across optional branches and serial checkpoints" {
    var source: TestSource = .{ .allocator = std.testing.allocator };
    var builder: Builder(TestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    for ([_]anyerror{ error.ValidatorReorg, error.ReorgHalted, error.ReorgFlagPresent, error.RequestCancelled, error.Cancelled, error.PendingReadIo, error.PendingIo, error.MessageMetadataRefused }) |err| {
        source.node_error = err;
        try std.testing.expectError(err, builder.build(@splat(0), message));
        source.node_error = null;
        source.verify_error = err;
        try std.testing.expectError(err, builder.build(@splat(0), message));
        source.verify_error = null;
        source.checkpoint_mode = true;
        source.checkpoint_error = err;
        try std.testing.expectError(err, builder.build(@splat(0), message));
        source.checkpoint_mode = false;
        source.checkpoint_error = null;
    }
}

const FeltTestSource = struct {
    pub const ModuleAddress = [32]u8;
    allocator: std.mem.Allocator,
    pub fn moduleType(_: *FeltTestSource, address: ModuleAddress) !ModuleType {
        if (address[0] != 7) return error.TruncatedModuleAddress;
        return switch (address[31]) {
            0 => .aggregation,
            1 => .null_ism,
            3 => .routing,
            else => error.UnexpectedModule,
        };
    }
    pub fn route(_: *FeltTestSource, address: ModuleAddress, _: protocol.Message) !ModuleAddress {
        var result = address;
        result[31] = 0;
        return result;
    }
    pub fn members(self: *FeltTestSource, _: ModuleAddress, _: protocol.Message, comptime validators: bool) !ModuleMembers(if (validators) Address else ModuleAddress) {
        const A = if (validators) Address else ModuleAddress;
        const addresses = try self.allocator.alloc(A, 1);
        addresses[0] = @splat(0);
        addresses[0][0] = 7;
        addresses[0][@sizeOf(A) - 1] = 1;
        return .{ .addresses = addresses, .threshold = 1 };
    }
    pub fn verify(_: *FeltTestSource, address: ModuleAddress, _: protocol.Message, _: []const u8) !u256 {
        if (address[0] != 7) return error.TruncatedModuleAddress;
        return 1;
    }
    pub fn leafIndex(_: *FeltTestSource, _: [32]u8) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *FeltTestSource) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *FeltTestSource, _: Address, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *FeltTestSource, _: Address) !?u32 {
        return null;
    }
    pub fn proof(_: *FeltTestSource, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
};

test "routing aggregation preserve full felt module addresses while validators stay Ethereum addresses" {
    var source: FeltTestSource = .{ .allocator = std.testing.allocator };
    var builder: Builder(FeltTestSource) = .{ .allocator = std.testing.allocator, .source = &source };
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    var address: FeltTestSource.ModuleAddress = @splat(0);
    address[0] = 7;
    address[31] = 3;
    const encoded = try builder.build(address, message);
    defer std.testing.allocator.free(encoded);
    const aggregation = try protocol.metadata.Aggregation.decode(encoded, 1);
    try std.testing.expectEqual(@as(usize, 0), (try aggregation.metadataAt(0)).?.len);
}

test {
    _ = @import("../metadata_parallel_delegated_tests.zig");
    _ = @import("../agents/metadata_session_test.zig");
    _ = @import("evm_source_cache_tests.zig");
}
