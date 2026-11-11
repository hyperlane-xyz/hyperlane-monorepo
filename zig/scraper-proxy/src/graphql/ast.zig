//! GraphQL AST (graphql-js shape). Every node records the byte offset of its
//! first token (`loc`); line/column are derived on demand (see `location`).
const std = @import("std");

pub const Name = struct { value: []const u8, loc: u32 };

pub const OperationType = enum {
    query,
    mutation,
    subscription,

    pub fn text(self: OperationType) []const u8 {
        return @tagName(self);
    }
};

pub const Value = struct {
    loc: u32,
    data: Data,

    pub const Data = union(enum) {
        variable: Variable,
        int: []const u8,
        float: []const u8,
        string: StringValue,
        boolean: bool,
        null,
        enum_value: []const u8,
        list: []const *Value,
        object: []const ObjectField,
    };
};

pub const StringValue = struct { value: []const u8, block: bool };

/// `$name`: `loc` is the `$` token, `name.loc` the name token.
pub const Variable = struct { loc: u32, name: Name };

pub const ObjectField = struct { loc: u32, name: Name, value: *Value };

pub const Argument = struct { loc: u32, name: Name, value: *Value };

pub const Directive = struct { loc: u32, name: Name, arguments: []const Argument };

pub const Type = struct {
    loc: u32,
    data: union(enum) {
        named: Name,
        list: *Type,
        non_null: *Type,
    },

    pub fn namedType(self: *const Type) Name {
        return switch (self.data) {
            .named => |n| n,
            .list, .non_null => |inner| inner.namedType(),
        };
    }
};

pub const VariableDefinition = struct {
    loc: u32,
    description: ?StringValue,
    variable: Variable,
    type: *Type,
    default_value: ?*Value,
    directives: []const Directive,
};

pub const Field = struct {
    loc: u32,
    alias: ?Name,
    name: Name,
    arguments: []const Argument,
    directives: []const Directive,
    selection_set: ?*SelectionSet,

    pub fn responseName(self: *const Field) []const u8 {
        return if (self.alias) |a| a.value else self.name.value;
    }
};

pub const FragmentSpread = struct { loc: u32, name: Name, directives: []const Directive };

pub const InlineFragment = struct {
    loc: u32,
    type_condition: ?Name,
    directives: []const Directive,
    selection_set: *SelectionSet,
};

pub const Selection = union(enum) {
    field: *Field,
    fragment_spread: *FragmentSpread,
    inline_fragment: *InlineFragment,

    pub fn loc(self: Selection) u32 {
        return switch (self) {
            inline else => |s| s.loc,
        };
    }
};

pub const SelectionSet = struct { loc: u32, selections: []const Selection };

pub const Operation = struct {
    loc: u32,
    operation: OperationType,
    description: ?StringValue,
    name: ?Name,
    variable_definitions: []const VariableDefinition,
    directives: []const Directive,
    selection_set: *SelectionSet,
};

pub const Fragment = struct {
    loc: u32,
    description: ?StringValue,
    name: Name,
    type_condition: Name,
    directives: []const Directive,
    selection_set: *SelectionSet,
};

// Type system definitions (SDL). Only what the schema loader needs is kept.
pub const InputValueDefinition = struct {
    loc: u32,
    description: ?StringValue,
    name: Name,
    type: *Type,
    default_value: ?*Value,
    directives: []const Directive,
};

pub const FieldDefinition = struct {
    loc: u32,
    description: ?StringValue,
    name: Name,
    arguments: []const InputValueDefinition,
    type: *Type,
    directives: []const Directive,
};

pub const EnumValueDefinition = struct { loc: u32, description: ?StringValue, name: Name, directives: []const Directive };

pub const OperationTypeDefinition = struct { loc: u32, operation: OperationType, type: Name };

pub const TypeSystemKind = enum {
    schema_definition,
    schema_extension,
    scalar,
    object,
    interface,
    @"union",
    @"enum",
    input_object,
    directive,
};

pub const TypeSystemDefinition = struct {
    loc: u32,
    kind: TypeSystemKind,
    extension: bool,
    description: ?StringValue = null,
    /// Absent for schema definitions/extensions.
    name: ?Name = null,
    directives: []const Directive = &.{},
    interfaces: []const Name = &.{},
    fields: []const FieldDefinition = &.{},
    input_fields: []const InputValueDefinition = &.{},
    enum_values: []const EnumValueDefinition = &.{},
    union_types: []const Name = &.{},
    operation_types: []const OperationTypeDefinition = &.{},
    // Directive definitions.
    arguments: []const InputValueDefinition = &.{},
    repeatable: bool = false,
    locations: []const Name = &.{},
};

pub const Definition = union(enum) {
    operation: *Operation,
    fragment: *Fragment,
    type_system: *TypeSystemDefinition,

    pub fn loc(self: Definition) u32 {
        return switch (self) {
            inline else => |d| d.loc,
        };
    }
};

pub const Document = struct {
    source: []const u8,
    definitions: []const Definition,
    token_count: u32,
};

pub const SourceLocation = struct { line: u32, column: u32 };

/// graphql-js `getLocation`: lines split on \r\n, \n or \r; the column counts
/// UTF-16 code units (JS string indices) from the line start.
pub fn location(source: []const u8, offset: u32) SourceLocation {
    var line: u32 = 1;
    var line_start: usize = 0;
    var i: usize = 0;
    const end = @min(offset, source.len);
    while (i < end) : (i += 1) {
        switch (source[i]) {
            '\n' => {
                line += 1;
                line_start = i + 1;
            },
            '\r' => {
                if (i + 1 < source.len and source[i + 1] == '\n') {
                    // A \r\n pair at the offset still counts as one break before it.
                    i += 1;
                }
                line += 1;
                line_start = i + 1;
            },
            else => {},
        }
    }
    return .{ .line = line, .column = 1 + utf16Length(source[line_start..end]) };
}

/// Number of UTF-16 code units for UTF-8 bytes (4-byte sequences count twice).
pub fn utf16Length(bytes: []const u8) u32 {
    var n: u32 = 0;
    for (bytes) |b| {
        if (b & 0xC0 != 0x80) n += 1; // lead or ASCII byte
        if (b >= 0xF0) n += 1; // supplementary plane -> surrogate pair
    }
    return n;
}

test "location counts utf16 columns" {
    const src = "# h\xc3\xa9llo \xf0\x9f\x98\x80\n{ \xf0\x9f\x98\x80 }";
    const at = std.mem.indexOf(u8, src, "{").? + 2;
    const loc = location(src, @intCast(at));
    try std.testing.expectEqual(@as(u32, 2), loc.line);
    try std.testing.expectEqual(@as(u32, 3), loc.column);
    const loc2 = location("ab\xf0\x9f\x98\x80c", 6);
    try std.testing.expectEqual(@as(u32, 5), loc2.column);
    const crlf = location("a\r\nb\rc", 5);
    try std.testing.expectEqual(@as(u32, 3), crlf.line);
}
