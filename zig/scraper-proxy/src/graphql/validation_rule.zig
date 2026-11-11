//! `validation.ts`: scraperProxyValidationRule (operation count/type, root
//! fields, fields, aliases, depth, work budget, introspection) and
//! MAX_GRAPHQL_TOKENS. Runs on Document enter, after ExecutableDefinitions.
const std = @import("std");
const ast = @import("ast.zig");

pub const max_graphql_tokens = 10_000;
const max_work = 1_000;

const Stat = enum { root_fields, fields, aliases, depth };
const limits = std.EnumArray(Stat, u32).init(.{ .root_fields = 10, .fields = 250, .aliases = 10, .depth = 6 });

const Stats = std.EnumArray(Stat, u32);

const Walk = struct {
    fragments: *const std.StringHashMapUnmanaged(*const ast.Fragment),
    stats: Stats = Stats.initFill(0),
    introspection: bool = false,
    work: u32 = 0,
    visited: std.ArrayList([]const u8) = .empty,
    arena: std.mem.Allocator,

    fn overBudget(self: *const Walk) bool {
        inline for (comptime std.enums.values(Stat)) |s| {
            if (self.stats.get(s) > limits.get(s)) return true;
        }
        return false;
    }

    fn walk(self: *Walk, set: *const ast.SelectionSet, depth: u32, root: bool) std.mem.Allocator.Error!void {
        for (set.selections) |sel| {
            self.work += 1;
            if (self.work > max_work or self.overBudget()) return;
            switch (sel) {
                .field => |f| {
                    if (std.mem.eql(u8, f.name.value, "__schema") or std.mem.eql(u8, f.name.value, "__type")) {
                        self.introspection = true;
                        continue;
                    }
                    self.stats.getPtr(.fields).* += 1;
                    self.stats.set(.depth, @max(self.stats.get(.depth), depth + 1));
                    if (f.alias != null) self.stats.getPtr(.aliases).* += 1;
                    if (root) self.stats.getPtr(.root_fields).* += 1;
                    if (f.selection_set) |child| try self.walk(child, depth + 1, false);
                },
                .inline_fragment => |f| try self.walk(f.selection_set, depth, root),
                .fragment_spread => |fs| {
                    const name = fs.name.value;
                    const frag = self.fragments.get(name) orelse continue;
                    if (self.isVisited(name)) continue;
                    try self.visited.append(self.arena, name);
                    try self.walk(frag.selection_set, depth, root);
                    _ = self.visited.pop();
                },
            }
        }
    }

    fn isVisited(self: *const Walk, name: []const u8) bool {
        for (self.visited.items) |n| if (std.mem.eql(u8, n, name)) return true;
        return false;
    }
};

/// `reporter.reportMessage(message)` receives each error (no locations).
pub fn validate(reporter: anytype, doc: *const ast.Document) !void {
    const arena = reporter.arena;
    var operation_count: usize = 0;
    for (doc.definitions) |def| {
        if (def == .operation) operation_count += 1;
    }
    if (operation_count > 1) {
        try reporter.reportMessage("Only 1 operation per request is allowed");
        return;
    }
    // `new Map(fragments)`: the last definition of a name wins.
    var fragments: std.StringHashMapUnmanaged(*const ast.Fragment) = .empty;
    for (doc.definitions) |def| {
        if (def == .fragment) try fragments.put(arena, def.fragment.name.value, def.fragment);
    }
    for (doc.definitions) |def| {
        if (def != .operation) continue;
        const op = def.operation;
        if (op.operation != .query) {
            try reporter.reportMessage("Only query operations are allowed");
            continue;
        }
        var w: Walk = .{ .fragments = &fragments, .arena = arena };
        try w.walk(op.selection_set, 0, true);
        inline for (comptime std.enums.values(Stat)) |s| {
            const max = comptime limits.get(s);
            if (w.stats.get(s) > max) {
                const label = comptime switch (s) {
                    .root_fields => "root fields",
                    .fields => "fields",
                    .aliases => "aliases",
                    .depth => "depth",
                };
                try reporter.reportMessage(std.fmt.comptimePrint("GraphQL query {s} exceeds maximum of {d}", .{ label, max }));
            }
        }
        if (w.work > max_work) {
            try reporter.reportMessage(std.fmt.comptimePrint("GraphQL query work exceeds maximum of {d}", .{max_work}));
        }
        if (w.introspection) try reporter.reportMessage("Introspection is not allowed");
    }
}
