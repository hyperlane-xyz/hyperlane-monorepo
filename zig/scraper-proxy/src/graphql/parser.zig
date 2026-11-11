//! graphql-js 16 recursive-descent parser port (executable + SDL documents),
//! including the `maxTokens` limit and its exact error text.
const std = @import("std");
const ast = @import("ast.zig");
const lexer_mod = @import("lexer.zig");

const Lexer = lexer_mod.Lexer;
const Token = lexer_mod.Token;
const TokenKind = lexer_mod.TokenKind;
pub const Diagnostic = lexer_mod.Diagnostic;
pub const Error = lexer_mod.Error;

pub const Options = struct { max_tokens: ?u32 = null };

pub fn parse(arena: std.mem.Allocator, source: []const u8, options: Options, diag: *Diagnostic) Error!*ast.Document {
    var p: Parser = .{ .lx = Lexer.init(arena, source, diag), .arena = arena, .options = options };
    return p.parseDocument();
}

const Parser = struct {
    lx: Lexer,
    arena: std.mem.Allocator,
    options: Options,
    token_count: u32 = 0,

    fn create(self: *Parser, comptime T: type, value: T) Error!*T {
        const ptr = try self.arena.create(T);
        ptr.* = value;
        return ptr;
    }

    fn fail(self: *Parser, offset: u32, comptime fmt: []const u8, args: anytype) Error {
        self.lx.diag.* = .{
            .message = try std.fmt.allocPrint(self.arena, "Syntax Error: " ++ fmt, args),
            .offset = offset,
        };
        return error.SyntaxError;
    }

    fn cur(self: *const Parser) Token {
        return self.lx.token;
    }

    fn peek(self: *const Parser, kind: TokenKind) bool {
        return self.lx.token.kind == kind;
    }

    fn advance(self: *Parser) Error!void {
        const token = try self.lx.advance();
        if (token.kind != .eof) {
            self.token_count += 1;
            if (self.options.max_tokens) |max| {
                if (self.token_count > max) {
                    return self.fail(token.start, "Document contains more that {d} tokens. Parsing aborted.", .{max});
                }
            }
        }
    }

    fn expectToken(self: *Parser, kind: TokenKind) Error!Token {
        const token = self.lx.token;
        if (token.kind == kind) {
            try self.advance();
            return token;
        }
        return self.fail(token.start, "Expected {s}, found {f}.", .{ kind.desc(), TokenDesc{ .token = token } });
    }

    fn expectOptionalToken(self: *Parser, kind: TokenKind) Error!bool {
        if (self.lx.token.kind == kind) {
            try self.advance();
            return true;
        }
        return false;
    }

    fn expectKeyword(self: *Parser, value: []const u8) Error!void {
        const token = self.lx.token;
        if (token.kind == .name and std.mem.eql(u8, token.value, value)) return self.advance();
        return self.fail(token.start, "Expected \"{s}\", found {f}.", .{ value, TokenDesc{ .token = token } });
    }

    fn expectOptionalKeyword(self: *Parser, value: []const u8) Error!bool {
        const token = self.lx.token;
        if (token.kind == .name and std.mem.eql(u8, token.value, value)) {
            try self.advance();
            return true;
        }
        return false;
    }

    fn unexpected(self: *Parser, token: Token) Error {
        return self.fail(token.start, "Unexpected {f}.", .{TokenDesc{ .token = token }});
    }

    fn parseName(self: *Parser) Error!ast.Name {
        const token = try self.expectToken(.name);
        return .{ .value = token.value, .loc = token.start };
    }

    fn parseDocument(self: *Parser) Error!*ast.Document {
        var defs: std.ArrayList(ast.Definition) = .empty;
        _ = try self.expectToken(.sof);
        while (true) {
            try defs.append(self.arena, try self.parseDefinition());
            if (try self.expectOptionalToken(.eof)) break;
        }
        return self.create(ast.Document, .{ .source = self.lx.source, .definitions = defs.items, .token_count = self.token_count });
    }

    fn peekDescription(self: *const Parser) bool {
        return self.peek(.string) or self.peek(.block_string);
    }

    fn parseDefinition(self: *Parser) Error!ast.Definition {
        if (self.peek(.brace_l)) return .{ .operation = try self.parseOperationDefinition() };
        const has_description = self.peekDescription();
        const keyword = if (has_description) try self.lx.lookahead() else self.lx.token;
        if (has_description and keyword.kind == .brace_l) {
            return self.fail(self.cur().start, "Unexpected description, descriptions are not supported on shorthand queries.", .{});
        }
        if (keyword.kind == .name) {
            const kw = keyword.value;
            const type_system = [_][]const u8{ "schema", "scalar", "type", "interface", "union", "enum", "input", "directive" };
            for (type_system) |name| {
                if (std.mem.eql(u8, kw, name)) return .{ .type_system = try self.parseTypeSystemDefinition(kw, false) };
            }
            if (eql(kw, "query") or eql(kw, "mutation") or eql(kw, "subscription")) {
                return .{ .operation = try self.parseOperationDefinition() };
            }
            if (eql(kw, "fragment")) return .{ .fragment = try self.parseFragmentDefinition() };
            if (has_description) {
                return self.fail(self.cur().start, "Unexpected description, only GraphQL definitions support descriptions.", .{});
            }
            if (eql(kw, "extend")) return .{ .type_system = try self.parseTypeSystemExtension() };
        }
        return self.unexpected(keyword);
    }

    fn parseOperationDefinition(self: *Parser) Error!*ast.Operation {
        const start = self.cur().start;
        if (self.peek(.brace_l)) {
            return self.create(ast.Operation, .{
                .loc = start,
                .operation = .query,
                .description = null,
                .name = null,
                .variable_definitions = &.{},
                .directives = &.{},
                .selection_set = try self.parseSelectionSet(),
            });
        }
        const description = try self.parseDescription();
        const operation = try self.parseOperationType();
        const name = if (self.peek(.name)) try self.parseName() else null;
        const vars = try self.parseVariableDefinitions();
        const directives = try self.parseDirectives(false);
        return self.create(ast.Operation, .{
            .loc = start,
            .operation = operation,
            .description = description,
            .name = name,
            .variable_definitions = vars,
            .directives = directives,
            .selection_set = try self.parseSelectionSet(),
        });
    }

    fn parseOperationType(self: *Parser) Error!ast.OperationType {
        const token = try self.expectToken(.name);
        if (eql(token.value, "query")) return .query;
        if (eql(token.value, "mutation")) return .mutation;
        if (eql(token.value, "subscription")) return .subscription;
        return self.unexpected(token);
    }

    fn parseVariableDefinitions(self: *Parser) Error![]const ast.VariableDefinition {
        var list: std.ArrayList(ast.VariableDefinition) = .empty;
        if (try self.expectOptionalToken(.paren_l)) {
            while (true) {
                try list.append(self.arena, try self.parseVariableDefinition());
                if (try self.expectOptionalToken(.paren_r)) break;
            }
        }
        return list.items;
    }

    fn parseVariableDefinition(self: *Parser) Error!ast.VariableDefinition {
        const start = self.cur().start;
        const description = try self.parseDescription();
        const variable = try self.parseVariable();
        _ = try self.expectToken(.colon);
        const ty = try self.parseTypeReference();
        const default_value = if (try self.expectOptionalToken(.equals)) try self.parseValueLiteral(true) else null;
        return .{
            .loc = start,
            .description = description,
            .variable = variable,
            .type = ty,
            .default_value = default_value,
            .directives = try self.parseDirectives(true),
        };
    }

    fn parseVariable(self: *Parser) Error!ast.Variable {
        const start = self.cur().start;
        _ = try self.expectToken(.dollar);
        return .{ .loc = start, .name = try self.parseName() };
    }

    fn parseSelectionSet(self: *Parser) Error!*ast.SelectionSet {
        const start = self.cur().start;
        var list: std.ArrayList(ast.Selection) = .empty;
        _ = try self.expectToken(.brace_l);
        while (true) {
            try list.append(self.arena, try self.parseSelection());
            if (try self.expectOptionalToken(.brace_r)) break;
        }
        return self.create(ast.SelectionSet, .{ .loc = start, .selections = list.items });
    }

    fn parseSelection(self: *Parser) Error!ast.Selection {
        if (self.peek(.spread)) return self.parseFragment();
        return .{ .field = try self.parseField() };
    }

    fn parseField(self: *Parser) Error!*ast.Field {
        const start = self.cur().start;
        const name_or_alias = try self.parseName();
        var alias: ?ast.Name = null;
        var name = name_or_alias;
        if (try self.expectOptionalToken(.colon)) {
            alias = name_or_alias;
            name = try self.parseName();
        }
        const args = try self.parseArguments(false);
        const directives = try self.parseDirectives(false);
        const selection_set = if (self.peek(.brace_l)) try self.parseSelectionSet() else null;
        return self.create(ast.Field, .{
            .loc = start,
            .alias = alias,
            .name = name,
            .arguments = args,
            .directives = directives,
            .selection_set = selection_set,
        });
    }

    fn parseArguments(self: *Parser, is_const: bool) Error![]const ast.Argument {
        var list: std.ArrayList(ast.Argument) = .empty;
        if (try self.expectOptionalToken(.paren_l)) {
            while (true) {
                const start = self.cur().start;
                const name = try self.parseName();
                _ = try self.expectToken(.colon);
                try list.append(self.arena, .{ .loc = start, .name = name, .value = try self.parseValueLiteral(is_const) });
                if (try self.expectOptionalToken(.paren_r)) break;
            }
        }
        return list.items;
    }

    fn parseFragment(self: *Parser) Error!ast.Selection {
        const start = self.cur().start;
        _ = try self.expectToken(.spread);
        const has_type_condition = try self.expectOptionalKeyword("on");
        if (!has_type_condition and self.peek(.name)) {
            const name = try self.parseFragmentName();
            return .{ .fragment_spread = try self.create(ast.FragmentSpread, .{
                .loc = start,
                .name = name,
                .directives = try self.parseDirectives(false),
            }) };
        }
        const type_condition = if (has_type_condition) try self.parseName() else null;
        const directives = try self.parseDirectives(false);
        return .{ .inline_fragment = try self.create(ast.InlineFragment, .{
            .loc = start,
            .type_condition = type_condition,
            .directives = directives,
            .selection_set = try self.parseSelectionSet(),
        }) };
    }

    fn parseFragmentDefinition(self: *Parser) Error!*ast.Fragment {
        const start = self.cur().start;
        const description = try self.parseDescription();
        try self.expectKeyword("fragment");
        const name = try self.parseFragmentName();
        try self.expectKeyword("on");
        const type_condition = try self.parseName();
        const directives = try self.parseDirectives(false);
        return self.create(ast.Fragment, .{
            .loc = start,
            .description = description,
            .name = name,
            .type_condition = type_condition,
            .directives = directives,
            .selection_set = try self.parseSelectionSet(),
        });
    }

    fn parseFragmentName(self: *Parser) Error!ast.Name {
        if (self.cur().kind == .name and eql(self.cur().value, "on")) return self.unexpected(self.cur());
        return self.parseName();
    }

    fn parseValueLiteral(self: *Parser, is_const: bool) Error!*ast.Value {
        const token = self.cur();
        const data: ast.Value.Data = switch (token.kind) {
            .bracket_l => {
                var list: std.ArrayList(*ast.Value) = .empty;
                _ = try self.expectToken(.bracket_l);
                while (!try self.expectOptionalToken(.bracket_r)) {
                    try list.append(self.arena, try self.parseValueLiteral(is_const));
                }
                return self.create(ast.Value, .{ .loc = token.start, .data = .{ .list = list.items } });
            },
            .brace_l => {
                var fields: std.ArrayList(ast.ObjectField) = .empty;
                _ = try self.expectToken(.brace_l);
                while (!try self.expectOptionalToken(.brace_r)) {
                    const start = self.cur().start;
                    const name = try self.parseName();
                    _ = try self.expectToken(.colon);
                    try fields.append(self.arena, .{ .loc = start, .name = name, .value = try self.parseValueLiteral(is_const) });
                }
                return self.create(ast.Value, .{ .loc = token.start, .data = .{ .object = fields.items } });
            },
            .int => blk: {
                try self.advance();
                break :blk .{ .int = token.value };
            },
            .float => blk: {
                try self.advance();
                break :blk .{ .float = token.value };
            },
            .string, .block_string => blk: {
                try self.advance();
                break :blk .{ .string = .{ .value = token.value, .block = token.kind == .block_string } };
            },
            .name => blk: {
                try self.advance();
                if (eql(token.value, "true")) break :blk .{ .boolean = true };
                if (eql(token.value, "false")) break :blk .{ .boolean = false };
                if (eql(token.value, "null")) break :blk .null;
                break :blk .{ .enum_value = token.value };
            },
            .dollar => blk: {
                if (is_const) {
                    _ = try self.expectToken(.dollar);
                    if (self.cur().kind == .name) {
                        return self.fail(token.start, "Unexpected variable \"${s}\" in constant value.", .{self.cur().value});
                    }
                    return self.unexpected(token);
                }
                break :blk .{ .variable = try self.parseVariable() };
            },
            else => return self.unexpected(token),
        };
        return self.create(ast.Value, .{ .loc = token.start, .data = data });
    }

    fn parseDirectives(self: *Parser, is_const: bool) Error![]const ast.Directive {
        var list: std.ArrayList(ast.Directive) = .empty;
        while (self.peek(.at)) {
            const start = self.cur().start;
            _ = try self.expectToken(.at);
            const name = try self.parseName();
            try list.append(self.arena, .{ .loc = start, .name = name, .arguments = try self.parseArguments(is_const) });
        }
        return list.items;
    }

    fn parseTypeReference(self: *Parser) Error!*ast.Type {
        const start = self.cur().start;
        var ty: *ast.Type = undefined;
        if (try self.expectOptionalToken(.bracket_l)) {
            const inner = try self.parseTypeReference();
            _ = try self.expectToken(.bracket_r);
            ty = try self.create(ast.Type, .{ .loc = start, .data = .{ .list = inner } });
        } else {
            ty = try self.create(ast.Type, .{ .loc = start, .data = .{ .named = try self.parseName() } });
        }
        if (try self.expectOptionalToken(.bang)) {
            return self.create(ast.Type, .{ .loc = start, .data = .{ .non_null = ty } });
        }
        return ty;
    }

    fn parseDescription(self: *Parser) Error!?ast.StringValue {
        if (!self.peekDescription()) return null;
        const token = self.cur();
        try self.advance();
        return .{ .value = token.value, .block = token.kind == .block_string };
    }

    // ---- Type system (SDL) ----

    fn parseTypeSystemDefinition(self: *Parser, keyword: []const u8, extension: bool) Error!*ast.TypeSystemDefinition {
        const start = self.cur().start;
        var def: ast.TypeSystemDefinition = .{ .loc = start, .kind = .scalar, .extension = extension };
        if (!extension) def.description = try self.parseDescription();
        try self.expectKeyword(keyword);
        if (eql(keyword, "schema")) {
            def.kind = if (extension) .schema_extension else .schema_definition;
            def.directives = try self.parseDirectives(true);
            var ops: std.ArrayList(ast.OperationTypeDefinition) = .empty;
            const required = !extension;
            if (required) {
                _ = try self.expectToken(.brace_l);
            } else if (!try self.expectOptionalToken(.brace_l)) {
                if (def.directives.len == 0) return self.unexpected(self.cur());
                return self.create(ast.TypeSystemDefinition, def);
            }
            while (true) {
                const op_start = self.cur().start;
                const operation = try self.parseOperationType();
                _ = try self.expectToken(.colon);
                try ops.append(self.arena, .{ .loc = op_start, .operation = operation, .type = try self.parseName() });
                if (try self.expectOptionalToken(.brace_r)) break;
            }
            def.operation_types = ops.items;
            return self.create(ast.TypeSystemDefinition, def);
        }
        if (eql(keyword, "directive")) {
            def.kind = .directive;
            _ = try self.expectToken(.at);
            def.name = try self.parseName();
            def.arguments = try self.parseInputValueDefs(.paren_l, .paren_r);
            def.repeatable = try self.expectOptionalKeyword("repeatable");
            try self.expectKeyword("on");
            var locations: std.ArrayList(ast.Name) = .empty;
            _ = try self.expectOptionalToken(.pipe);
            while (true) {
                const token = self.cur();
                const name = try self.parseName();
                if (!isDirectiveLocation(name.value)) return self.unexpected(token);
                try locations.append(self.arena, name);
                if (!try self.expectOptionalToken(.pipe)) break;
            }
            def.locations = locations.items;
            return self.create(ast.TypeSystemDefinition, def);
        }
        def.name = try self.parseName();
        if (eql(keyword, "scalar")) {
            def.kind = .scalar;
            def.directives = try self.parseDirectives(true);
            if (extension and def.directives.len == 0) return self.unexpected(self.cur());
        } else if (eql(keyword, "type") or eql(keyword, "interface")) {
            def.kind = if (eql(keyword, "type")) .object else .interface;
            if (try self.expectOptionalKeyword("implements")) {
                var names: std.ArrayList(ast.Name) = .empty;
                _ = try self.expectOptionalToken(.amp);
                while (true) {
                    try names.append(self.arena, try self.parseName());
                    if (!try self.expectOptionalToken(.amp)) break;
                }
                def.interfaces = names.items;
            }
            def.directives = try self.parseDirectives(true);
            def.fields = try self.parseFieldsDefinition();
            if (extension and def.interfaces.len == 0 and def.directives.len == 0 and def.fields.len == 0) return self.unexpected(self.cur());
        } else if (eql(keyword, "union")) {
            def.kind = .@"union";
            def.directives = try self.parseDirectives(true);
            if (try self.expectOptionalToken(.equals)) {
                var names: std.ArrayList(ast.Name) = .empty;
                _ = try self.expectOptionalToken(.pipe);
                while (true) {
                    try names.append(self.arena, try self.parseName());
                    if (!try self.expectOptionalToken(.pipe)) break;
                }
                def.union_types = names.items;
            }
            if (extension and def.directives.len == 0 and def.union_types.len == 0) return self.unexpected(self.cur());
        } else if (eql(keyword, "enum")) {
            def.kind = .@"enum";
            def.directives = try self.parseDirectives(true);
            var values: std.ArrayList(ast.EnumValueDefinition) = .empty;
            if (try self.expectOptionalToken(.brace_l)) {
                while (true) {
                    const value_start = self.cur().start;
                    const description = try self.parseDescription();
                    const token = self.cur();
                    if (token.kind == .name and (eql(token.value, "true") or eql(token.value, "false") or eql(token.value, "null"))) {
                        return self.fail(token.start, "{f} is reserved and cannot be used for an enum value.", .{TokenDesc{ .token = token }});
                    }
                    const name = try self.parseName();
                    try values.append(self.arena, .{ .loc = value_start, .description = description, .name = name, .directives = try self.parseDirectives(true) });
                    if (try self.expectOptionalToken(.brace_r)) break;
                }
            }
            def.enum_values = values.items;
            if (extension and def.directives.len == 0 and def.enum_values.len == 0) return self.unexpected(self.cur());
        } else if (eql(keyword, "input")) {
            def.kind = .input_object;
            def.directives = try self.parseDirectives(true);
            def.input_fields = try self.parseInputValueDefs(.brace_l, .brace_r);
            if (extension and def.directives.len == 0 and def.input_fields.len == 0) return self.unexpected(self.cur());
        }
        return self.create(ast.TypeSystemDefinition, def);
    }

    fn parseTypeSystemExtension(self: *Parser) Error!*ast.TypeSystemDefinition {
        const keyword = try self.lx.lookahead();
        if (keyword.kind == .name) {
            const kinds = [_][]const u8{ "schema", "scalar", "type", "interface", "union", "enum", "input" };
            for (kinds) |name| {
                if (eql(keyword.value, name)) {
                    try self.expectKeyword("extend");
                    return self.parseTypeSystemDefinition(name, true);
                }
            }
        }
        return self.unexpected(keyword);
    }

    fn parseFieldsDefinition(self: *Parser) Error![]const ast.FieldDefinition {
        var list: std.ArrayList(ast.FieldDefinition) = .empty;
        if (try self.expectOptionalToken(.brace_l)) {
            while (true) {
                const start = self.cur().start;
                const description = try self.parseDescription();
                const name = try self.parseName();
                const args = try self.parseInputValueDefs(.paren_l, .paren_r);
                _ = try self.expectToken(.colon);
                const ty = try self.parseTypeReference();
                try list.append(self.arena, .{
                    .loc = start,
                    .description = description,
                    .name = name,
                    .arguments = args,
                    .type = ty,
                    .directives = try self.parseDirectives(true),
                });
                if (try self.expectOptionalToken(.brace_r)) break;
            }
        }
        return list.items;
    }

    fn parseInputValueDefs(self: *Parser, open: TokenKind, close: TokenKind) Error![]const ast.InputValueDefinition {
        var list: std.ArrayList(ast.InputValueDefinition) = .empty;
        if (try self.expectOptionalToken(open)) {
            while (true) {
                const start = self.cur().start;
                const description = try self.parseDescription();
                const name = try self.parseName();
                _ = try self.expectToken(.colon);
                const ty = try self.parseTypeReference();
                const default_value = if (try self.expectOptionalToken(.equals)) try self.parseValueLiteral(true) else null;
                try list.append(self.arena, .{
                    .loc = start,
                    .description = description,
                    .name = name,
                    .type = ty,
                    .default_value = default_value,
                    .directives = try self.parseDirectives(true),
                });
                if (try self.expectOptionalToken(close)) break;
            }
        }
        return list.items;
    }
};

const directive_locations = [_][]const u8{
    "QUERY",                "MUTATION",              "SUBSCRIPTION",     "FIELD",
    "FRAGMENT_DEFINITION",  "FRAGMENT_SPREAD",       "INLINE_FRAGMENT",  "VARIABLE_DEFINITION",
    "SCHEMA",               "SCALAR",                "OBJECT",           "FIELD_DEFINITION",
    "ARGUMENT_DEFINITION",  "INTERFACE",             "UNION",            "ENUM",
    "ENUM_VALUE",           "INPUT_OBJECT",          "INPUT_FIELD_DEFINITION", "DIRECTIVE_DEFINITION",
};

fn isDirectiveLocation(name: []const u8) bool {
    for (directive_locations) |loc| if (eql(loc, name)) return true;
    return false;
}

fn eql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

/// graphql-js `getTokenDesc`.
const TokenDesc = struct {
    token: Token,
    pub fn format(self: TokenDesc, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll(self.token.kind.desc());
        if (self.token.kind.hasValue()) try w.print(" \"{s}\"", .{self.token.value});
    }
};

fn expectSyntaxError(source: []const u8, options: Options, message: []const u8, line: u32, column: u32) !void {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    try std.testing.expectError(error.SyntaxError, parse(arena_state.allocator(), source, options, &diag));
    try std.testing.expectEqualStrings(message, diag.message);
    const loc = ast.location(source, diag.offset);
    try std.testing.expectEqual(line, loc.line);
    try std.testing.expectEqual(column, loc.column);
}

test "parse errors match graphql-js" {
    try expectSyntaxError("{", .{}, "Syntax Error: Expected Name, found <EOF>.", 1, 2);
    try expectSyntaxError("{ domain { id } } fragment", .{}, "Syntax Error: Expected Name, found <EOF>.", 1, 27);
    try expectSyntaxError("query ($a: Int = $b) { a }", .{}, "Syntax Error: Unexpected variable \"$b\" in constant value.", 1, 18);
    try expectSyntaxError("{ a(x: ) }", .{}, "Syntax Error: Unexpected \")\".", 1, 8);
    try expectSyntaxError("fragment on on T { a }", .{}, "Syntax Error: Unexpected Name \"on\".", 1, 10);
    try expectSyntaxError("\"desc\" { a }", .{}, "Syntax Error: Unexpected description, descriptions are not supported on shorthand queries.", 1, 1);
    try expectSyntaxError("notakeyword", .{}, "Syntax Error: Unexpected Name \"notakeyword\".", 1, 1);
    try expectSyntaxError("", .{}, "Syntax Error: Unexpected <EOF>.", 1, 1);
    try expectSyntaxError("{ a } { b c d }", .{ .max_tokens = 6 }, "Syntax Error: Document contains more that 6 tokens. Parsing aborted.", 1, 13);
}

test "parse executable document" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const doc = try parse(arena_state.allocator(),
        \\query Q($id: Int! = 3, $o: [domain_order_by!]) @cached(ttl: 30) {
        \\  a: domain(where: {id: {_eq: $id}}, order_by: $o) { id ...F ... on domain { name } }
        \\}
        \\fragment F on domain { name }
    , .{ .max_tokens = 10_000 }, &diag);
    try std.testing.expectEqual(@as(usize, 2), doc.definitions.len);
    const op = doc.definitions[0].operation;
    try std.testing.expectEqualStrings("Q", op.name.?.value);
    try std.testing.expectEqual(@as(usize, 2), op.variable_definitions.len);
    const field = op.selection_set.selections[0].field;
    try std.testing.expectEqualStrings("a", field.alias.?.value);
    try std.testing.expectEqual(@as(usize, 3), field.selection_set.?.selections.len);
}

test "parse sdl" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const doc = try parse(arena_state.allocator(),
        \\directive @cached(ttl: Int, refresh: Boolean) on QUERY
        \\extend type q { b: Int }
        \\"doc" type q { "f" a(x: Int = 1): [String!]! }
        \\enum E { A B }
        \\input I { a: Int }
        \\scalar S
        \\schema { query: q }
    , .{}, &diag);
    try std.testing.expectEqual(@as(usize, 7), doc.definitions.len);
    try std.testing.expect(doc.definitions[1].type_system.extension);
}
