//! Dynamic ready-origin bindings for native relayer administrative databases.
const std = @import("std");
const api = @import("api.zig");
const native = @import("native_stores.zig");
const origins = @import("../../agents/origin_tasks.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
const Cancel = *const std.atomic.Value(bool);
const max_range_rows: u64 = 4096;
const max_domains: usize = 1024;

pub const Domain = native.Domain;

pub const Bindings = struct {
    origins: ?*origins.Set,
    domains: []const Domain = &.{},

    pub fn init(origin_set: *origins.Set) Bindings {
        return .{ .origins = origin_set };
    }

    pub fn fromDomains(domains: []const Domain) Bindings {
        return .{ .origins = null, .domains = domains };
    }

    fn snapshot(self: *Bindings, storage: []Domain) ![]const Domain {
        if (self.origins == null) return self.domains;
        var count: usize = 0;
        for (self.origins.?.slots) |*slot| {
            const origin = slot.handle() orelse continue;
            if (count == storage.len) return error.TooManyOriginDomains;
            storage[count] = .{ .name = origin.chain.name, .id = origin.chain.domain, .store = origin.store, .origin = origin.history };
            count += 1;
        }
        return storage[0..count];
    }

    fn ready(self: *Bindings, domain: u32) bool {
        if (self.origins) |set| {
            for (set.slots) |*slot| {
                const origin = slot.handle() orelse continue;
                if (origin.chain.domain == domain) return true;
            }
            return false;
        }
        for (self.domains) |candidate| if (candidate.id == domain) return true;
        return false;
    }

    pub fn messageDb(self: *Bindings) api.MessageDb {
        return .{ .context = self, .contains_fn = messageContains, .list_fn = messageList, .insert_fn = messageInsert, .by_id_fn = messageById };
    }

    pub fn merkleDb(self: *Bindings) api.MerkleDb {
        return .{ .context = self, .contains_chain = messageContains, .list_fn = merkleList, .insert_fn = merkleInsert };
    }

    pub fn proofDb(self: *Bindings) api.ProofDb {
        return .{ .context = self, .contains_fn = messageContains, .proof_fn = proof };
    }
};

fn checkRange(start: u32, end: u32) !void {
    if (end < start) return error.InvalidAdminRange;
    if (@as(u64, end) - @as(u64, start) + 1 > max_range_rows) return error.AdminRangeTooLarge;
}

fn messageContains(context: *anyopaque, domain: u32) bool {
    const self: *Bindings = @ptrCast(@alignCast(context));
    return self.ready(domain);
}

fn messageList(context: *anyopaque, a: A, domain: u32, start: u32, end: u32, cancel: Cancel) anyerror!api.MessageList {
    const self: *Bindings = @ptrCast(@alignCast(context));
    try checkRange(start, end);
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.messageDb();
    return owner.list_fn(owner.context, a, domain, start, end, cancel);
}

fn messageInsert(context: *anyopaque, input: api.MessageInput, cancel: Cancel) anyerror!void {
    const self: *Bindings = @ptrCast(@alignCast(context));
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.messageDb();
    return owner.insert_fn(owner.context, input, cancel);
}

fn messageById(context: *anyopaque, a: A, domain: u32, id: [32]u8, cancel: Cancel) anyerror!?protocol.Message {
    const self: *Bindings = @ptrCast(@alignCast(context));
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.messageDb();
    return owner.by_id_fn(owner.context, a, domain, id, cancel);
}

fn merkleList(context: *anyopaque, a: A, domain: u32, start: u32, end: u32, cancel: Cancel) anyerror!api.MerkleList {
    const self: *Bindings = @ptrCast(@alignCast(context));
    try checkRange(start, end);
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.merkleDb();
    return owner.list_fn(owner.context, a, domain, start, end, cancel);
}

fn merkleInsert(context: *anyopaque, input: api.MerkleInput, cancel: Cancel) anyerror!void {
    const self: *Bindings = @ptrCast(@alignCast(context));
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.merkleDb();
    return owner.insert_fn(owner.context, input, cancel);
}

fn proof(context: *anyopaque, domain: u32, leaf_index: u32, root_index: u32, cancel: Cancel) anyerror!protocol.Proof {
    const self: *Bindings = @ptrCast(@alignCast(context));
    var storage: [max_domains]Domain = undefined;
    var databases: native.NativeDatabases = .{ .domains = try self.snapshot(&storage) };
    const owner = databases.proofDb();
    return owner.proof_fn(owner.context, domain, leaf_index, root_index, cancel);
}
