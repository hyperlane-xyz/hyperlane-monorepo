//! graphql-js `print` for executable documents and values (string building
//! mirrors printDocASTReducer, so output is byte-identical for these nodes).
const std = @import("std");
const ast = @import("ast.zig");

const Allocator = std.mem.Allocator;
const max_line_length = 80;

pub fn printDocument(a: Allocator, doc: *const ast.Document) ![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    for (doc.definitions) |def| {
        switch (def) {
            .operation => |op| try parts.append(a, try printOperation(a, op)),
            .fragment => |frag| try parts.append(a, try printFragment(a, frag)),
            .type_system => {}, // never cached/printed (rejected by validation)
        }
    }
    return join(a, parts.items, "\n\n");
}

pub fn printOperation(a: Allocator, op: *const ast.Operation) ![]const u8 {
    var var_defs: std.ArrayList([]const u8) = .empty;
    for (op.variable_definitions) |*v| try var_defs.append(a, try printVariableDefinition(a, v));
    const vars = if (hasMultiline(var_defs.items))
        try wrap(a, "(\n", try join(a, var_defs.items, "\n"), "\n)")
    else
        try wrap(a, "(", try join(a, var_defs.items, ", "), ")");
    const name = if (op.name) |n| n.value else "";
    const head = try join(a, &.{ op.operation.text(), try join(a, &.{ name, vars }, ""), try printDirectives(a, op.directives) }, " ");
    const prefix = try std.mem.concat(a, u8, &.{ try printDescription(a, op.description), head });
    const sel = try printSelectionSet(a, op.selection_set);
    if (std.mem.eql(u8, prefix, "query")) return sel;
    return std.mem.concat(a, u8, &.{ prefix, " ", sel });
}

fn printDescription(a: Allocator, desc: ?ast.StringValue) ![]const u8 {
    const d = desc orelse return "";
    return std.mem.concat(a, u8, &.{ try printStringValue(a, d), "\n" });
}

fn printVariableDefinition(a: Allocator, v: *const ast.VariableDefinition) ![]const u8 {
    return std.mem.concat(a, u8, &.{
        try printDescription(a, v.description),
        "$",
        v.variable.name.value,
        ": ",
        try printType(a, v.type),
        if (v.default_value) |d| try std.mem.concat(a, u8, &.{ " = ", try printValue(a, d) }) else "",
        try wrap(a, " ", try printDirectives(a, v.directives), ""),
    });
}

pub fn printType(a: Allocator, t: *const ast.Type) ![]const u8 {
    return switch (t.data) {
        .named => |n| n.value,
        .list => |inner| std.mem.concat(a, u8, &.{ "[", try printType(a, inner), "]" }),
        .non_null => |inner| std.mem.concat(a, u8, &.{ try printType(a, inner), "!" }),
    };
}

fn printFragment(a: Allocator, f: *const ast.Fragment) ![]const u8 {
    return std.mem.concat(a, u8, &.{
        try printDescription(a, f.description),
        "fragment ",
        f.name.value,
        " on ",
        f.type_condition.value,
        " ",
        try wrap(a, "", try printDirectives(a, f.directives), " "),
        try printSelectionSet(a, f.selection_set),
    });
}

fn printSelectionSet(a: Allocator, set: *const ast.SelectionSet) error{OutOfMemory}![]const u8 {
    var items: std.ArrayList([]const u8) = .empty;
    for (set.selections) |sel| try items.append(a, try printSelection(a, sel));
    return block(a, items.items);
}

fn printSelection(a: Allocator, sel: ast.Selection) error{OutOfMemory}![]const u8 {
    switch (sel) {
        .field => |f| {
            const prefix = if (f.alias) |al| try std.mem.concat(a, u8, &.{ al.value, ": ", f.name.value }) else f.name.value;
            var args: std.ArrayList([]const u8) = .empty;
            for (f.arguments) |arg| try args.append(a, try printArgument(a, arg));
            var args_line = try std.mem.concat(a, u8, &.{ prefix, try wrap(a, "(", try join(a, args.items, ", "), ")") });
            if (jsLength(args_line) > max_line_length) {
                args_line = try std.mem.concat(a, u8, &.{ prefix, try wrap(a, "(\n", try indent(a, try join(a, args.items, "\n")), "\n)") });
            }
            const sub = if (f.selection_set) |s| try printSelectionSet(a, s) else "";
            return join(a, &.{ args_line, try printDirectives(a, f.directives), sub }, " ");
        },
        .fragment_spread => |s| return std.mem.concat(a, u8, &.{ "...", s.name.value, try wrap(a, " ", try printDirectives(a, s.directives), "") }),
        .inline_fragment => |f| {
            const cond = if (f.type_condition) |t| try std.mem.concat(a, u8, &.{ "on ", t.value }) else "";
            return join(a, &.{ "...", cond, try printDirectives(a, f.directives), try printSelectionSet(a, f.selection_set) }, " ");
        },
    }
}

fn printArgument(a: Allocator, arg: ast.Argument) ![]const u8 {
    return std.mem.concat(a, u8, &.{ arg.name.value, ": ", try printValue(a, arg.value) });
}

pub fn printDirectives(a: Allocator, directives: []const ast.Directive) ![]const u8 {
    var items: std.ArrayList([]const u8) = .empty;
    for (directives) |d| {
        var args: std.ArrayList([]const u8) = .empty;
        for (d.arguments) |arg| try args.append(a, try printArgument(a, arg));
        try items.append(a, try std.mem.concat(a, u8, &.{ "@", d.name.value, try wrap(a, "(", try join(a, args.items, ", "), ")") }));
    }
    return join(a, items.items, " ");
}

pub fn printValue(a: Allocator, v: *const ast.Value) error{OutOfMemory}![]const u8 {
    return switch (v.data) {
        .variable => |n| std.mem.concat(a, u8, &.{ "$", n.name.value }),
        .int, .float, .enum_value => |s| s,
        .string => |s| printStringValue(a, s),
        .boolean => |b| if (b) "true" else "false",
        .null => "null",
        .list => |items| blk: {
            var parts: std.ArrayList([]const u8) = .empty;
            for (items) |item| try parts.append(a, try printValue(a, item));
            break :blk std.mem.concat(a, u8, &.{ "[", try join(a, parts.items, ", "), "]" });
        },
        .object => |fields| blk: {
            var parts: std.ArrayList([]const u8) = .empty;
            for (fields) |f| try parts.append(a, try std.mem.concat(a, u8, &.{ f.name.value, ": ", try printValue(a, f.value) }));
            break :blk std.mem.concat(a, u8, &.{ "{", try join(a, parts.items, ", "), "}" });
        },
    };
}

fn printStringValue(a: Allocator, s: ast.StringValue) ![]const u8 {
    return if (s.block) printBlockString(a, s.value) else printString(a, s.value);
}

/// graphql-js `printString`.
pub fn printString(a: Allocator, s: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, '"');
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        switch (c) {
            0x08 => try out.appendSlice(a, "\\b"),
            '\t' => try out.appendSlice(a, "\\t"),
            '\n' => try out.appendSlice(a, "\\n"),
            0x0C => try out.appendSlice(a, "\\f"),
            '\r' => try out.appendSlice(a, "\\r"),
            '"' => try out.appendSlice(a, "\\\""),
            '\\' => try out.appendSlice(a, "\\\\"),
            0x00...0x07, 0x0B, 0x0E...0x1F, 0x7F => try out.print(a, "\\u{X:0>4}", .{c}),
            0xC2 => if (i + 1 < s.len and s[i + 1] >= 0x80 and s[i + 1] <= 0x9F) {
                // U+0080..U+009F are escaped too.
                try out.print(a, "\\u{X:0>4}", .{s[i + 1]});
                i += 1;
            } else try out.append(a, c),
            else => try out.append(a, c),
        }
    }
    try out.append(a, '"');
    return out.items;
}

/// graphql-js `printBlockString` (non-minimized).
pub fn printBlockString(a: Allocator, value: []const u8) ![]const u8 {
    const escaped = try std.mem.replaceOwned(u8, a, value, "\"\"\"", "\\\"\"\"");
    var lines: std.ArrayList([]const u8) = .empty;
    var start: usize = 0;
    var i: usize = 0;
    while (i < escaped.len) : (i += 1) {
        if (escaped[i] == '\n' or escaped[i] == '\r') {
            try lines.append(a, escaped[start..i]);
            if (escaped[i] == '\r' and i + 1 < escaped.len and escaped[i + 1] == '\n') i += 1;
            start = i + 1;
        }
    }
    try lines.append(a, escaped[start..]);
    const single = lines.items.len == 1;
    var force_leading = lines.items.len > 1;
    if (force_leading) {
        for (lines.items[1..]) |line| {
            if (!(line.len == 0 or line[0] == ' ' or line[0] == '\t')) force_leading = false;
        }
    }
    const trailing_triple = std.mem.endsWith(u8, escaped, "\\\"\"\"");
    const trailing_quote = std.mem.endsWith(u8, value, "\"") and !trailing_triple;
    const trailing_slash = std.mem.endsWith(u8, value, "\\");
    const force_trailing = trailing_quote or trailing_slash;
    const multi = !single or jsLength(value) > 70 or force_trailing or force_leading or trailing_triple;
    const skip_leading = single and value.len > 0 and (value[0] == ' ' or value[0] == '\t');
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, "\"\"\"");
    if ((multi and !skip_leading) or force_leading) try out.append(a, '\n');
    try out.appendSlice(a, escaped);
    if (multi or force_trailing) try out.append(a, '\n');
    try out.appendSlice(a, "\"\"\"");
    return out.items;
}

fn jsLength(s: []const u8) usize {
    return ast.utf16Length(s);
}

fn join(a: Allocator, parts: []const []const u8, sep: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var first = true;
    for (parts) |p| {
        if (p.len == 0) continue;
        if (!first) try out.appendSlice(a, sep);
        first = false;
        try out.appendSlice(a, p);
    }
    return out.items;
}

fn wrap(a: Allocator, start: []const u8, s: []const u8, end: []const u8) ![]const u8 {
    if (s.len == 0) return "";
    return std.mem.concat(a, u8, &.{ start, s, end });
}

fn indent(a: Allocator, s: []const u8) ![]const u8 {
    if (s.len == 0) return "";
    const replaced = try std.mem.replaceOwned(u8, a, s, "\n", "\n  ");
    return std.mem.concat(a, u8, &.{ "  ", replaced });
}

fn block(a: Allocator, items: []const []const u8) ![]const u8 {
    return wrap(a, "{\n", try indent(a, try join(a, items, "\n")), "\n}");
}

fn hasMultiline(items: []const []const u8) bool {
    for (items) |s| if (std.mem.indexOfScalar(u8, s, '\n') != null) return true;
    return false;
}

test "print matches graphql-js layout" {
    const parser = @import("parser.zig");
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, "query Q($a: Int = 1, $b: String = \")\") @cached(ttl: 30) { x: domain(where: {name: {_eq: \"\\u0001\"}}, limit: $a) @skip(if: false) { id ...F ... on domain { name } } } fragment F on domain { id }", .{}, &diag);
    const printed = try printDocument(a, doc);
    try std.testing.expectEqualStrings(
        \\query Q($a: Int = 1, $b: String = ")") @cached(ttl: 30) {
        \\  x: domain(where: {name: {_eq: "\u0001"}}, limit: $a) @skip(if: false) {
        \\    id
        \\    ...F
        \\    ... on domain {
        \\      name
        \\    }
        \\  }
        \\}
        \\
        \\fragment F on domain {
        \\  id
        \\}
    , printed);
    const short = try parser.parse(a, "{ a }", .{}, &diag);
    try std.testing.expectEqualStrings("{\n  a\n}", try printDocument(a, short));
}
