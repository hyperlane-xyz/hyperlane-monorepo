//! `request-compatibility.ts`: drop variable definitions no operation or
//! fragment uses (legacy clients send extra variables). Mutates the
//! operations' `variable_definitions` in place (the AST is request-owned
//! until it is cached, exactly like the mercurius preValidation hook).
const std = @import("std");
const ast = @import("ast.zig");

const Allocator = std.mem.Allocator;

pub const UsedVariables = std.StringHashMapUnmanaged(void);

/// Variable names referenced outside variable definitions. When
/// `skip_directive` is set, that directive's arguments are ignored.
pub fn collectUsedVariables(a: Allocator, doc: *const ast.Document, skip_directive: ?[]const u8) Allocator.Error!UsedVariables {
    var used: UsedVariables = .empty;
    var c: Collector = .{ .a = a, .used = &used, .skip_directive = skip_directive };
    for (doc.definitions) |def| switch (def) {
        .operation => |op| {
            try c.directives(op.directives);
            try c.selectionSet(op.selection_set);
        },
        .fragment => |frag| {
            try c.directives(frag.directives);
            try c.selectionSet(frag.selection_set);
        },
        .type_system => {},
    };
    return used;
}

pub fn stripUnusedVariables(a: Allocator, doc: *ast.Document) Allocator.Error!void {
    const used = try collectUsedVariables(a, doc, null);
    for (doc.definitions) |def| {
        if (def != .operation) continue;
        const op = def.operation;
        op.variable_definitions = try filterDefinitions(a, op.variable_definitions, &used);
    }
}

pub fn filterDefinitions(a: Allocator, defs: []const ast.VariableDefinition, used: *const UsedVariables) Allocator.Error![]const ast.VariableDefinition {
    var keep: usize = 0;
    for (defs) |vd| {
        if (used.contains(vd.variable.name.value)) keep += 1;
    }
    if (keep == defs.len) return defs;
    const out = try a.alloc(ast.VariableDefinition, keep);
    var i: usize = 0;
    for (defs) |vd| if (used.contains(vd.variable.name.value)) {
        out[i] = vd;
        i += 1;
    };
    return out;
}

const Collector = struct {
    a: Allocator,
    used: *UsedVariables,
    skip_directive: ?[]const u8,

    fn selectionSet(self: *Collector, set: *const ast.SelectionSet) Allocator.Error!void {
        for (set.selections) |sel| switch (sel) {
            .field => |f| {
                for (f.arguments) |arg| try self.value(arg.value);
                try self.directives(f.directives);
                if (f.selection_set) |s| try self.selectionSet(s);
            },
            .fragment_spread => |fs| try self.directives(fs.directives),
            .inline_fragment => |f| {
                try self.directives(f.directives);
                try self.selectionSet(f.selection_set);
            },
        };
    }

    fn directives(self: *Collector, list: []const ast.Directive) Allocator.Error!void {
        for (list) |d| {
            if (self.skip_directive) |skip| if (std.mem.eql(u8, d.name.value, skip)) continue;
            for (d.arguments) |arg| try self.value(arg.value);
        }
    }

    fn value(self: *Collector, v: *const ast.Value) Allocator.Error!void {
        switch (v.data) {
            .variable => |variable| try self.used.put(self.a, variable.name.value, {}),
            .list => |items| for (items) |item| try self.value(item),
            .object => |fields| for (fields) |f| try self.value(f.value),
            else => {},
        }
    }
};

const parser = @import("parser.zig");
const printer = @import("printer.zig");

fn normalize(a: Allocator, query: []const u8) ![]const u8 {
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, query, .{}, &diag);
    try stripUnusedVariables(a, doc);
    return printer.printDocument(a, doc);
}

test "removes unused variable definitions" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const out = try normalize(arena.allocator(), "query Test($used: Int!, $unused: String) { domain(limit: $used) { id } }");
    try std.testing.expect(std.mem.indexOf(u8, out, "$used: Int!") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "unused") == null);
}

test "parses variable definitions and fragment usage as GraphQL" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const out = try normalize(arena.allocator(),
        \\
        \\      query Test($used: String = ")", $unused: String) {
        \\        ...Domains
        \\      }
        \\      fragment Domains on query_root {
        \\        domain(where: {name: {_eq: $used}}) { id }
        \\      }
        \\
    );
    try std.testing.expect(std.mem.indexOf(u8, out, "$used: String = \")\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "unused") == null);
}

test "is idempotent across generated variable subsets" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var size: usize = 1;
    while (size <= 200) : (size += 1) {
        var q: std.ArrayList(u8) = .empty;
        try q.appendSlice(a, "query Generated(");
        for (0..size) |i| try q.print(a, "{s}$v{d}: Int", .{ if (i > 0) ", " else "", i });
        try q.appendSlice(a, ") { ");
        var any = false;
        for (0..size) |i| if ((i * 31 + size) % 5 == 0) {
            if (any) try q.append(a, ' ');
            try q.print(a, "a{d}: domain(limit: $v{d}) {{ id }}", .{ i, i });
            any = true;
        };
        if (!any) try q.appendSlice(a, "domain { id }");
        try q.appendSlice(a, " }");
        const once = try normalize(a, q.items);
        try std.testing.expectEqualStrings(once, try normalize(a, once));
        for (0..size) |i| {
            const needle = try std.fmt.allocPrint(a, "$v{d}: Int", .{i});
            const found = std.mem.indexOf(u8, once, needle) != null;
            try std.testing.expectEqual((i * 31 + size) % 5 == 0, found);
        }
    }
}
