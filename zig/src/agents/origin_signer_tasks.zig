//! Shared signer lookup cache with one retained, serialized source per origin.
//! Sources are separate from indexer clients. No RPC clients or threads are
//! created per message; callers join before destroying this owner.
const std = @import("std");
const settings = @import("../settings/root.zig");
const protocol = @import("../protocol/root.zig");
const origins = @import("origin_tasks.zig");
const resources = @import("chain_source.zig");
const signers = @import("origin_signers.zig");
const source = @import("origin_signer_source.zig");
const A = std.mem.Allocator;
const Slot = struct {
    owner: *Owner,
    index: usize,
    mutex: std.Thread.Mutex = .{},
    network: ?*resources.Resources = null,
    source: ?source.Source = null,
    fn fetch(context: *anyopaque, a: A, message: protocol.Message, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) ![][32]u8 {
        const self: *Slot = @ptrCast(@alignCast(context));
        const started = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
        if (started >= deadline_ns) return error.SourceReadDeadline;
        var timer = try std.time.Timer.start();
        const budget = deadline_ns - started;
        while (!self.mutex.tryLock()) {
            if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            const elapsed = timer.read();
            if (elapsed >= budget) return error.SourceReadDeadline;
            std.Thread.sleep(@min(std.time.ns_per_ms, budget - elapsed));
        }
        defer self.mutex.unlock();
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const origin = self.owner.origins.slots[self.index].handle() orelse return error.OriginSignerLookupPending;
        if (origin.chain.domain != message.origin) return error.OriginSignerAuthorityMismatch;
        if (self.network == null) self.network = try resources.Resources.open(self.owner.allocator, origin.chain, self.owner.environment, self.owner.options);
        if (self.source == null) {
            self.network.?.setCancellation(cancel);
            defer self.network.?.setCancellation(null);
            _ = try self.network.?.source();
            self.source = source.Source.init(self.network.?, origin.store);
        }
        return self.source.?.interface().fetch(a, message, deadline_ns, cancel);
    }
    fn deinit(self: *Slot) void {
        if (self.network) |value| value.deinit();
    }
};
pub const Owner = struct {
    allocator: A,
    origins: *origins.Set,
    environment: *const std.process.EnvMap,
    options: resources.Options,
    slots: []Slot,
    cache: signers.Cache,
    pub fn open(a: A, origin_set: *origins.Set, environment: *const std.process.EnvMap, options: resources.Options) !*Owner {
        const self = try a.create(Owner);
        errdefer a.destroy(self);
        const slots = try a.alloc(Slot, origin_set.slots.len);
        errdefer a.free(slots);
        self.* = .{ .allocator = a, .origins = origin_set, .environment = environment, .options = options, .slots = slots, .cache = try signers.Cache.initDefault(a) };
        for (slots, 0..) |*slot, index| slot.* = .{ .owner = self, .index = index };
        return self;
    }
    /// Absolute UTC deadline; Source converts its remaining budget once to monotonic.
    pub fn lookup(self: *Owner, a: A, message: protocol.Message, address_rules_active: bool, explicit_signers: bool, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) !?signers.Cache.Snapshot {
        if (!address_rules_active and !explicit_signers) return null;
        for (self.origins.slots, self.slots) |origin, *slot| if (origin.chain.domain == message.origin) {
            return self.cache.lookup(a, message, address_rules_active, explicit_signers, .{ .context = slot, .fetch_fn = Slot.fetch }, deadline_ns, cancel);
        };
        return error.UnknownOriginDomain;
    }
    pub fn deinit(self: *Owner) void {
        for (self.slots) |*slot| slot.deinit();
        self.cache.deinit();
        self.allocator.free(self.slots);
        self.allocator.destroy(self);
    }
};
