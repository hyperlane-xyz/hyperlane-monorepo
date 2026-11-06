//! Concrete Store/Origin adapters for the delegated admin API.
//!
//! This module is intentionally absent from the std-only delegated root: it
//! references production RocksDB-backed operations and must only be linked by
//! the native DB test root or the parent service binary.
const std = @import("std");
const api = @import("api.zig");
const native_store = @import("../../agents/store.zig");
const native_origin = @import("../../agents/origin.zig");
const protocol = @import("../../protocol/root.zig");
const Cancel = *const std.atomic.Value(bool);

pub const Domain = struct {
    name: []const u8,
    id: u32,
    store: *native_store.Store,
    origin: *native_origin.Origin,
};

pub const NativeDatabases = struct {
    domains: []const Domain,

    pub fn messageDb(self: *NativeDatabases) api.MessageDb {
        return .{
            .context = self,
            .contains_fn = messageContains,
            .list_fn = messageList,
            .insert_fn = messageInsert,
            .by_id_fn = messageById,
        };
    }
    pub fn merkleDb(self: *NativeDatabases) api.MerkleDb {
        return .{
            .context = self,
            .contains_chain = merkleContains,
            .list_fn = merkleList,
            .insert_fn = merkleInsert,
        };
    }
    pub fn proofDb(self: *NativeDatabases) api.ProofDb {
        return .{ .context = self, .contains_fn = proofContains, .proof_fn = proof };
    }
};

fn find(self: *NativeDatabases, domain: u32) ?Domain {
    for (self.domains) |item| if (item.id == domain) return item;
    return null;
}

fn messageContains(context: *anyopaque, domain: u32) bool {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    return find(self, domain) != null;
}

fn messageList(context: *anyopaque, a: std.mem.Allocator, domain: u32, start: u32, end: u32, cancel: Cancel) anyerror!api.MessageList {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    const entry = find(self, domain) orelse return error.UnknownDomain;
    var found = std.array_list.Managed(protocol.Message).init(a);
    errdefer found.deinit();
    var nonce = start;
    while (true) {
        if (cancel.load(.acquire)) return error.Cancelled;
        var owned = try entry.store.messageByNonce(nonce);
        defer if (owned) |*message| message.deinit();
        if (owned) |message| {
            const body = try a.dupe(u8, message.value.body);
            try found.append(message.value);
            found.items[found.items.len - 1].body = body;
        }
        if (nonce == end) break;
        nonce +%= 1;
        if (nonce == 0 and end != std.math.maxInt(u32)) break;
    }
    return .{ .messages = try found.toOwnedSlice() };
}

fn messageInsert(context: *anyopaque, input: api.MessageInput, cancel: Cancel) anyerror!void {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    if (cancel.load(.acquire)) return error.Cancelled;
    const entry = find(self, input.message.origin) orelse return error.UnknownDomain;
    try entry.store.upsertMessage(input.message, input.dispatched_block_number, null);
}

fn messageById(context: *anyopaque, a: std.mem.Allocator, domain: u32, id: [32]u8, cancel: Cancel) anyerror!?protocol.Message {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    if (cancel.load(.acquire)) return error.Cancelled;
    const entry = find(self, domain) orelse return error.UnknownDomain;
    var owned = try entry.store.messageById(id);
    defer if (owned) |*message| message.deinit();
    if (owned) |message| {
        const body = try a.dupe(u8, message.value.body);
        return .{
            .version = message.value.version,
            .nonce = message.value.nonce,
            .origin = message.value.origin,
            .sender = message.value.sender,
            .destination = message.value.destination,
            .recipient = message.value.recipient,
            .body = body,
        };
    }
    return null;
}

fn merkleContains(context: *anyopaque, chain: u32) bool {
    return messageContains(context, chain);
}

fn merkleList(context: *anyopaque, a: std.mem.Allocator, domain: u32, start: u32, end: u32, cancel: Cancel) anyerror!api.MerkleList {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    const entry = find(self, domain) orelse return error.UnknownDomain;
    var found = std.array_list.Managed(api.MerkleInsertion).init(a);
    errdefer found.deinit();
    var index = start;
    while (true) {
        if (cancel.load(.acquire)) return error.Cancelled;
        if (try entry.store.insertionByIndex(index)) |insertion| {
            const block = try entry.store.logBlock(.insertion, index);
            try found.append(.{ .insertion_block_number = block, .leaf_index = insertion.leaf_index, .message_id = insertion.message_id });
        }
        if (index == end) break;
        index +%= 1;
        if (index == 0 and end != std.math.maxInt(u32)) break;
    }
    return .{ .insertions = try found.toOwnedSlice() };
}

fn merkleInsert(context: *anyopaque, input: api.MerkleInput, cancel: Cancel) anyerror!void {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    if (cancel.load(.acquire)) return error.Cancelled;
    const entry = find(self, input.chain) orelse return error.UnknownDomain;
    _ = try entry.store.storeInsertion(.{ .leaf_index = input.leaf_index, .message_id = input.message_id }, input.insertion_block_number);
}

fn proofContains(context: *anyopaque, domain: u32) bool {
    return messageContains(context, domain);
}

fn proof(context: *anyopaque, domain: u32, leaf_index: u32, root_index: u32, cancel: Cancel) anyerror!protocol.Proof {
    const self: *NativeDatabases = @ptrCast(@alignCast(context));
    const entry = find(self, domain) orelse return error.UnknownDomain;
    var attempts: usize = 0;
    while (true) {
        if (cancel.load(.acquire)) return error.Cancelled;
        entry.origin.mutex.lock();
        entry.store.mutex.lock();
        if (entry.origin.tree_generation == entry.store.tree_reset_generation) {
            const pending = if (entry.origin.tree.count <= std.math.maxInt(u32)) try entry.store.insertionByIndex(@intCast(entry.origin.tree.count)) else null;
            if (pending == null) {
                defer entry.store.mutex.unlock();
                defer entry.origin.mutex.unlock();
                return entry.origin.tree.proof(leaf_index, root_index);
            }
        }
        entry.store.mutex.unlock();
        entry.origin.mutex.unlock();
        _ = try entry.origin.sync(1);
        attempts += 1;
        if (attempts > 128) return error.ProverGenerationChurn;
    }
}
