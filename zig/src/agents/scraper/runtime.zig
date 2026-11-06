//! One bounded source/store cycle per chain. Existing confirmed pages can publish
//! while log retrieval fails; incomplete or unavailable counts never prove a tail.
const std = @import("std");
const src = @import("source.zig");
const pipeline = @import("pipeline.zig");
pub const Options = struct { period: src.Period, chunk_size: u64, poll_ms: u64 = 5000, critical_failure_grace_ms: u64 = 60000 };
pub const Outcome = struct { more: bool, ingestion_failed: bool, ingestion_error: ?anyerror = null, indexed: u64, confirmed: u64, published: [4]u64 };
pub const FailureStreak = struct {
    since_ms: ?u64 = null,
    pub fn record(self: *FailureStreak, failed: bool, now_ms: u64, grace_ms: u64) bool {
        if (!failed) {
            self.since_ms = null;
            return false;
        }
        if (self.since_ms == null) self.since_ms = now_ms;
        return now_ms -| self.since_ms.? >= grace_ms;
    }
    pub fn retryDelay(self: FailureStreak, now_ms: u64, poll_ms: u64, grace_ms: u64) u64 {
        const since = self.since_ms orelse return poll_ms;
        const remaining = grace_ms -| (now_ms -| since);
        return if (remaining == 0) poll_ms else @min(poll_ms, remaining);
    }
};
pub fn Worker(comptime Store: type) type {
    return struct {
        allocator: std.mem.Allocator,
        source: src.Source,
        store: *Store,
        options: Options,
        cache: pipeline.CountCache = .{},
        failures: FailureStreak = .{},
        pub fn cycle(self: *@This()) !Outcome {
            if (self.options.chunk_size == 0) return error.InvalidScraperChunk;
            const lease = pipeline.confirmationLease(self.options.poll_ms);
            try self.store.claim(lease);
            try self.source.beginCycle();
            var observed = pipeline.observe(self.source, self.store) catch |err| {
                try self.store.pause(false);
                return err;
            };
            const depth: u64 = switch (self.options.period) {
                .blocks => |count| count,
                else => 0,
            };
            const tip_counts = try self.source.tipCounts();
            const protected = tip_counts != null;
            const proof_gated = !protected and self.source.historical_counts;
            if (self.cache.proven_through) |proven| self.cache.proven_through = @min(proven, observed.indexed);
            var unproven = proof_gated and (self.cache.proven_through orelse observed.confirmed) < observed.indexed;
            if (unproven) {
                if (self.source.counts(observed.hash) catch null) |counts| {
                    const stored = try self.store.sequenceCounts();
                    if (counts[0] == stored[0] and counts[1] == stored[3]) {
                        self.cache.proven_through = observed.indexed;
                    } else {
                        try self.store.rewindToConfirmed(observed);
                        self.cache.boundary = null;
                        self.cache.proven_through = observed.confirmed;
                        observed = try pipeline.observe(self.source, self.store);
                    }
                    unproven = false;
                }
            }
            var bounded = observed;
            if (!protected and !unproven) bounded.head = @min(bounded.head, bounded.confirmed +| depth +| 10000);
            var ingest_error: ?anyerror = null;
            const more_ingest = if (bounded.indexed < bounded.head) pipeline.ingest(self.allocator, self.source, self.store, bounded, self.options.chunk_size, &self.cache) catch |err| blk: {
                if (err == error.CommitOutcomeUnknown) return err;
                ingest_error = err;
                break :blk false;
            } else false;
            var publishable: u64 = if (protected) observed.confirmed else if (proof_gated) @max(self.cache.proven_through orelse observed.confirmed, observed.confirmed) else std.math.maxInt(u64);
            if (tip_counts) |expected| {
                if (ingest_error == null) {
                    const current = try self.store.state() orelse return error.MissingScraperHead;
                    const actual = try self.store.sequenceCounts();
                    var incomplete = false;
                    var unavailable = false;
                    var stale = false;
                    var proven = current.indexed;
                    for (expected, actual) |tip, count| {
                        const expected_count = tip.count orelse continue;
                        if (expected_count < count) {
                            stale = true;
                            continue;
                        }
                        if (tip.tip > current.indexed and expected_count > count) {
                            unavailable = true;
                            continue;
                        }
                        proven = @min(proven, @min(tip.tip, current.indexed));
                        incomplete = incomplete or expected_count > count;
                    }
                    if (!unavailable and !stale and !incomplete) {
                        publishable = if (proven <= current.confirmed) current.confirmed else try self.store.checkpoint(proven);
                    } else if (!unavailable and !stale and incomplete) {
                        if (current.indexed > current.confirmed) try self.store.rewindToConfirmed(current);
                        self.cache.boundary = null;
                        ingest_error = error.ScraperIncompleteTip;
                    }
                }
            }
            const publication = try pipeline.confirm(self.source, self.store, self.options.period, lease, publishable);
            const current = try self.store.state() orelse return error.MissingScraperHead;
            const still_unproven = proof_gated and (self.cache.proven_through orelse current.confirmed) < current.indexed;
            if (!publication.page_limited and ingest_error != null) return ingest_error.?;
            const tail_wait = still_unproven and !more_ingest;
            const capped = current.confirmed +| depth +| 10000;
            if (!publication.page_limited and !tail_wait and !protected and capped < observed.head and current.indexed >= capped) return error.ScraperProvisionalCapReached;
            return .{ .more = publication.page_limited or more_ingest, .ingestion_failed = ingest_error != null or tail_wait, .ingestion_error = if (tail_wait) error.ScraperUnprovenTail else ingest_error, .indexed = current.indexed, .confirmed = current.confirmed, .published = publication.counts };
        }
        /// Supervisor supplies monotonic time and runs cycle in a cancellable job.
        pub fn delayAfter(self: *@This(), result: anyerror!Outcome, now_ms: u64) struct { delay_ms: u64, critical: bool } {
            const failed = if (result) |outcome| outcome.ingestion_failed else |_| true;
            const critical = self.failures.record(failed, now_ms, self.options.critical_failure_grace_ms);
            const more = if (result) |outcome| outcome.more else |_| false;
            return .{ .delay_ms = if (more) 0 else self.failures.retryDelay(now_ms, self.options.poll_ms, self.options.critical_failure_grace_ms), .critical = critical };
        }
    };
}
