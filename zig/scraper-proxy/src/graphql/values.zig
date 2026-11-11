//! graphql-js input coercion: `getVariableValues` (coerceInputValue),
//! `valueFromAST` and `getArgumentValues`, producing `core.json.Value`s with
//! graphql-js key order (schema field/argument order).
const std = @import("std");
const json = @import("core").json;
const ast = @import("ast.zig");
const schema_mod = @import("schema.zig");
const validate = @import("validate.zig");
const printer = @import("printer.zig");
const suggest = @import("suggest.zig");
const js = @import("js.zig");

const Value = json.Value;
const Member = json.Member;
const TypeRef = schema_mod.TypeRef;
const NamedType = schema_mod.NamedType;
const InputValue = schema_mod.InputValue;
const Schema = schema_mod.Schema;
const Allocator = std.mem.Allocator;

/// Error raised while coercing (message + node offsets).
pub const CoercionError = struct { message: []const u8, locations: []const u32 = &.{} };

/// Coerced variable values; `get` distinguishes absent from null.
pub const Variables = struct {
    members: []const Member = &.{},

    pub fn get(self: Variables, name: []const u8) ?Value {
        for (self.members) |m| if (std.mem.eql(u8, m.key, name)) return m.value;
        return null;
    }
};

pub const VariablesResult = union(enum) {
    coerced: Variables,
    errors: []const CoercionError,
};

const max_variable_errors = 50;

/// `getVariableValues(schema, varDefs, inputs, { maxErrors: 50 })`.
pub fn getVariableValues(a: Allocator, schema: *const Schema, var_defs: []const ast.VariableDefinition, inputs: ?Value) Allocator.Error!VariablesResult {
    var errors: std.ArrayList(CoercionError) = .empty;
    var coerced: std.ArrayList(Member) = .empty;
    const input_members: []const Member = if (inputs) |v| (if (v == .object) v.object else &.{}) else &.{};
    for (var_defs) |*vd| {
        const name = vd.variable.name.value;
        const var_type = (try validate.typeFromAst(a, schema, vd.type)) orelse {
            if (try pushError(a, &errors, .{ .message = try std.fmt.allocPrint(a, "Variable \"${s}\" expected value of type \"{s}\" which cannot be used as an input type.", .{ name, try printer.printType(a, vd.type) }), .locations = try a.dupe(u32, &.{vd.type.loc}) })) break;
            continue;
        };
        if (!var_type.namedType().isInputType()) {
            if (try pushError(a, &errors, .{ .message = try std.fmt.allocPrint(a, "Variable \"${s}\" expected value of type \"{s}\" which cannot be used as an input type.", .{ name, try printer.printType(a, vd.type) }), .locations = try a.dupe(u32, &.{vd.type.loc}) })) break;
            continue;
        }
        const provided = lookup(input_members, name);
        if (provided == null) {
            if (vd.default_value) |dv| {
                if (try valueFromAst(a, dv, var_type, null)) |v| try putMember(a, &coerced, name, v);
            } else if (var_type.isNonNull()) {
                if (try pushError(a, &errors, .{ .message = try std.fmt.allocPrint(a, "Variable \"${s}\" of required type \"{f}\" was not provided.", .{ name, var_type }), .locations = try a.dupe(u32, &.{vd.loc}) })) break;
            }
            continue;
        }
        const value = provided.?;
        if (value == .null and var_type.isNonNull()) {
            if (try pushError(a, &errors, .{ .message = try std.fmt.allocPrint(a, "Variable \"${s}\" of non-null type \"{f}\" must not be null.", .{ name, var_type }), .locations = try a.dupe(u32, &.{vd.loc}) })) break;
            continue;
        }
        var ctx: CoerceCtx = .{ .a = a, .var_name = name, .var_def = vd, .errors = &errors };
        const result = ctx.coerce(value, var_type, &.{}) catch |err| switch (err) {
            error.TooManyErrors => break,
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (result) |v| try putMember(a, &coerced, name, v);
    }
    if (errors.items.len > 0) return .{ .errors = errors.items };
    return .{ .coerced = .{ .members = coerced.items } };
}

/// Returns true when the error limit aborted coercion.
fn pushError(a: Allocator, errors: *std.ArrayList(CoercionError), err: CoercionError) Allocator.Error!bool {
    if (errors.items.len >= max_variable_errors) {
        try errors.append(a, .{ .message = "Too many errors processing variables, error limit reached. Execution aborted." });
        return true;
    }
    try errors.append(a, err);
    return false;
}

fn lookup(members: []const Member, name: []const u8) ?Value {
    for (members) |m| if (std.mem.eql(u8, m.key, name)) return m.value;
    return null;
}

fn putMember(a: Allocator, list: *std.ArrayList(Member), key: []const u8, value: Value) !void {
    for (list.items) |*m| if (std.mem.eql(u8, m.key, key)) {
        m.value = value;
        return;
    };
    try list.append(a, .{ .key = key, .value = value });
}

const PathItem = union(enum) { key: []const u8, index: usize };

const CoerceCtx = struct {
    a: Allocator,
    var_name: []const u8,
    var_def: *const ast.VariableDefinition,
    errors: *std.ArrayList(CoercionError),

    const Err = error{ OutOfMemory, TooManyErrors };

    fn fail(self: *CoerceCtx, path: []const PathItem, invalid: Value, message: []const u8) Err!void {
        var prefix: std.ArrayList(u8) = .empty;
        try prefix.print(self.a, "Variable \"${s}\" got invalid value {s}", .{ self.var_name, try js.inspect(self.a, invalid) });
        if (path.len > 0) {
            try prefix.print(self.a, " at \"{s}", .{self.var_name});
            for (path) |p| switch (p) {
                .key => |k| try prefix.print(self.a, ".{s}", .{k}),
                .index => |i| try prefix.print(self.a, "[{d}]", .{i}),
            };
            try prefix.append(self.a, '"');
        }
        try prefix.print(self.a, "; {s}", .{message});
        if (try pushError(self.a, self.errors, .{ .message = prefix.items, .locations = try self.a.dupe(u32, &.{self.var_def.loc}) })) return error.TooManyErrors;
    }

    fn extend(self: *CoerceCtx, path: []const PathItem, item: PathItem) ![]const PathItem {
        const out = try self.a.alloc(PathItem, path.len + 1);
        @memcpy(out[0..path.len], path);
        out[path.len] = item;
        return out;
    }

    /// `coerceInputValue`; null result = JS undefined.
    fn coerce(self: *CoerceCtx, input: Value, t: *const TypeRef, path: []const PathItem) Err!?Value {
        const a = self.a;
        switch (t.*) {
            .non_null => |inner| {
                if (input != .null) return self.coerce(input, inner, path);
                try self.fail(path, input, try std.fmt.allocPrint(a, "Expected non-nullable type \"{f}\" not to be null.", .{t}));
                return null;
            },
            .list => |item_type| {
                if (input == .null) return Value.null;
                if (input == .array) {
                    const out = try a.alloc(Value, input.array.len);
                    for (input.array, 0..) |item, i| {
                        // `Array.from` keeps undefined slots (serialized as null).
                        out[i] = (try self.coerce(item, item_type, try self.extend(path, .{ .index = i }))) orelse .null;
                    }
                    return .{ .array = out };
                }
                const single = try self.coerce(input, item_type, path);
                const out = try a.alloc(Value, 1);
                out[0] = single orelse .null;
                return .{ .array = out };
            },
            .named => |named| {
                if (input == .null) return Value.null;
                return switch (named.kind) {
                    .input_object => self.coerceObject(input, named, path),
                    .scalar, .@"enum" => self.coerceLeaf(input, named, path),
                    .object => unreachable,
                };
            },
        }
    }

    fn coerceObject(self: *CoerceCtx, input: Value, named: *const NamedType, path: []const PathItem) Err!?Value {
        const a = self.a;
        if (input != .object) {
            try self.fail(path, input, try std.fmt.allocPrint(a, "Expected type \"{s}\" to be an object.", .{named.name}));
            return null;
        }
        var out: std.ArrayList(Member) = .empty;
        for (named.input_fields) |field| {
            const field_value = lookup(input.object, field.name) orelse {
                if (field.default_value) |dv| {
                    if (try valueFromAst(a, dv, field.type, null)) |v| try out.append(a, .{ .key = field.name, .value = v });
                } else if (field.type.isNonNull()) {
                    try self.fail(path, input, try std.fmt.allocPrint(a, "Field \"{s}\" of required type \"{f}\" was not provided.", .{ field.name, field.type }));
                }
                continue;
            };
            const coerced = try self.coerce(field_value, field.type, try self.extend(path, .{ .key = field.name }));
            // Assigning undefined still creates the key (JSON.stringify drops it).
            if (coerced) |v| try out.append(a, .{ .key = field.name, .value = v });
        }
        for (try js.keyOrder(a, input.object)) |idx| {
            const key = input.object[idx].key;
            if (named.inputField(key) != null) continue;
            var names: std.ArrayList([]const u8) = .empty;
            for (named.input_fields) |f| try names.append(a, f.name);
            var msg: std.ArrayList(u8) = .empty;
            try msg.print(a, "Field \"{s}\" is not defined by type \"{s}\".", .{ key, named.name });
            try suggest.didYouMean(a, &msg, null, try suggest.suggestionList(a, key, names.items));
            try self.fail(path, input, msg.items);
        }
        return .{ .object = out.items };
    }

    fn coerceLeaf(self: *CoerceCtx, input: Value, named: *const NamedType, path: []const PathItem) Err!?Value {
        const a = self.a;
        if (named.kind == .@"enum") {
            if (input != .string) {
                const shown = try js.inspect(a, input);
                var msg: std.ArrayList(u8) = .empty;
                try msg.print(a, "Enum \"{s}\" cannot represent non-string value: {s}.", .{ named.name, shown });
                try suggest.didYouMean(a, &msg, "the enum value", try suggest.suggestionList(a, shown, named.enum_values));
                try self.fail(path, input, msg.items);
                return null;
            }
            if (!named.hasEnumValue(input.string)) {
                var msg: std.ArrayList(u8) = .empty;
                try msg.print(a, "Value \"{s}\" does not exist in \"{s}\" enum.", .{ input.string, named.name });
                try suggest.didYouMean(a, &msg, "the enum value", try suggest.suggestionList(a, input.string, named.enum_values));
                try self.fail(path, input, msg.items);
                return null;
            }
            return input;
        }
        const message: ?[]const u8 = switch (named.scalar) {
            .int => blk: {
                const n = js.asNumber(input) orelse break :blk try std.fmt.allocPrint(a, "Int cannot represent non-integer value: {s}", .{try js.inspect(a, input)});
                if (!isInteger(n)) break :blk try std.fmt.allocPrint(a, "Int cannot represent non-integer value: {s}", .{try js.inspect(a, input)});
                if (n > 2147483647 or n < -2147483648) break :blk try std.fmt.allocPrint(a, "Int cannot represent non 32-bit signed integer value: {s}", .{try js.numberString(a, n)});
                break :blk null;
            },
            .float => blk: {
                const n = js.asNumber(input) orelse break :blk try std.fmt.allocPrint(a, "Float cannot represent non numeric value: {s}", .{try js.inspect(a, input)});
                if (!std.math.isFinite(n)) break :blk try std.fmt.allocPrint(a, "Float cannot represent non numeric value: {s}", .{try js.inspect(a, input)});
                break :blk null;
            },
            .string => if (input != .string) try std.fmt.allocPrint(a, "String cannot represent a non string value: {s}", .{try js.inspect(a, input)}) else null,
            .boolean => if (input != .bool) try std.fmt.allocPrint(a, "Boolean cannot represent a non boolean value: {s}", .{try js.inspect(a, input)}) else null,
            .id => blk: {
                if (input == .string) break :blk null;
                if (js.asNumber(input)) |n| if (isInteger(n)) return .{ .string = try js.numberString(a, n) };
                break :blk try std.fmt.allocPrint(a, "ID cannot represent value: {s}", .{try js.inspect(a, input)});
            },
            .custom => null, // pass-through parseValue
        };
        if (message) |m| {
            try self.fail(path, input, m);
            return null;
        }
        return input;
    }
};

fn isInteger(n: f64) bool {
    return std.math.isFinite(n) and @floor(n) == n;
}

/// graphql-js `valueFromAST`; null = undefined (invalid).
pub fn valueFromAst(a: Allocator, node: *const ast.Value, t: *const TypeRef, vars: ?Variables) Allocator.Error!?Value {
    if (node.data == .variable) {
        const v = vars orelse return null;
        const value = v.get(node.data.variable.name.value) orelse return null;
        if (value == .null and t.isNonNull()) return null;
        return value;
    }
    switch (t.*) {
        .non_null => |inner| {
            if (node.data == .null) return null;
            return valueFromAst(a, node, inner, vars);
        },
        .list => |item_type| {
            if (node.data == .null) return Value.null;
            if (node.data == .list) {
                const items = node.data.list;
                const out = try a.alloc(Value, items.len);
                for (items, out) |item, *slot| {
                    if (isMissingVariable(item, vars)) {
                        if (item_type.isNonNull()) return null;
                        slot.* = .null;
                    } else {
                        slot.* = (try valueFromAst(a, item, item_type, vars)) orelse return null;
                    }
                }
                return .{ .array = out };
            }
            const single = (try valueFromAst(a, node, item_type, vars)) orelse return null;
            const out = try a.alloc(Value, 1);
            out[0] = single;
            return .{ .array = out };
        },
        .named => |named| {
            if (node.data == .null) return Value.null;
            switch (named.kind) {
                .input_object => {
                    if (node.data != .object) return null;
                    const fields = node.data.object;
                    var out: std.ArrayList(Member) = .empty;
                    for (named.input_fields) |field| {
                        // keyMap: the last duplicate field node wins.
                        var field_node: ?*const ast.ObjectField = null;
                        for (fields) |*f| if (std.mem.eql(u8, f.name.value, field.name)) {
                            field_node = f;
                        };
                        if (field_node == null or isMissingVariable(field_node.?.value, vars)) {
                            if (field.default_value) |dv| {
                                if (try valueFromAst(a, dv, field.type, null)) |v| try out.append(a, .{ .key = field.name, .value = v });
                            } else if (field.type.isNonNull()) return null;
                            continue;
                        }
                        const v = (try valueFromAst(a, field_node.?.value, field.type, vars)) orelse return null;
                        try out.append(a, .{ .key = field.name, .value = v });
                    }
                    return .{ .object = out.items };
                },
                .scalar, .@"enum" => return parseLiteral(a, named, node),
                .object => return null,
            }
        },
    }
}

fn isMissingVariable(node: *const ast.Value, vars: ?Variables) bool {
    if (node.data != .variable) return false;
    const v = vars orelse return true;
    return v.get(node.data.variable.name.value) == null;
}

/// Leaf `parseLiteral` success values (null when graphql-js would throw).
pub fn parseLiteral(a: Allocator, named: *const NamedType, node: *const ast.Value) Allocator.Error!?Value {
    _ = a;
    if (named.kind == .@"enum") {
        if (node.data != .enum_value or !named.hasEnumValue(node.data.enum_value)) return null;
        return .{ .string = node.data.enum_value };
    }
    return switch (named.scalar) {
        .int => if (node.data == .int) (if (validate.parseInt32(node.data.int)) |n| Value{ .number = @floatFromInt(n) } else null) else null,
        .float => switch (node.data) {
            .int, .float => |text| .{ .number = std.fmt.parseFloat(f64, text) catch return null },
            else => null,
        },
        .string => if (node.data == .string) Value{ .string = node.data.string.value } else null,
        .boolean => if (node.data == .boolean) Value{ .bool = node.data.boolean } else null,
        .id => switch (node.data) {
            .string => |s| .{ .string = s.value },
            .int => |text| .{ .string = text },
            else => null,
        },
        // scalars.ts passThroughScalar.parseLiteral returns `ast.value`.
        .custom => switch (node.data) {
            .string => |s| .{ .string = s.value },
            .int, .float => |text| .{ .string = text },
            .boolean => |b| .{ .bool = b },
            .null => .null,
            else => null,
        },
    };
}

pub const ArgumentsResult = union(enum) {
    ok: Value,
    err: CoercionError,
};

/// `getArgumentValues(def, node, variableValues)`: keys follow `def.args` order.
pub fn getArgumentValues(a: Allocator, def_args: []const InputValue, node_args: []const ast.Argument, node_loc: u32, vars: Variables) Allocator.Error!ArgumentsResult {
    var out: std.ArrayList(Member) = .empty;
    for (def_args) |arg_def| {
        const name = arg_def.name;
        // keyMap: the last duplicate argument wins.
        var arg_node: ?*const ast.Argument = null;
        for (node_args) |*n| if (std.mem.eql(u8, n.name.value, name)) {
            arg_node = n;
        };
        const node = arg_node orelse {
            if (arg_def.default_value) |dv| {
                if (try valueFromAst(a, dv, arg_def.type, null)) |v| try out.append(a, .{ .key = name, .value = v });
            } else if (arg_def.type.isNonNull()) {
                return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Argument \"{s}\" of required type \"{f}\" was not provided.", .{ name, arg_def.type }), .locations = try a.dupe(u32, &.{node_loc}) } };
            }
            continue;
        };
        const value_node = node.value;
        var is_null = value_node.data == .null;
        if (value_node.data == .variable) {
            const var_name = value_node.data.variable.name.value;
            const v = vars.get(var_name) orelse {
                if (arg_def.default_value) |dv| {
                    if (try valueFromAst(a, dv, arg_def.type, null)) |val| try out.append(a, .{ .key = name, .value = val });
                } else if (arg_def.type.isNonNull()) {
                    return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Argument \"{s}\" of required type \"{f}\" was provided the variable \"${s}\" which was not provided a runtime value.", .{ name, arg_def.type, var_name }), .locations = try a.dupe(u32, &.{value_node.loc}) } };
                }
                continue;
            };
            is_null = v == .null;
        }
        if (is_null and arg_def.type.isNonNull()) {
            return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Argument \"{s}\" of non-null type \"{f}\" must not be null.", .{ name, arg_def.type }), .locations = try a.dupe(u32, &.{value_node.loc}) } };
        }
        const coerced = (try valueFromAst(a, value_node, arg_def.type, vars)) orelse {
            return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Argument \"{s}\" has invalid value {s}.", .{ name, try printer.printValue(a, value_node) }), .locations = try a.dupe(u32, &.{value_node.loc}) } };
        };
        try out.append(a, .{ .key = name, .value = coerced });
    }
    return .{ .ok = .{ .object = out.items } };
}
