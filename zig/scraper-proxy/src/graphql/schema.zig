//! Schema model built at startup from SDL (graphql-js `buildSchema` subset):
//! the scraper SDL file, the Hasura-style types generated exactly like
//! `schema.ts`, the specified directives and the introspection types.
//! Interfaces/unions are not used by this schema and are rejected at build.
const std = @import("std");
const ast = @import("ast.zig");
const parser = @import("parser.zig");

pub const Kind = enum { scalar, object, @"enum", input_object };

/// Coercion behaviour of a scalar (graphql-js built-ins vs pass-through customs).
pub const ScalarKind = enum { int, float, string, boolean, id, custom };

pub const TypeRef = union(enum) {
    named: *NamedType,
    list: *const TypeRef,
    non_null: *const TypeRef,

    pub fn namedType(self: *const TypeRef) *NamedType {
        return switch (self.*) {
            .named => |t| t,
            .list, .non_null => |inner| inner.namedType(),
        };
    }

    pub fn nullable(self: *const TypeRef) *const TypeRef {
        return switch (self.*) {
            .non_null => |inner| inner,
            else => self,
        };
    }

    pub fn isNonNull(self: *const TypeRef) bool {
        return self.* == .non_null;
    }

    pub fn isList(self: *const TypeRef) bool {
        return self.nullable().* == .list;
    }

    pub fn format(self: *const TypeRef, w: *std.Io.Writer) std.Io.Writer.Error!void {
        switch (self.*) {
            .named => |t| try w.writeAll(t.name),
            .list => |inner| try w.print("[{f}]", .{inner}),
            .non_null => |inner| try w.print("{f}!", .{inner}),
        }
    }

    pub fn eql(a: *const TypeRef, b: *const TypeRef) bool {
        return switch (a.*) {
            .named => |t| b.* == .named and b.named == t,
            .list => |inner| b.* == .list and inner.eql(b.list),
            .non_null => |inner| b.* == .non_null and inner.eql(b.non_null),
        };
    }
};

pub const InputValue = struct {
    name: []const u8,
    type: *const TypeRef,
    default_value: ?*const ast.Value,
};

pub const Field = struct {
    name: []const u8,
    args: []const InputValue,
    type: *const TypeRef,

    pub fn arg(self: *const Field, name: []const u8) ?*const InputValue {
        return findInput(self.args, name);
    }
};

pub const NamedType = struct {
    name: []const u8,
    kind: Kind,
    scalar: ScalarKind = .custom,
    fields: []const Field = &.{},
    input_fields: []const InputValue = &.{},
    enum_values: []const []const u8 = &.{},
    is_one_of: bool = false,
    is_introspection: bool = false,
    // Self-reference for `TypeRef.named` without allocation.
    ref: TypeRef = undefined,

    pub fn field(self: *const NamedType, name: []const u8) ?*const Field {
        for (self.fields) |*f| if (std.mem.eql(u8, f.name, name)) return f;
        return null;
    }

    pub fn inputField(self: *const NamedType, name: []const u8) ?*const InputValue {
        return findInput(self.input_fields, name);
    }

    pub fn hasEnumValue(self: *const NamedType, name: []const u8) bool {
        for (self.enum_values) |v| if (std.mem.eql(u8, v, name)) return true;
        return false;
    }

    pub fn isInputType(self: *const NamedType) bool {
        return self.kind != .object;
    }

    pub fn isOutputType(self: *const NamedType) bool {
        return self.kind != .input_object;
    }

    pub fn isLeaf(self: *const NamedType) bool {
        return self.kind == .scalar or self.kind == .@"enum";
    }

    pub fn isComposite(self: *const NamedType) bool {
        return self.kind == .object;
    }
};

fn findInput(list: []const InputValue, name: []const u8) ?*const InputValue {
    for (list) |*v| if (std.mem.eql(u8, v.name, name)) return v;
    return null;
}

pub const DirectiveLocation = enum {
    QUERY,
    MUTATION,
    SUBSCRIPTION,
    FIELD,
    FRAGMENT_DEFINITION,
    FRAGMENT_SPREAD,
    INLINE_FRAGMENT,
    VARIABLE_DEFINITION,
    SCHEMA,
    SCALAR,
    OBJECT,
    FIELD_DEFINITION,
    ARGUMENT_DEFINITION,
    INTERFACE,
    UNION,
    ENUM,
    ENUM_VALUE,
    INPUT_OBJECT,
    INPUT_FIELD_DEFINITION,
    DIRECTIVE_DEFINITION,
};

pub const Directive = struct {
    name: []const u8,
    args: []const InputValue,
    locations: std.EnumSet(DirectiveLocation),
    repeatable: bool,

    pub fn arg(self: *const Directive, name: []const u8) ?*const InputValue {
        return findInput(self.args, name);
    }
};

pub const TableField = struct { name: []const u8, type_name: []const u8 };

pub const Table = enum {
    domain,
    message_view,
    raw_message_dispatch,
};

pub const Schema = struct {
    arena: std.heap.ArenaAllocator,
    types: std.StringHashMapUnmanaged(*NamedType) = .empty,
    /// Type map in graphql-js insertion order.
    type_list: std.ArrayList(*NamedType) = .empty,
    directives: std.ArrayList(Directive) = .empty,
    query_type: *NamedType = undefined,
    typename_field: Field = undefined,
    schema_field: Field = undefined,
    type_field: Field = undefined,
    table_fields: std.EnumArray(Table, []const TableField) = undefined,

    pub fn deinit(self: *Schema) void {
        self.arena.deinit();
    }

    pub fn getType(self: *const Schema, name: []const u8) ?*NamedType {
        return self.types.get(name);
    }

    pub fn directive(self: *const Schema, name: []const u8) ?*const Directive {
        for (self.directives.items) |*d| if (std.mem.eql(u8, d.name, name)) return d;
        return null;
    }

    /// graphql-js `getFieldDef` (meta fields first).
    pub fn fieldDef(self: *const Schema, parent: *const NamedType, name: []const u8) ?*const Field {
        if (std.mem.eql(u8, name, "__schema") and parent == self.query_type) return &self.schema_field;
        if (std.mem.eql(u8, name, "__type") and parent == self.query_type) return &self.type_field;
        if (std.mem.eql(u8, name, "__typename") and parent.kind == .object) return &self.typename_field;
        return parent.field(name);
    }

    pub fn tableFields(self: *const Schema, table: Table) []const TableField {
        return self.table_fields.get(table);
    }
};

pub const scraperdb_sdl = @embedFile("scraperdb-schema.graphql");

/// Builds the production schema: scraper SDL + generated Hasura shapes.
pub fn buildScraperSchema(gpa: std.mem.Allocator) !*Schema {
    var tmp = std.heap.ArenaAllocator.init(gpa);
    defer tmp.deinit();
    const generated = try generateHasuraTypes(tmp.allocator(), scraperdb_sdl);
    const sources = [_][]const u8{ scraperdb_sdl, generated };
    const schema = try buildSchema(gpa, &sources);
    errdefer {
        schema.deinit();
        gpa.destroy(schema);
    }
    inline for (comptime std.enums.values(Table)) |table| {
        schema.table_fields.set(table, try collectTableFields(schema, @tagName(table)));
    }
    return schema;
}

fn collectTableFields(schema: *Schema, name: []const u8) ![]const TableField {
    const ty = schema.getType(name) orelse return error.MissingTable;
    var list: std.ArrayList(TableField) = .empty;
    for (ty.fields) |f| {
        const scalar = f.type.nullable();
        if (scalar.* != .named) return error.ExpectedScalarColumn;
        try list.append(schema.arena.allocator(), .{ .name = f.name, .type_name = scalar.named.name });
    }
    return list.items;
}

/// `schema.ts`: filter/order/cursor/comparison inputs derived from the table row types.
pub fn generateHasuraTypes(arena: std.mem.Allocator, sdl: []const u8) ![]const u8 {
    var diag: parser.Diagnostic = .{};
    const doc = parser.parse(arena, sdl, .{}, &diag) catch |err| {
        std.log.err("scraper schema parse failed: {s}", .{diag.message});
        return err;
    };
    var out: std.Io.Writer.Allocating = .init(arena);
    const w = &out.writer;
    var scalar_types: std.ArrayList([]const u8) = .empty;
    const tables = [_][]const u8{ "domain", "message_view", "raw_message_dispatch" };
    for (tables) |table| {
        const def = findObjectDefinition(doc, table) orelse return error.MissingTable;
        var entries: std.ArrayList(TableField) = .empty;
        for (def.fields) |f| {
            const scalar = if (f.type.data == .non_null) f.type.data.non_null else f.type;
            if (scalar.data != .named) return error.ExpectedScalarColumn;
            const type_name = scalar.data.named.value;
            try entries.append(arena, .{ .name = f.name.value, .type_name = type_name });
            for (scalar_types.items) |seen| {
                if (std.mem.eql(u8, seen, type_name)) break;
            } else try scalar_types.append(arena, type_name);
        }
        try w.print("\nenum {s}_select_column {{", .{table});
        for (entries.items) |e| if (stored(e)) try w.print(" {s}", .{e.name});
        try w.print(" }}\ninput {s}_bool_exp {{ _and: [{s}_bool_exp!] _not: {s}_bool_exp _or: [{s}_bool_exp!]", .{ table, table, table, table });
        for (entries.items) |e| try w.print(" {s}: {s}_comparison_exp", .{ e.name, e.type_name });
        try w.print(" }}\ninput {s}_order_by {{", .{table});
        for (entries.items) |e| if (stored(e)) try w.print(" {s}: order_by", .{e.name});
        try w.print(" }}\ninput {s}_stream_cursor_value_input {{", .{table});
        for (entries.items) |e| if (stored(e)) try w.print(" {s}: {s}", .{ e.name, e.type_name });
        try w.print(" }}\ninput {s}_stream_cursor_input {{ initial_value: {s}_stream_cursor_value_input! ordering: cursor_ordering }}\n", .{ table, table });
    }
    for (scalar_types.items) |t| {
        try w.print("input {s}_comparison_exp {{", .{t});
        for ([_][]const u8{ "_eq", "_gt", "_gte", "_lt", "_lte", "_neq" }) |op| try w.print(" {s}: {s}", .{ op, t });
        try w.print(" _in: [{s}!] _nin: [{s}!] _is_null: Boolean }}\n", .{ t, t });
    }
    return out.written();
}

/// Computed snapshot state is selectable/filterable, but not a cursor/order/distinct key.
fn stored(e: TableField) bool {
    return !std.mem.eql(u8, e.name, "is_provisional");
}

fn findObjectDefinition(doc: *const ast.Document, name: []const u8) ?*const ast.TypeSystemDefinition {
    for (doc.definitions) |def| {
        if (def != .type_system) continue;
        const t = def.type_system;
        if (t.kind == .object and !t.extension and t.name != null and std.mem.eql(u8, t.name.?.value, name)) return t;
    }
    return null;
}

/// graphql-js specified directives and introspection types (printIntrospectionSchema).
const builtin_sdl =
    \\directive @include(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT
    \\directive @skip(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT
    \\directive @deprecated(reason: String = "No longer supported") on FIELD_DEFINITION | ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION | ENUM_VALUE | DIRECTIVE_DEFINITION
    \\directive @specifiedBy(url: String!) on SCALAR
    \\directive @oneOf on INPUT_OBJECT
    \\type __Schema { description: String types: [__Type!]! queryType: __Type! mutationType: __Type subscriptionType: __Type directives(includeDeprecated: Boolean! = false): [__Directive!]! }
    \\type __Type { kind: __TypeKind! name: String description: String specifiedByURL: String fields(includeDeprecated: Boolean = false): [__Field!] interfaces: [__Type!] possibleTypes: [__Type!] enumValues(includeDeprecated: Boolean = false): [__EnumValue!] inputFields(includeDeprecated: Boolean = false): [__InputValue!] ofType: __Type isOneOf: Boolean }
    \\enum __TypeKind { SCALAR OBJECT INTERFACE UNION ENUM INPUT_OBJECT LIST NON_NULL }
    \\type __Field { name: String! description: String args(includeDeprecated: Boolean = false): [__InputValue!]! type: __Type! isDeprecated: Boolean! deprecationReason: String }
    \\type __InputValue { name: String! description: String type: __Type! defaultValue: String isDeprecated: Boolean! deprecationReason: String }
    \\type __EnumValue { name: String! description: String isDeprecated: Boolean! deprecationReason: String }
    \\type __Directive { name: String! description: String isRepeatable: Boolean! locations: [__DirectiveLocation!]! args(includeDeprecated: Boolean = false): [__InputValue!]! isDeprecated: Boolean! deprecationReason: String }
    \\enum __DirectiveLocation { QUERY MUTATION SUBSCRIPTION FIELD FRAGMENT_DEFINITION FRAGMENT_SPREAD INLINE_FRAGMENT VARIABLE_DEFINITION SCHEMA SCALAR OBJECT FIELD_DEFINITION ARGUMENT_DEFINITION INTERFACE UNION ENUM ENUM_VALUE INPUT_OBJECT INPUT_FIELD_DEFINITION DIRECTIVE_DEFINITION }
;

const standard_scalars = [_]struct { name: []const u8, kind: ScalarKind }{
    .{ .name = "Int", .kind = .int },
    .{ .name = "Float", .kind = .float },
    .{ .name = "String", .kind = .string },
    .{ .name = "Boolean", .kind = .boolean },
    .{ .name = "ID", .kind = .id },
};

const Builder = struct {
    schema: *Schema,
    alloc: std.mem.Allocator,
    defs: std.ArrayList(*const ast.TypeSystemDefinition) = .empty,

    fn named(self: *Builder, name: []const u8) !*NamedType {
        if (self.schema.types.get(name)) |t| return t;
        for (standard_scalars) |s| {
            if (std.mem.eql(u8, s.name, name)) {
                return self.addType(.{ .name = s.name, .kind = .scalar, .scalar = s.kind });
            }
        }
        std.log.err("schema references unknown type {s}", .{name});
        return error.UnknownType;
    }

    fn addType(self: *Builder, value: NamedType) !*NamedType {
        const t = try self.alloc.create(NamedType);
        t.* = value;
        t.ref = .{ .named = t };
        try self.schema.types.put(self.alloc, t.name, t);
        try self.schema.type_list.append(self.alloc, t);
        return t;
    }

    fn typeRef(self: *Builder, node: *const ast.Type) !*const TypeRef {
        switch (node.data) {
            .named => |n| return &(try self.named(n.value)).ref,
            .list => |inner| {
                const r = try self.alloc.create(TypeRef);
                r.* = .{ .list = try self.typeRef(inner) };
                return r;
            },
            .non_null => |inner| {
                const r = try self.alloc.create(TypeRef);
                r.* = .{ .non_null = try self.typeRef(inner) };
                return r;
            },
        }
    }

    fn inputValues(self: *Builder, nodes: []const ast.InputValueDefinition) ![]const InputValue {
        const out = try self.alloc.alloc(InputValue, nodes.len);
        for (nodes, out) |n, *v| v.* = .{ .name = n.name.value, .type = try self.typeRef(n.type), .default_value = n.default_value };
        return out;
    }
};

/// graphql-js `buildSchema` for the supported SDL subset. `sources` are
/// concatenated documents (like mercurius joining a schema array).
pub fn buildSchema(gpa: std.mem.Allocator, sources: []const []const u8) !*Schema {
    const schema = try gpa.create(Schema);
    errdefer gpa.destroy(schema);
    schema.* = .{ .arena = std.heap.ArenaAllocator.init(gpa) };
    errdefer schema.arena.deinit();
    const alloc = schema.arena.allocator();
    var b: Builder = .{ .schema = schema, .alloc = alloc };

    // AST names slice the source text, so the schema owns copies.
    var all_sources: std.ArrayList([]const u8) = .empty;
    for (sources) |src| try all_sources.append(alloc, try alloc.dupe(u8, src));
    try all_sources.append(alloc, builtin_sdl);
    var query_name: ?[]const u8 = null;
    for (all_sources.items) |src| {
        var diag: parser.Diagnostic = .{};
        const doc = parser.parse(alloc, src, .{}, &diag) catch |err| {
            std.log.err("schema parse failed: {s}", .{diag.message});
            return err;
        };
        for (doc.definitions) |def| {
            if (def != .type_system) return error.ExecutableDefinitionInSchema;
            const t = def.type_system;
            switch (t.kind) {
                .interface, .@"union" => return error.UnsupportedTypeKind,
                .schema_definition, .schema_extension => {
                    for (t.operation_types) |op| {
                        if (op.operation != .query) return error.UnsupportedOperationType;
                        query_name = op.type.value;
                    }
                },
                else => try b.defs.append(alloc, t),
            }
        }
    }

    // Pass 1: create named types (definitions before extensions, document order).
    for (b.defs.items) |t| {
        if (t.extension or t.kind == .directive) continue;
        const name = t.name.?.value;
        if (schema.types.contains(name)) return error.DuplicateType;
        _ = try b.addType(.{
            .name = name,
            .kind = switch (t.kind) {
                .scalar => .scalar,
                .object => .object,
                .@"enum" => .@"enum",
                .input_object => .input_object,
                else => unreachable,
            },
            .is_introspection = std.mem.startsWith(u8, name, "__"),
        });
    }
    // Pass 2: members, merging extensions in document order after the definition.
    for (schema.type_list.items) |ty| {
        var fields: std.ArrayList(Field) = .empty;
        var input_fields: std.ArrayList(InputValue) = .empty;
        var enum_values: std.ArrayList([]const u8) = .empty;
        for (b.defs.items) |t| {
            if (t.kind == .directive or !std.mem.eql(u8, t.name.?.value, ty.name)) continue;
            for (t.fields) |f| {
                try fields.append(alloc, .{ .name = f.name.value, .args = try b.inputValues(f.arguments), .type = try b.typeRef(f.type) });
            }
            for (t.input_fields) |f| {
                try input_fields.append(alloc, .{ .name = f.name.value, .type = try b.typeRef(f.type), .default_value = f.default_value });
            }
            for (t.enum_values) |v| try enum_values.append(alloc, v.name.value);
            for (t.directives) |d| {
                if (std.mem.eql(u8, d.name.value, "oneOf")) ty.is_one_of = true;
            }
        }
        ty.fields = fields.items;
        ty.input_fields = input_fields.items;
        ty.enum_values = enum_values.items;
    }
    for (b.defs.items) |t| {
        if (t.kind != .directive) continue;
        var locations = std.EnumSet(DirectiveLocation).initEmpty();
        for (t.locations) |l| locations.insert(std.meta.stringToEnum(DirectiveLocation, l.value) orelse return error.BadDirectiveLocation);
        try schema.directives.append(alloc, .{
            .name = t.name.?.value,
            .args = try b.inputValues(t.arguments),
            .locations = locations,
            .repeatable = t.repeatable,
        });
    }
    // graphql-js lists specified directives first, then the SDL's own.
    std.mem.sort(Directive, schema.directives.items, {}, struct {
        fn lessThan(_: void, a: Directive, bd: Directive) bool {
            return specifiedRank(a.name) < specifiedRank(bd.name);
        }
    }.lessThan);
    schema.query_type = schema.types.get(query_name orelse "Query") orelse return error.MissingQueryType;
    const string_ref = &(try b.named("String")).ref;
    const non_null_string = try alloc.create(TypeRef);
    non_null_string.* = .{ .non_null = string_ref };
    schema.typename_field = .{ .name = "__typename", .args = &.{}, .type = non_null_string };
    const schema_ref = try alloc.create(TypeRef);
    schema_ref.* = .{ .non_null = &(try b.named("__Schema")).ref };
    schema.schema_field = .{ .name = "__schema", .args = &.{}, .type = schema_ref };
    const name_arg = try alloc.alloc(InputValue, 1);
    name_arg[0] = .{ .name = "name", .type = non_null_string, .default_value = null };
    schema.type_field = .{ .name = "__type", .args = name_arg, .type = &(try b.named("__Type")).ref };
    return schema;
}

fn specifiedRank(name: []const u8) usize {
    const order = [_][]const u8{ "include", "skip", "deprecated", "specifiedBy", "oneOf" };
    for (order, 0..) |n, i| if (std.mem.eql(u8, n, name)) return i;
    return order.len;
}

pub const testing = struct {
    var cached: ?*Schema = null;
    var mutex: std.Thread.Mutex = .{};

    /// Shared production schema for tests (built once, never freed).
    pub fn scraper() *Schema {
        mutex.lock();
        defer mutex.unlock();
        if (cached) |s| return s;
        cached = buildScraperSchema(std.heap.page_allocator) catch @panic("schema build failed");
        return cached.?;
    }
};

test "only exposes GraphQL queries" {
    const s = testing.scraper();
    try std.testing.expectEqualStrings("query_root", s.query_type.name);
    try std.testing.expect(s.getType("String_comparison_exp") != null);
    try std.testing.expect(s.getType("ID") == null);
    try std.testing.expect(s.getType("__Schema") != null);
    try std.testing.expect(s.query_type.field("message_view_aggregate") != null);
    try std.testing.expect(s.query_type.field("message_activity") != null);
}

test "removes unsupported regex operators; generated types follow schema.ts" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const generated = try generateHasuraTypes(arena.allocator(), scraperdb_sdl);
    try std.testing.expect(std.mem.indexOf(u8, generated, "_regex") == null);
    try std.testing.expect(std.mem.indexOf(u8, scraperdb_sdl, "_regex") == null);
    const s = testing.scraper();
    const bool_exp = s.getType("message_view_bool_exp").?;
    try std.testing.expectEqualStrings("_and", bool_exp.input_fields[0].name);
    try std.testing.expect(bool_exp.inputField("is_provisional") != null);
    try std.testing.expect(s.getType("message_view_order_by").?.inputField("is_provisional") == null);
    try std.testing.expect(!s.getType("message_view_select_column").?.hasEnumValue("is_provisional"));
    const domain = s.tableFields(.domain);
    try std.testing.expectEqualStrings("chain_id", domain[0].name);
    try std.testing.expectEqualStrings("bigint", domain[0].type_name);
    const cmp = s.getType("bigint_comparison_exp").?;
    try std.testing.expectEqual(@as(usize, 9), cmp.input_fields.len);
}
