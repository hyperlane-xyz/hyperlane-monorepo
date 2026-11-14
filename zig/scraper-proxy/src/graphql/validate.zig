//! graphql-js `validate(schema, document, [...specifiedRules, scraperProxyValidationRule])`.
//!
//! One document walk emulates `visitWithTypeInfo(visitInParallel(rules))`:
//! at each node the rules' enter/leave handlers run in `specifiedRules`
//! order (custom rule last), a rule returning `false` skips that subtree for
//! itself only, and error order is visit order. `maxErrors` (100) appends the
//! graphql-js abort error. Type-system definitions inside a request are only
//! reported by ExecutableDefinitions (see DEVIATIONS.md).
const std = @import("std");
const ast = @import("ast.zig");
const schema_mod = @import("schema.zig");
const printer = @import("printer.zig");
const suggest = @import("suggest.zig");
const custom = @import("validation_rule.zig");

const Schema = schema_mod.Schema;
const NamedType = schema_mod.NamedType;
const TypeRef = schema_mod.TypeRef;
const Field = schema_mod.Field;
const InputValue = schema_mod.InputValue;
const Directive = schema_mod.Directive;
const DirectiveLocation = schema_mod.DirectiveLocation;
const Allocator = std.mem.Allocator;

pub const max_errors = 100;

pub const Error = struct {
    message: []const u8,
    /// Byte offsets into the document source (graphql-js `nodes` locations).
    locations: []const u32 = &.{},
};

pub const ValidateError = error{OutOfMemory};
const Abort = error{ OutOfMemory, Aborted };

/// Returns every validation error (empty when the document is valid).
pub fn validate(arena: Allocator, schema: *const Schema, doc: *const ast.Document) ValidateError![]const Error {
    var v: Validator = .{ .arena = arena, .schema = schema, .doc = doc, .ti = .{ .schema = schema, .arena = arena } };
    v.init() catch |err| switch (err) {
        error.Aborted => unreachable,
        error.OutOfMemory => return error.OutOfMemory,
    };
    v.walkDocument() catch |err| switch (err) {
        error.Aborted => {},
        error.OutOfMemory => return error.OutOfMemory,
    };
    return v.errors.items;
}

// ---------------------------------------------------------------------------
// TypeInfo
// ---------------------------------------------------------------------------

/// `defaultValue` stack entry: `undefined` vs a (possibly null) literal.
pub const DefaultValue = ?*const ast.Value;

pub const TypeInfo = struct {
    schema: *const Schema,
    arena: Allocator,
    type_stack: std.ArrayList(?*const TypeRef) = .empty,
    parent_type_stack: std.ArrayList(?*NamedType) = .empty,
    input_type_stack: std.ArrayList(?*const TypeRef) = .empty,
    field_def_stack: std.ArrayList(?*const Field) = .empty,
    default_stack: std.ArrayList(DefaultValue) = .empty,
    directive: ?*const Directive = null,
    argument: ?*const InputValue = null,

    fn top(comptime T: type, list: std.ArrayList(?T)) ?T {
        return if (list.items.len == 0) null else list.items[list.items.len - 1];
    }

    pub fn getType(self: *const TypeInfo) ?*const TypeRef {
        return top(*const TypeRef, self.type_stack);
    }
    pub fn getParentType(self: *const TypeInfo) ?*NamedType {
        return top(*NamedType, self.parent_type_stack);
    }
    pub fn getInputType(self: *const TypeInfo) ?*const TypeRef {
        return top(*const TypeRef, self.input_type_stack);
    }
    pub fn getParentInputType(self: *const TypeInfo) ?*const TypeRef {
        const items = self.input_type_stack.items;
        return if (items.len < 2) null else items[items.len - 2];
    }
    pub fn getFieldDef(self: *const TypeInfo) ?*const Field {
        return top(*const Field, self.field_def_stack);
    }
    pub fn getDefaultValue(self: *const TypeInfo) DefaultValue {
        const items = self.default_stack.items;
        return if (items.len == 0) null else items[items.len - 1];
    }

    fn enterSelectionSet(self: *TypeInfo) !void {
        const named = if (self.getType()) |t| t.namedType() else null;
        try self.parent_type_stack.append(self.arena, if (named != null and named.?.isComposite()) named else null);
    }
    fn leaveSelectionSet(self: *TypeInfo) void {
        _ = self.parent_type_stack.pop();
    }
    fn enterField(self: *TypeInfo, f: *const ast.Field) !void {
        var def: ?*const Field = null;
        if (self.getParentType()) |parent| def = self.schema.fieldDef(parent, f.name.value);
        try self.field_def_stack.append(self.arena, def);
        try self.type_stack.append(self.arena, if (def) |d| d.type else null);
    }
    fn leaveField(self: *TypeInfo) void {
        _ = self.field_def_stack.pop();
        _ = self.type_stack.pop();
    }
    fn enterDirective(self: *TypeInfo, d: *const ast.Directive) void {
        self.directive = self.schema.directive(d.name.value);
    }
    fn leaveDirective(self: *TypeInfo) void {
        self.directive = null;
    }
    fn enterOperation(self: *TypeInfo, op: *const ast.Operation) !void {
        const root: ?*const TypeRef = if (op.operation == .query) &self.schema.query_type.ref else null;
        try self.type_stack.append(self.arena, root);
    }
    fn enterFragmentLike(self: *TypeInfo, type_condition: ?ast.Name) !void {
        var named: ?*NamedType = null;
        if (type_condition) |tc| {
            named = self.schema.getType(tc.value);
        } else if (self.getType()) |t| {
            named = t.namedType();
        }
        try self.type_stack.append(self.arena, if (named != null and named.?.isOutputType()) &named.?.ref else null);
    }
    fn leaveTypeScope(self: *TypeInfo) void {
        _ = self.type_stack.pop();
    }
    fn enterVariableDefinition(self: *TypeInfo, vd: *const ast.VariableDefinition) !void {
        const t = try typeFromAst(self.arena, self.schema, vd.type);
        try self.input_type_stack.append(self.arena, if (t != null and t.?.namedType().isInputType()) t else null);
    }
    fn leaveVariableDefinition(self: *TypeInfo) void {
        _ = self.input_type_stack.pop();
    }
    fn enterArgument(self: *TypeInfo, arg: *const ast.Argument) !void {
        var def: ?*const InputValue = null;
        if (self.directive) |d| {
            def = d.arg(arg.name.value);
        } else if (self.getFieldDef()) |f| {
            def = f.arg(arg.name.value);
        }
        self.argument = def;
        try self.default_stack.append(self.arena, if (def) |d| d.default_value else null);
        try self.input_type_stack.append(self.arena, if (def) |d| d.type else null);
    }
    fn leaveArgument(self: *TypeInfo) void {
        self.argument = null;
        _ = self.default_stack.pop();
        _ = self.input_type_stack.pop();
    }
    fn enterList(self: *TypeInfo) !void {
        var item: ?*const TypeRef = null;
        if (self.getInputType()) |t| {
            const list_type = t.nullable();
            item = if (list_type.* == .list) list_type.list else list_type;
        }
        try self.default_stack.append(self.arena, null);
        try self.input_type_stack.append(self.arena, item);
    }
    fn enterObjectField(self: *TypeInfo, of: *const ast.ObjectField) !void {
        var field: ?*const InputValue = null;
        if (self.getInputType()) |t| {
            const named = t.namedType();
            if (named.kind == .input_object) field = named.inputField(of.name.value);
        }
        try self.default_stack.append(self.arena, if (field) |f| f.default_value else null);
        try self.input_type_stack.append(self.arena, if (field) |f| f.type else null);
    }
    fn leaveInputScope(self: *TypeInfo) void {
        _ = self.default_stack.pop();
        _ = self.input_type_stack.pop();
    }
};

/// graphql-js `typeFromAST` (null when a named type is unknown).
pub fn typeFromAst(arena: Allocator, schema: *const Schema, node: *const ast.Type) Allocator.Error!?*const TypeRef {
    switch (node.data) {
        .named => |n| return if (schema.getType(n.value)) |t| &t.ref else null,
        .list => |inner| {
            const t = try typeFromAst(arena, schema, inner) orelse return null;
            const r = try arena.create(TypeRef);
            r.* = .{ .list = t };
            return r;
        },
        .non_null => |inner| {
            const t = try typeFromAst(arena, schema, inner) orelse return null;
            const r = try arena.create(TypeRef);
            r.* = .{ .non_null = t };
            return r;
        },
    }
}

// ---------------------------------------------------------------------------
// Validation context helpers (fragments, spreads, variable usages)
// ---------------------------------------------------------------------------

pub const VariableUsage = struct {
    node: *const ast.Variable,
    type: ?*const TypeRef,
    default_value: DefaultValue,
    parent_type: ?*const TypeRef,
};

const Rule = enum {
    executable_definitions,
    unique_operation_names,
    lone_anonymous_operation,
    known_type_names,
    fragments_on_composite_types,
    variables_are_input_types,
    scalar_leafs,
    fields_on_correct_type,
    unique_fragment_names,
    known_fragment_names,
    no_unused_fragments,
    possible_fragment_spreads,
    no_fragment_cycles,
    unique_variable_names,
    no_undefined_variables,
    no_unused_variables,
    known_directives,
    unique_directives_per_location,
    known_argument_names,
    unique_argument_names,
    values_of_correct_type,
    provided_required_arguments,
    variables_in_allowed_position,
    overlapping_fields_can_be_merged,
    unique_input_field_names,
    max_introspection_depth,
    scraper_proxy,
};

const rule_count = @typeInfo(Rule).@"enum".fields.len;

const Validator = struct {
    arena: Allocator,
    schema: *const Schema,
    doc: *const ast.Document,
    ti: TypeInfo,
    errors: std.ArrayList(Error) = .empty,
    skipping: [rule_count]usize = .{0} ** rule_count,

    fragments: std.StringHashMapUnmanaged(*const ast.Fragment) = .empty,
    spreads_cache: std.AutoHashMapUnmanaged(usize, []const *const ast.FragmentSpread) = .empty,
    referenced_cache: std.AutoHashMapUnmanaged(usize, []const *const ast.Fragment) = .empty,
    usages_cache: std.AutoHashMapUnmanaged(usize, []const VariableUsage) = .empty,

    // Rule state.
    known_operation_names: std.StringHashMapUnmanaged(ast.Name) = .empty,
    operation_count: usize = 0,
    type_names: std.ArrayList([]const u8) = .empty,
    doc_type_names: std.StringHashMapUnmanaged(void) = .empty,
    known_fragment_names: std.StringHashMapUnmanaged(ast.Name) = .empty,
    unused_operation_defs: std.ArrayList(*const ast.Operation) = .empty,
    unused_fragment_defs: std.ArrayList(*const ast.Fragment) = .empty,
    cycle_visited: std.StringHashMapUnmanaged(void) = .empty,
    cycle_path: std.ArrayList(*const ast.FragmentSpread) = .empty,
    cycle_index: std.StringHashMapUnmanaged(usize) = .empty,
    undefined_defined: std.StringHashMapUnmanaged(void) = .empty,
    unused_var_defs: std.ArrayList(*const ast.VariableDefinition) = .empty,
    allowed_var_defs: std.StringHashMapUnmanaged(*const ast.VariableDefinition) = .empty,
    input_field_names: std.ArrayList(std.StringHashMapUnmanaged(ast.Name)) = .empty,
    overlap: Overlap = undefined,
    introspection_visited: std.ArrayList([]const u8) = .empty,

    fn init(self: *Validator) Abort!void {
        for (self.doc.definitions) |def| {
            switch (def) {
                .fragment => |f| try self.fragments.put(self.arena, f.name.value, f),
                .type_system => |t| if (t.name) |n| switch (t.kind) {
                    .scalar, .object, .interface, .@"union", .@"enum", .input_object => if (!t.extension) try self.doc_type_names.put(self.arena, n.value, {}),
                    else => {},
                },
                .operation => {},
            }
        }
        for (self.schema.type_list.items) |t| try self.type_names.append(self.arena, t.name);
        var it = self.doc_type_names.keyIterator();
        while (it.next()) |k| try self.type_names.append(self.arena, k.*);
        self.overlap = .{ .v = self };
    }

    // ---- error reporting ----

    fn report(self: *Validator, message: []const u8, locations: []const u32) Abort!void {
        if (self.errors.items.len >= max_errors) {
            try self.errors.append(self.arena, .{ .message = "Too many validation errors, error limit reached. Validation aborted." });
            return error.Aborted;
        }
        try self.errors.append(self.arena, .{ .message = message, .locations = locations });
    }

    fn reportf(self: *Validator, locations: []const u32, comptime fmt: []const u8, args: anytype) Abort!void {
        try self.report(try std.fmt.allocPrint(self.arena, fmt, args), locations);
    }

    fn locs(self: *Validator, items: []const u32) Abort![]const u32 {
        return self.arena.dupe(u32, items);
    }

    fn active(self: *const Validator, rule: Rule) bool {
        return self.skipping[@intFromEnum(rule)] == 0;
    }

    fn skip(self: *Validator, rule: Rule, node: usize) void {
        self.skipping[@intFromEnum(rule)] = node;
    }

    /// visitInParallel leave bookkeeping: returns whether the rule's leave runs.
    fn leaveActive(self: *Validator, rule: Rule, node: usize) bool {
        const i = @intFromEnum(rule);
        if (self.skipping[i] == 0) return true;
        if (self.skipping[i] == node) self.skipping[i] = 0;
        return false;
    }

    /// Resets skip markers set on `node` for rules without a leave handler.
    fn leaveNode(self: *Validator, node: usize) void {
        for (&self.skipping) |*s| if (s.* == node) {
            s.* = 0;
        };
    }

    // ---- context helpers ----

    fn getFragment(self: *const Validator, name: []const u8) ?*const ast.Fragment {
        return self.fragments.get(name);
    }

    fn getFragmentSpreads(self: *Validator, set: *const ast.SelectionSet) Abort![]const *const ast.FragmentSpread {
        if (self.spreads_cache.get(@intFromPtr(set))) |cached| return cached;
        var spreads: std.ArrayList(*const ast.FragmentSpread) = .empty;
        var stack: std.ArrayList(*const ast.SelectionSet) = .empty;
        try stack.append(self.arena, set);
        while (stack.pop()) |s| {
            for (s.selections) |sel| switch (sel) {
                .fragment_spread => |fs| try spreads.append(self.arena, fs),
                .field => |f| if (f.selection_set) |child| try stack.append(self.arena, child),
                .inline_fragment => |f| try stack.append(self.arena, f.selection_set),
            };
        }
        try self.spreads_cache.put(self.arena, @intFromPtr(set), spreads.items);
        return spreads.items;
    }

    fn getRecursivelyReferencedFragments(self: *Validator, op: *const ast.Operation) Abort![]const *const ast.Fragment {
        if (self.referenced_cache.get(@intFromPtr(op))) |cached| return cached;
        var fragments: std.ArrayList(*const ast.Fragment) = .empty;
        var collected: std.StringHashMapUnmanaged(void) = .empty;
        var stack: std.ArrayList(*const ast.SelectionSet) = .empty;
        try stack.append(self.arena, op.selection_set);
        while (stack.pop()) |set| {
            for (try self.getFragmentSpreads(set)) |spread| {
                const name = spread.name.value;
                if (collected.contains(name)) continue;
                try collected.put(self.arena, name, {});
                if (self.getFragment(name)) |frag| {
                    try fragments.append(self.arena, frag);
                    try stack.append(self.arena, frag.selection_set);
                }
            }
        }
        try self.referenced_cache.put(self.arena, @intFromPtr(op), fragments.items);
        return fragments.items;
    }

    fn getRecursiveVariableUsages(self: *Validator, op: *const ast.Operation) Abort![]const VariableUsage {
        var usages: std.ArrayList(VariableUsage) = .empty;
        try usages.appendSlice(self.arena, try self.getVariableUsages(.{ .operation = op }));
        for (try self.getRecursivelyReferencedFragments(op)) |frag| {
            try usages.appendSlice(self.arena, try self.getVariableUsages(.{ .fragment = frag }));
        }
        return usages.items;
    }

    const UsageRoot = union(enum) { operation: *const ast.Operation, fragment: *const ast.Fragment };

    fn getVariableUsages(self: *Validator, root: UsageRoot) Abort![]const VariableUsage {
        const key = switch (root) {
            inline else => |p| @intFromPtr(p),
        };
        if (self.usages_cache.get(key)) |cached| return cached;
        var collector: UsageCollector = .{ .ti = .{ .schema = self.schema, .arena = self.arena }, .arena = self.arena };
        switch (root) {
            .operation => |op| try collector.operation(op),
            .fragment => |frag| try collector.fragment(frag),
        }
        try self.usages_cache.put(self.arena, key, collector.usages.items);
        return collector.usages.items;
    }

    // ---- walk ----

    fn walkDocument(self: *Validator) Abort!void {
        const id = @intFromPtr(self.doc);
        try self.enterDocument();
        for (self.doc.definitions) |def| switch (def) {
            .operation => |op| try self.walkOperation(op),
            .fragment => |frag| try self.walkFragmentDefinition(frag),
            .type_system => |t| try self.walkTypeSystem(t),
        };
        if (self.leaveActive(.no_unused_fragments, id)) try self.noUnusedFragmentsLeave();
        self.leaveNode(id);
    }

    fn walkOperation(self: *Validator, op: *const ast.Operation) Abort!void {
        const id = @intFromPtr(op);
        try self.ti.enterOperation(op);
        // enter (rule order)
        if (self.active(.unique_operation_names)) {
            try self.uniqueOperationName(op);
            self.skip(.unique_operation_names, id);
        }
        if (self.active(.lone_anonymous_operation) and op.name == null and self.operation_count > 1) {
            try self.report("This anonymous operation must be the only defined operation.", try self.locs(&.{op.loc}));
        }
        if (self.active(.unique_fragment_names)) self.skip(.unique_fragment_names, id);
        if (self.active(.no_unused_fragments)) {
            try self.unused_operation_defs.append(self.arena, op);
            self.skip(.no_unused_fragments, id);
        }
        if (self.active(.no_fragment_cycles)) self.skip(.no_fragment_cycles, id);
        if (self.active(.unique_variable_names)) try self.uniqueVariableNames(op);
        if (self.active(.no_undefined_variables)) self.undefined_defined.clearRetainingCapacity();
        if (self.active(.no_unused_variables)) self.unused_var_defs.clearRetainingCapacity();
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(op.directives);
        if (self.active(.variables_in_allowed_position)) self.allowed_var_defs.clearRetainingCapacity();

        for (op.variable_definitions) |*vd| try self.walkVariableDefinition(vd);
        const location: DirectiveLocation = switch (op.operation) {
            .query => .QUERY,
            .mutation => .MUTATION,
            .subscription => .SUBSCRIPTION,
        };
        for (op.directives) |*d| try self.walkDirective(d, location);
        try self.walkSelectionSet(op.selection_set);

        // leave (rule order)
        if (self.leaveActive(.no_undefined_variables, id)) try self.noUndefinedVariablesLeave(op);
        if (self.leaveActive(.no_unused_variables, id)) try self.noUnusedVariablesLeave(op);
        if (self.leaveActive(.variables_in_allowed_position, id)) try self.variablesInAllowedPositionLeave(op);
        self.leaveNode(id);
        self.ti.leaveTypeScope();
    }

    fn walkFragmentDefinition(self: *Validator, frag: *const ast.Fragment) Abort!void {
        const id = @intFromPtr(frag);
        try self.ti.enterFragmentLike(frag.type_condition);
        if (self.active(.unique_operation_names)) self.skip(.unique_operation_names, id);
        if (self.active(.fragments_on_composite_types)) {
            if (self.schema.getType(frag.type_condition.value)) |t| if (!t.isComposite()) {
                try self.reportf(try self.locs(&.{frag.type_condition.loc}), "Fragment \"{s}\" cannot condition on non composite type \"{s}\".", .{ frag.name.value, frag.type_condition.value });
            };
        }
        if (self.active(.unique_fragment_names)) {
            const name = frag.name.value;
            if (self.known_fragment_names.get(name)) |known| {
                try self.reportf(try self.locs(&.{ known.loc, frag.name.loc }), "There can be only one fragment named \"{s}\".", .{name});
            } else try self.known_fragment_names.put(self.arena, name, frag.name);
            self.skip(.unique_fragment_names, id);
        }
        if (self.active(.no_unused_fragments)) {
            try self.unused_fragment_defs.append(self.arena, frag);
            self.skip(.no_unused_fragments, id);
        }
        if (self.active(.no_fragment_cycles)) {
            try self.detectCycleRecursive(frag);
            self.skip(.no_fragment_cycles, id);
        }
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(frag.directives);

        try self.walkNamedType(frag.type_condition);
        for (frag.directives) |*d| try self.walkDirective(d, .FRAGMENT_DEFINITION);
        try self.walkSelectionSet(frag.selection_set);
        self.leaveNode(id);
        self.ti.leaveTypeScope();
    }

    fn walkVariableDefinition(self: *Validator, vd: *const ast.VariableDefinition) Abort!void {
        const id = @intFromPtr(vd);
        try self.ti.enterVariableDefinition(vd);
        if (self.active(.variables_are_input_types)) {
            if (try typeFromAst(self.arena, self.schema, vd.type)) |t| if (!t.namedType().isInputType()) {
                try self.reportf(try self.locs(&.{vd.type.loc}), "Variable \"${s}\" cannot be non-input type \"{s}\".", .{ vd.variable.name.value, try printer.printType(self.arena, vd.type) });
            };
        }
        if (self.active(.no_undefined_variables)) try self.undefined_defined.put(self.arena, vd.variable.name.value, {});
        if (self.active(.no_unused_variables)) try self.unused_var_defs.append(self.arena, vd);
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(vd.directives);
        if (self.active(.variables_in_allowed_position)) try self.allowed_var_defs.put(self.arena, vd.variable.name.value, vd);

        try self.walkTypeNode(vd.type);
        if (vd.default_value) |dv| try self.walkValue(dv);
        for (vd.directives) |*d| try self.walkDirective(d, .VARIABLE_DEFINITION);
        self.leaveNode(id);
        self.ti.leaveVariableDefinition();
    }

    fn walkTypeNode(self: *Validator, t: *const ast.Type) Abort!void {
        switch (t.data) {
            .named => |n| try self.walkNamedType(n),
            .list, .non_null => |inner| try self.walkTypeNode(inner),
        }
    }

    fn walkNamedType(self: *Validator, name: ast.Name) Abort!void {
        return self.knownTypeName(name, false);
    }

    fn knownTypeName(self: *Validator, name: ast.Name, is_sdl: bool) Abort!void {
        if (!self.active(.known_type_names)) return;
        if (self.schema.getType(name.value) != null or self.doc_type_names.contains(name.value)) return;
        if (is_sdl and isStandardTypeName(name.value)) return;
        var options = self.type_names.items;
        if (is_sdl) {
            var with_standard: std.ArrayList([]const u8) = .empty;
            try with_standard.appendSlice(self.arena, &standard_type_names);
            try with_standard.appendSlice(self.arena, self.type_names.items);
            options = with_standard.items;
        }
        var msg: std.ArrayList(u8) = .empty;
        try msg.print(self.arena, "Unknown type \"{s}\".", .{name.value});
        try suggest.didYouMean(self.arena, &msg, null, try suggest.suggestionList(self.arena, name.value, options));
        try self.report(msg.items, try self.locs(&.{name.loc}));
    }

    /// Type-system definitions in a request: only KnownTypeNames (SDL mode) is
    /// applied beyond ExecutableDefinitions (see DEVIATIONS.md).
    fn walkTypeSystem(self: *Validator, t: *const ast.TypeSystemDefinition) Abort!void {
        for (t.interfaces) |n| try self.knownTypeName(n, true);
        for (t.fields) |f| {
            for (f.arguments) |a| try self.knownTypeName(a.type.namedType(), true);
            try self.knownTypeName(f.type.namedType(), true);
        }
        for (t.union_types) |n| try self.knownTypeName(n, true);
        for (t.input_fields) |f| try self.knownTypeName(f.type.namedType(), true);
        for (t.operation_types) |op| try self.knownTypeName(op.type, true);
        for (t.arguments) |a| try self.knownTypeName(a.type.namedType(), true);
    }

    fn walkSelectionSet(self: *Validator, set: *const ast.SelectionSet) Abort!void {
        const id = @intFromPtr(set);
        try self.ti.enterSelectionSet();
        if (self.active(.overlapping_fields_can_be_merged)) try self.overlap.selectionSet(self.ti.getParentType(), set);
        for (set.selections) |sel| switch (sel) {
            .field => |f| try self.walkField(f),
            .fragment_spread => |fs| try self.walkFragmentSpread(fs),
            .inline_fragment => |f| try self.walkInlineFragment(f),
        };
        self.leaveNode(id);
        self.ti.leaveSelectionSet();
    }

    fn walkField(self: *Validator, f: *const ast.Field) Abort!void {
        const id = @intFromPtr(f);
        try self.ti.enterField(f);
        if (self.active(.scalar_leafs)) try self.scalarLeafs(f);
        if (self.active(.fields_on_correct_type)) try self.fieldsOnCorrectType(f);
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(f.directives);
        if (self.active(.unique_argument_names)) try self.uniqueArgumentNames(f.arguments);
        if (self.active(.max_introspection_depth)) {
            if (isIntrospectionRoot(f.name.value) and self.checkIntrospectionDepth(.{ .field = f }, 0)) {
                try self.report("Maximum introspection depth exceeded", try self.locs(&.{f.loc}));
                self.skip(.max_introspection_depth, id);
            }
        }

        for (f.arguments) |*arg| try self.walkArgument(arg);
        for (f.directives) |*d| try self.walkDirective(d, .FIELD);
        if (f.selection_set) |set| try self.walkSelectionSet(set);

        if (self.leaveActive(.provided_required_arguments, id)) try self.providedRequiredFieldArguments(f);
        self.leaveNode(id);
        self.ti.leaveField();
    }

    fn walkFragmentSpread(self: *Validator, fs: *const ast.FragmentSpread) Abort!void {
        const id = @intFromPtr(fs);
        if (self.active(.known_fragment_names) and self.getFragment(fs.name.value) == null) {
            try self.reportf(try self.locs(&.{fs.name.loc}), "Unknown fragment \"{s}\".", .{fs.name.value});
        }
        if (self.active(.possible_fragment_spreads)) {
            if (self.getFragment(fs.name.value)) |frag| {
                const frag_type = self.schema.getType(frag.type_condition.value);
                const parent = self.ti.getParentType();
                if (frag_type != null and frag_type.?.isComposite() and parent != null and frag_type.? != parent.?) {
                    try self.reportf(try self.locs(&.{fs.loc}), "Fragment \"{s}\" cannot be spread here as objects of type \"{s}\" can never be of type \"{s}\".", .{ fs.name.value, parent.?.name, frag_type.?.name });
                }
            }
        }
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(fs.directives);
        for (fs.directives) |*d| try self.walkDirective(d, .FRAGMENT_SPREAD);
        self.leaveNode(id);
    }

    fn walkInlineFragment(self: *Validator, f: *const ast.InlineFragment) Abort!void {
        const id = @intFromPtr(f);
        try self.ti.enterFragmentLike(f.type_condition);
        if (self.active(.fragments_on_composite_types)) {
            if (f.type_condition) |tc| if (self.schema.getType(tc.value)) |t| if (!t.isComposite()) {
                try self.reportf(try self.locs(&.{tc.loc}), "Fragment cannot condition on non composite type \"{s}\".", .{tc.value});
            };
        }
        if (self.active(.possible_fragment_spreads)) {
            const frag_type = if (self.ti.getType()) |t| t.namedType() else null;
            const parent = self.ti.getParentType();
            if (frag_type != null and frag_type.?.isComposite() and parent != null and frag_type.? != parent.?) {
                try self.reportf(try self.locs(&.{f.loc}), "Fragment cannot be spread here as objects of type \"{s}\" can never be of type \"{s}\".", .{ parent.?.name, frag_type.?.name });
            }
        }
        if (self.active(.unique_directives_per_location)) try self.uniqueDirectives(f.directives);
        if (f.type_condition) |tc| try self.walkNamedType(tc);
        for (f.directives) |*d| try self.walkDirective(d, .INLINE_FRAGMENT);
        try self.walkSelectionSet(f.selection_set);
        self.leaveNode(id);
        self.ti.leaveTypeScope();
    }

    fn walkDirective(self: *Validator, d: *const ast.Directive, location: DirectiveLocation) Abort!void {
        const id = @intFromPtr(d);
        self.ti.enterDirective(d);
        const def = self.schema.directive(d.name.value);
        if (self.active(.known_directives)) {
            if (def) |known| {
                if (!known.locations.contains(location)) {
                    try self.reportf(try self.locs(&.{d.loc}), "Directive \"@{s}\" may not be used on {s}.", .{ d.name.value, @tagName(location) });
                }
            } else {
                try self.reportf(try self.locs(&.{d.loc}), "Unknown directive \"@{s}\".", .{d.name.value});
            }
        }
        if (self.active(.known_argument_names)) {
            if (def) |known| for (d.arguments) |arg| {
                if (known.arg(arg.name.value) != null) continue;
                var names: std.ArrayList([]const u8) = .empty;
                for (known.args) |a| try names.append(self.arena, a.name);
                var msg: std.ArrayList(u8) = .empty;
                try msg.print(self.arena, "Unknown argument \"{s}\" on directive \"@{s}\".", .{ arg.name.value, d.name.value });
                try suggest.didYouMean(self.arena, &msg, null, try suggest.suggestionList(self.arena, arg.name.value, names.items));
                try self.report(msg.items, try self.locs(&.{arg.loc}));
            };
            self.skip(.known_argument_names, id);
        }
        if (self.active(.unique_argument_names)) try self.uniqueArgumentNames(d.arguments);

        for (d.arguments) |*arg| try self.walkArgument(arg);

        if (self.leaveActive(.provided_required_arguments, id)) {
            if (def) |known| for (known.args) |a| {
                if (!isRequired(a)) continue;
                if (hasArgument(d.arguments, a.name)) continue;
                try self.reportf(try self.locs(&.{d.loc}), "Directive \"@{s}\" argument \"{s}\" of type \"{f}\" is required, but it was not provided.", .{ d.name.value, a.name, a.type });
            };
        }
        self.leaveNode(id);
        self.ti.leaveDirective();
    }

    fn walkArgument(self: *Validator, arg: *const ast.Argument) Abort!void {
        const id = @intFromPtr(arg);
        try self.ti.enterArgument(arg);
        if (self.active(.known_argument_names)) {
            const field_def = self.ti.getFieldDef();
            const parent = self.ti.getParentType();
            if (self.ti.argument == null and field_def != null and parent != null) {
                var names: std.ArrayList([]const u8) = .empty;
                for (field_def.?.args) |a| try names.append(self.arena, a.name);
                var msg: std.ArrayList(u8) = .empty;
                try msg.print(self.arena, "Unknown argument \"{s}\" on field \"{s}.{s}\".", .{ arg.name.value, parent.?.name, field_def.?.name });
                try suggest.didYouMean(self.arena, &msg, null, try suggest.suggestionList(self.arena, arg.name.value, names.items));
                try self.report(msg.items, try self.locs(&.{arg.loc}));
            }
        }
        try self.walkValue(arg.value);
        self.leaveNode(id);
        self.ti.leaveArgument();
    }

    fn walkValue(self: *Validator, v: *const ast.Value) Abort!void {
        const id = @intFromPtr(v);
        switch (v.data) {
            .list => |items| {
                try self.ti.enterList();
                if (self.active(.values_of_correct_type)) {
                    const parent = self.ti.getParentInputType();
                    const is_list = parent != null and parent.?.nullable().* == .list;
                    if (!is_list) {
                        try self.isValidValueNode(v);
                        self.skip(.values_of_correct_type, id);
                    }
                }
                for (items) |item| try self.walkValue(item);
                self.leaveNode(id);
                self.ti.leaveInputScope();
            },
            .object => |fields| {
                if (self.active(.values_of_correct_type)) {
                    const named = if (self.ti.getInputType()) |t| t.namedType() else null;
                    if (named == null or named.?.kind != .input_object) {
                        try self.isValidValueNode(v);
                        self.skip(.values_of_correct_type, id);
                    } else {
                        const ty = named.?;
                        for (ty.input_fields) |fd| {
                            if (hasObjectField(fields, fd.name)) continue;
                            if (fd.type.isNonNull() and fd.default_value == null) {
                                try self.reportf(try self.locs(&.{v.loc}), "Field \"{s}.{s}\" of required type \"{f}\" was not provided.", .{ ty.name, fd.name, fd.type });
                            }
                        }
                        if (ty.is_one_of) try self.validateOneOf(v, ty, fields);
                    }
                }
                const uifn = self.active(.unique_input_field_names);
                if (uifn) try self.input_field_names.append(self.arena, .empty);
                for (fields) |*of| try self.walkObjectField(of);
                if (self.leaveActive(.unique_input_field_names, id)) {
                    _ = self.input_field_names.pop();
                }
                self.leaveNode(id);
            },
            .null => {
                if (self.active(.values_of_correct_type)) {
                    if (self.ti.getInputType()) |t| if (t.isNonNull()) {
                        try self.reportf(try self.locs(&.{v.loc}), "Expected value of type \"{f}\", found null.", .{t});
                    };
                }
            },
            .variable => {},
            .enum_value, .int, .float, .string, .boolean => {
                if (self.active(.values_of_correct_type)) try self.isValidValueNode(v);
            },
        }
    }

    fn walkObjectField(self: *Validator, of: *const ast.ObjectField) Abort!void {
        const id = @intFromPtr(of);
        try self.ti.enterObjectField(of);
        if (self.active(.values_of_correct_type)) {
            const parent = if (self.ti.getParentInputType()) |t| t.namedType() else null;
            if (self.ti.getInputType() == null and parent != null and parent.?.kind == .input_object) {
                var names: std.ArrayList([]const u8) = .empty;
                for (parent.?.input_fields) |f| try names.append(self.arena, f.name);
                var msg: std.ArrayList(u8) = .empty;
                try msg.print(self.arena, "Field \"{s}\" is not defined by type \"{s}\".", .{ of.name.value, parent.?.name });
                try suggest.didYouMean(self.arena, &msg, null, try suggest.suggestionList(self.arena, of.name.value, names.items));
                try self.report(msg.items, try self.locs(&.{of.loc}));
            }
        }
        if (self.active(.unique_input_field_names) and self.input_field_names.items.len > 0) {
            const known = &self.input_field_names.items[self.input_field_names.items.len - 1];
            if (known.get(of.name.value)) |prev| {
                try self.reportf(try self.locs(&.{ prev.loc, of.name.loc }), "There can be only one input field named \"{s}\".", .{of.name.value});
            } else try known.put(self.arena, of.name.value, of.name);
        }
        try self.walkValue(of.value);
        self.leaveNode(id);
        self.ti.leaveInputScope();
    }

    // ---- rules ----

    fn enterDocument(self: *Validator) Abort!void {
        const id = @intFromPtr(self.doc);
        // ExecutableDefinitions
        for (self.doc.definitions) |def| {
            if (def != .type_system) continue;
            const t = def.type_system;
            if (t.kind == .schema_definition or t.kind == .schema_extension) {
                try self.report("The schema definition is not executable.", try self.locs(&.{t.loc}));
            } else {
                try self.reportf(try self.locs(&.{t.loc}), "The \"{s}\" definition is not executable.", .{t.name.?.value});
            }
        }
        self.skip(.executable_definitions, id);
        // LoneAnonymousOperation
        for (self.doc.definitions) |def| {
            if (def == .operation) self.operation_count += 1;
        }
        // scraperProxyValidationRule
        try custom.validate(self, self.doc);
    }

    /// Error sink for the custom rule (messages without locations).
    pub fn reportMessage(self: *Validator, message: []const u8) Abort!void {
        try self.report(message, &.{});
    }

    fn uniqueOperationName(self: *Validator, op: *const ast.Operation) Abort!void {
        const name = op.name orelse return;
        if (self.known_operation_names.get(name.value)) |known| {
            try self.reportf(try self.locs(&.{ known.loc, name.loc }), "There can be only one operation named \"{s}\".", .{name.value});
        } else try self.known_operation_names.put(self.arena, name.value, name);
    }

    fn uniqueVariableNames(self: *Validator, op: *const ast.Operation) Abort!void {
        var order: std.ArrayList([]const u8) = .empty;
        var groups: std.StringHashMapUnmanaged(std.ArrayList(u32)) = .empty;
        for (op.variable_definitions) |vd| {
            const gop = try groups.getOrPut(self.arena, vd.variable.name.value);
            if (!gop.found_existing) {
                gop.value_ptr.* = .empty;
                try order.append(self.arena, vd.variable.name.value);
            }
            try gop.value_ptr.append(self.arena, vd.variable.name.loc);
        }
        for (order.items) |name| {
            const list = groups.get(name).?;
            if (list.items.len > 1) try self.reportf(list.items, "There can be only one variable named \"${s}\".", .{name});
        }
    }

    fn uniqueArgumentNames(self: *Validator, args: []const ast.Argument) Abort!void {
        var order: std.ArrayList([]const u8) = .empty;
        var groups: std.StringHashMapUnmanaged(std.ArrayList(u32)) = .empty;
        for (args) |arg| {
            const gop = try groups.getOrPut(self.arena, arg.name.value);
            if (!gop.found_existing) {
                gop.value_ptr.* = .empty;
                try order.append(self.arena, arg.name.value);
            }
            try gop.value_ptr.append(self.arena, arg.name.loc);
        }
        for (order.items) |name| {
            const list = groups.get(name).?;
            if (list.items.len > 1) try self.reportf(list.items, "There can be only one argument named \"{s}\".", .{name});
        }
    }

    fn uniqueDirectives(self: *Validator, directives: []const ast.Directive) Abort!void {
        var seen: std.StringHashMapUnmanaged(u32) = .empty;
        for (directives) |d| {
            const def = self.schema.directive(d.name.value) orelse continue;
            if (def.repeatable) continue;
            if (seen.get(d.name.value)) |prev| {
                try self.reportf(try self.locs(&.{ prev, d.loc }), "The directive \"@{s}\" can only be used once at this location.", .{d.name.value});
            } else try seen.put(self.arena, d.name.value, d.loc);
        }
    }

    fn scalarLeafs(self: *Validator, f: *const ast.Field) Abort!void {
        const t = self.ti.getType() orelse return;
        if (t.namedType().isLeaf()) {
            if (f.selection_set) |set| {
                try self.reportf(try self.locs(&.{set.loc}), "Field \"{s}\" must not have a selection since type \"{f}\" has no subfields.", .{ f.name.value, t });
            }
        } else if (f.selection_set == null) {
            try self.reportf(try self.locs(&.{f.loc}), "Field \"{s}\" of type \"{f}\" must have a selection of subfields. Did you mean \"{s} {{ ... }}\"?", .{ f.name.value, t, f.name.value });
        } else if (f.selection_set.?.selections.len == 0) {
            try self.reportf(try self.locs(&.{f.loc}), "Field \"{s}\" of type \"{f}\" must have at least one field selected.", .{ f.name.value, t });
        }
    }

    fn fieldsOnCorrectType(self: *Validator, f: *const ast.Field) Abort!void {
        const parent = self.ti.getParentType() orelse return;
        if (self.ti.getFieldDef() != null) return;
        var names: std.ArrayList([]const u8) = .empty;
        for (parent.fields) |fd| try names.append(self.arena, fd.name);
        var msg: std.ArrayList(u8) = .empty;
        try msg.print(self.arena, "Cannot query field \"{s}\" on type \"{s}\".", .{ f.name.value, parent.name });
        try suggest.didYouMean(self.arena, &msg, null, try suggest.suggestionList(self.arena, f.name.value, names.items));
        try self.report(msg.items, try self.locs(&.{f.loc}));
    }

    fn noUnusedFragmentsLeave(self: *Validator) Abort!void {
        var used: std.StringHashMapUnmanaged(void) = .empty;
        for (self.unused_operation_defs.items) |op| {
            for (try self.getRecursivelyReferencedFragments(op)) |frag| try used.put(self.arena, frag.name.value, {});
        }
        for (self.unused_fragment_defs.items) |frag| {
            if (!used.contains(frag.name.value)) {
                try self.reportf(try self.locs(&.{frag.loc}), "Fragment \"{s}\" is never used.", .{frag.name.value});
            }
        }
    }

    fn detectCycleRecursive(self: *Validator, frag: *const ast.Fragment) Abort!void {
        const name = frag.name.value;
        if (self.cycle_visited.contains(name)) return;
        try self.cycle_visited.put(self.arena, name, {});
        const spreads = try self.getFragmentSpreads(frag.selection_set);
        if (spreads.len == 0) return;
        try self.cycle_index.put(self.arena, name, self.cycle_path.items.len);
        for (spreads) |spread| {
            const spread_name = spread.name.value;
            const cycle_index = self.cycle_index.get(spread_name);
            try self.cycle_path.append(self.arena, spread);
            if (cycle_index) |ci| {
                const cycle = self.cycle_path.items[ci..];
                var via: std.ArrayList(u8) = .empty;
                for (cycle[0 .. cycle.len - 1], 0..) |s, i| {
                    if (i > 0) try via.appendSlice(self.arena, ", ");
                    try via.print(self.arena, "\"{s}\"", .{s.name.value});
                }
                const locations = try self.arena.alloc(u32, cycle.len);
                for (cycle, locations) |s, *l| l.* = s.loc;
                if (via.items.len > 0) {
                    try self.reportf(locations, "Cannot spread fragment \"{s}\" within itself via {s}.", .{ spread_name, via.items });
                } else {
                    try self.reportf(locations, "Cannot spread fragment \"{s}\" within itself.", .{spread_name});
                }
            } else if (self.getFragment(spread_name)) |next| {
                try self.detectCycleRecursive(next);
            }
            _ = self.cycle_path.pop();
        }
        _ = self.cycle_index.remove(name);
    }

    fn noUndefinedVariablesLeave(self: *Validator, op: *const ast.Operation) Abort!void {
        for (try self.getRecursiveVariableUsages(op)) |usage| {
            const name = usage.node.name.value;
            if (self.undefined_defined.contains(name)) continue;
            const locations = try self.locs(&.{ usage.node.loc, op.loc });
            if (op.name) |op_name| {
                try self.reportf(locations, "Variable \"${s}\" is not defined by operation \"{s}\".", .{ name, op_name.value });
            } else {
                try self.reportf(locations, "Variable \"${s}\" is not defined.", .{name});
            }
        }
    }

    fn noUnusedVariablesLeave(self: *Validator, op: *const ast.Operation) Abort!void {
        var used: std.StringHashMapUnmanaged(void) = .empty;
        for (try self.getRecursiveVariableUsages(op)) |usage| try used.put(self.arena, usage.node.name.value, {});
        for (self.unused_var_defs.items) |vd| {
            const name = vd.variable.name.value;
            if (used.contains(name)) continue;
            const locations = try self.locs(&.{vd.loc});
            if (op.name) |op_name| {
                try self.reportf(locations, "Variable \"${s}\" is never used in operation \"{s}\".", .{ name, op_name.value });
            } else {
                try self.reportf(locations, "Variable \"${s}\" is never used.", .{name});
            }
        }
    }

    fn variablesInAllowedPositionLeave(self: *Validator, op: *const ast.Operation) Abort!void {
        for (try self.getRecursiveVariableUsages(op)) |usage| {
            const name = usage.node.name.value;
            const var_def = self.allowed_var_defs.get(name) orelse continue;
            const location_type = usage.type orelse continue;
            const var_type = try typeFromAst(self.arena, self.schema, var_def.type) orelse continue;
            if (!allowedVariableUsage(var_type, var_def.default_value, location_type, usage.default_value)) {
                try self.reportf(try self.locs(&.{ var_def.loc, usage.node.loc }), "Variable \"${s}\" of type \"{f}\" used in position expecting type \"{f}\".", .{ name, var_type, location_type });
            }
            if (usage.parent_type) |pt| if (pt.* == .named and pt.named.kind == .input_object and pt.named.is_one_of and !var_type.isNonNull()) {
                try self.reportf(try self.locs(&.{ var_def.loc, usage.node.loc }), "Variable \"${s}\" is of type \"{f}\" but must be non-nullable to be used for OneOf Input Object \"{s}\".", .{ name, var_type, pt.named.name });
            };
        }
    }

    fn providedRequiredFieldArguments(self: *Validator, f: *const ast.Field) Abort!void {
        const def = self.ti.getFieldDef() orelse return;
        for (def.args) |a| {
            if (!isRequired(a) or hasArgument(f.arguments, a.name)) continue;
            try self.reportf(try self.locs(&.{f.loc}), "Field \"{s}\" argument \"{s}\" of type \"{f}\" is required, but it was not provided.", .{ def.name, a.name, a.type });
        }
    }

    fn validateOneOf(self: *Validator, v: *const ast.Value, ty: *const NamedType, fields: []const ast.ObjectField) Abort!void {
        var distinct: std.ArrayList([]const u8) = .empty;
        var last_value: ?*const ast.Value = null;
        for (fields) |f| {
            for (distinct.items) |n| {
                if (std.mem.eql(u8, n, f.name.value)) break;
            } else try distinct.append(self.arena, f.name.value);
        }
        if (distinct.items.len != 1) {
            try self.reportf(try self.locs(&.{v.loc}), "OneOf Input Object \"{s}\" must specify exactly one key.", .{ty.name});
            return;
        }
        for (fields) |f| last_value = f.value; // keyMap keeps the last duplicate
        if (last_value == null or last_value.?.data == .null) {
            try self.reportf(try self.locs(&.{v.loc}), "Field \"{s}.{s}\" must be non-null.", .{ ty.name, distinct.items[0] });
        }
    }

    /// ValuesOfCorrectType `isValidValueNode` (leaf parseLiteral checks).
    fn isValidValueNode(self: *Validator, v: *const ast.Value) Abort!void {
        const location_type = self.ti.getInputType() orelse return;
        const named = location_type.namedType();
        if (!named.isLeaf()) {
            try self.reportf(try self.locs(&.{v.loc}), "Expected value of type \"{f}\", found {s}.", .{ location_type, try printer.printValue(self.arena, v) });
            return;
        }
        if (try literalError(self.arena, named, v)) |err| try self.report(err.message, err.locations);
    }

    fn checkIntrospectionDepth(self: *Validator, node: IntrospectionNode, depth_in: usize) bool {
        var depth = depth_in;
        switch (node) {
            .spread => |name| {
                for (self.introspection_visited.items) |n| if (std.mem.eql(u8, n, name)) return false;
                const frag = self.getFragment(name) orelse return false;
                self.introspection_visited.append(self.arena, name) catch return false;
                defer _ = self.introspection_visited.pop();
                return self.checkSelections(frag.selection_set, depth);
            },
            .field => |f| {
                const n = f.name.value;
                if (std.mem.eql(u8, n, "fields") or std.mem.eql(u8, n, "interfaces") or std.mem.eql(u8, n, "possibleTypes") or std.mem.eql(u8, n, "inputFields")) {
                    depth += 1;
                    if (depth >= 3) return true;
                }
                if (f.selection_set) |set| return self.checkSelections(set, depth);
                return false;
            },
            .inline_fragment => |f| return self.checkSelections(f.selection_set, depth),
        }
    }

    fn checkSelections(self: *Validator, set: *const ast.SelectionSet, depth: usize) bool {
        for (set.selections) |sel| {
            const child: IntrospectionNode = switch (sel) {
                .field => |f| .{ .field = f },
                .fragment_spread => |fs| .{ .spread = fs.name.value },
                .inline_fragment => |f| .{ .inline_fragment = f },
            };
            if (self.checkIntrospectionDepth(child, depth)) return true;
        }
        return false;
    }
};

const IntrospectionNode = union(enum) {
    field: *const ast.Field,
    spread: []const u8,
    inline_fragment: *const ast.InlineFragment,
};

const standard_type_names = [_][]const u8{
    "String",  "Int",     "Float",       "Boolean",      "ID",        "__Schema",          "__Directive",
    "__DirectiveLocation", "__Type", "__Field", "__InputValue", "__EnumValue", "__TypeKind",
};

fn isStandardTypeName(name: []const u8) bool {
    for (standard_type_names) |n| if (std.mem.eql(u8, n, name)) return true;
    return false;
}

fn isIntrospectionRoot(name: []const u8) bool {
    return std.mem.eql(u8, name, "__schema") or std.mem.eql(u8, name, "__type");
}

fn allowedVariableUsage(var_type: *const TypeRef, var_default: ?*const ast.Value, location_type: *const TypeRef, location_default: DefaultValue) bool {
    if (location_type.isNonNull() and !var_type.isNonNull()) {
        const has_var_default = var_default != null and var_default.?.data != .null;
        if (!has_var_default and location_default == null) return false;
        return isTypeSubTypeOf(var_type, location_type.non_null);
    }
    return isTypeSubTypeOf(var_type, location_type);
}

fn isTypeSubTypeOf(sub: *const TypeRef, super: *const TypeRef) bool {
    if (super.* == .non_null) return sub.* == .non_null and isTypeSubTypeOf(sub.non_null, super.non_null);
    if (sub.* == .non_null) return isTypeSubTypeOf(sub.non_null, super);
    if (super.* == .list) return sub.* == .list and isTypeSubTypeOf(sub.list, super.list);
    if (sub.* == .list) return false;
    return sub.named == super.named; // no abstract types in this schema
}

fn isRequired(a: InputValue) bool {
    return a.type.isNonNull() and a.default_value == null;
}

fn hasArgument(args: []const ast.Argument, name: []const u8) bool {
    for (args) |a| if (std.mem.eql(u8, a.name.value, name)) return true;
    return false;
}

fn hasObjectField(fields: []const ast.ObjectField, name: []const u8) bool {
    for (fields) |f| if (std.mem.eql(u8, f.name.value, name)) return true;
    return false;
}

pub const LiteralError = struct { message: []const u8, locations: []const u32 };

/// graphql-js leaf `parseLiteral` failures for a literal (non-variable) node.
pub fn literalError(arena: Allocator, named: *const NamedType, v: *const ast.Value) Allocator.Error!?LiteralError {
    const at = try arena.dupe(u32, &.{v.loc});
    if (named.kind == .@"enum") {
        if (v.data != .enum_value) {
            const shown = try printer.printValue(arena, v);
            var msg: std.ArrayList(u8) = .empty;
            try msg.print(arena, "Enum \"{s}\" cannot represent non-enum value: {s}.", .{ named.name, shown });
            try suggest.didYouMean(arena, &msg, "the enum value", try suggest.suggestionList(arena, shown, named.enum_values));
            return .{ .message = msg.items, .locations = at };
        }
        if (!named.hasEnumValue(v.data.enum_value)) {
            const shown = v.data.enum_value;
            var msg: std.ArrayList(u8) = .empty;
            try msg.print(arena, "Value \"{s}\" does not exist in \"{s}\" enum.", .{ shown, named.name });
            try suggest.didYouMean(arena, &msg, "the enum value", try suggest.suggestionList(arena, shown, named.enum_values));
            return .{ .message = msg.items, .locations = at };
        }
        return null;
    }
    switch (named.scalar) {
        .int => {
            if (v.data != .int) return .{ .message = try std.fmt.allocPrint(arena, "Int cannot represent non-integer value: {s}", .{try printer.printValue(arena, v)}), .locations = at };
            if (parseInt32(v.data.int) == null) return .{ .message = try std.fmt.allocPrint(arena, "Int cannot represent non 32-bit signed integer value: {s}", .{v.data.int}), .locations = at };
        },
        .float => if (v.data != .float and v.data != .int) {
            return .{ .message = try std.fmt.allocPrint(arena, "Float cannot represent non numeric value: {s}", .{try printer.printValue(arena, v)}), .locations = at };
        },
        .string => if (v.data != .string) {
            return .{ .message = try std.fmt.allocPrint(arena, "String cannot represent a non string value: {s}", .{try printer.printValue(arena, v)}), .locations = at };
        },
        .boolean => if (v.data != .boolean) {
            return .{ .message = try std.fmt.allocPrint(arena, "Boolean cannot represent a non boolean value: {s}", .{try printer.printValue(arena, v)}), .locations = at };
        },
        .id => if (v.data != .string and v.data != .int) {
            return .{ .message = try std.fmt.allocPrint(arena, "ID cannot represent a non-string and non-integer value: {s}", .{try printer.printValue(arena, v)}), .locations = at };
        },
        .custom => {
            const kind: ?[]const u8 = switch (v.data) {
                .enum_value => "EnumValue",
                .list => "ListValue",
                .object => "ObjectValue",
                else => null,
            };
            // Pass-through scalars throw a location-less GraphQLError.
            if (kind) |k| return .{ .message = try std.fmt.allocPrint(arena, "{s} cannot represent literal {s}", .{ named.name, k }), .locations = &.{} };
        },
    }
    return null;
}

/// `parseInt(text, 10)` within GraphQL's 32-bit Int range.
pub fn parseInt32(text: []const u8) ?i32 {
    return std.fmt.parseInt(i32, text, 10) catch null;
}

// ---------------------------------------------------------------------------
// Variable usages (fresh TypeInfo walk, VariableDefinition subtrees skipped)
// ---------------------------------------------------------------------------

const UsageCollector = struct {
    ti: TypeInfo,
    arena: Allocator,
    usages: std.ArrayList(VariableUsage) = .empty,

    fn operation(self: *UsageCollector, op: *const ast.Operation) Abort!void {
        try self.ti.enterOperation(op);
        for (op.directives) |*d| try self.directive(d);
        try self.selectionSet(op.selection_set);
        self.ti.leaveTypeScope();
    }

    fn fragment(self: *UsageCollector, frag: *const ast.Fragment) Abort!void {
        try self.ti.enterFragmentLike(frag.type_condition);
        for (frag.directives) |*d| try self.directive(d);
        try self.selectionSet(frag.selection_set);
        self.ti.leaveTypeScope();
    }

    fn selectionSet(self: *UsageCollector, set: *const ast.SelectionSet) Abort!void {
        try self.ti.enterSelectionSet();
        for (set.selections) |sel| switch (sel) {
            .field => |f| {
                try self.ti.enterField(f);
                for (f.arguments) |*arg| try self.argument(arg);
                for (f.directives) |*d| try self.directive(d);
                if (f.selection_set) |s| try self.selectionSet(s);
                self.ti.leaveField();
            },
            .fragment_spread => |fs| for (fs.directives) |*d| try self.directive(d),
            .inline_fragment => |f| {
                try self.ti.enterFragmentLike(f.type_condition);
                for (f.directives) |*d| try self.directive(d);
                try self.selectionSet(f.selection_set);
                self.ti.leaveTypeScope();
            },
        };
        self.ti.leaveSelectionSet();
    }

    fn directive(self: *UsageCollector, d: *const ast.Directive) Abort!void {
        self.ti.enterDirective(d);
        for (d.arguments) |*arg| try self.argument(arg);
        self.ti.leaveDirective();
    }

    fn argument(self: *UsageCollector, arg: *const ast.Argument) Abort!void {
        try self.ti.enterArgument(arg);
        try self.value(arg.value);
        self.ti.leaveArgument();
    }

    fn value(self: *UsageCollector, v: *const ast.Value) Abort!void {
        switch (v.data) {
            .variable => |*variable| try self.usages.append(self.arena, .{
                .node = variable,
                .type = self.ti.getInputType(),
                .default_value = self.ti.getDefaultValue(),
                .parent_type = self.ti.getParentInputType(),
            }),
            .list => |items| {
                try self.ti.enterList();
                for (items) |item| try self.value(item);
                self.ti.leaveInputScope();
            },
            .object => |fields| for (fields) |*of| {
                try self.ti.enterObjectField(of);
                try self.value(of.value);
                self.ti.leaveInputScope();
            },
            else => {},
        }
    }
};

// ---------------------------------------------------------------------------
// OverlappingFieldsCanBeMerged
// ---------------------------------------------------------------------------

const FieldEntry = struct { parent: ?*NamedType, node: *const ast.Field, def: ?*const Field };

const FieldMap = struct {
    names: std.ArrayList([]const u8) = .empty,
    entries: std.StringHashMapUnmanaged(std.ArrayList(FieldEntry)) = .empty,
};

const FieldsAndFragments = struct { fields: *FieldMap, fragment_names: []const []const u8 };

const Reason = union(enum) {
    message: []const u8,
    sub: []const ConflictReason,
};

const ConflictReason = struct { response_name: []const u8, reason: Reason };

const Conflict = struct {
    reason: ConflictReason,
    fields1: []const *const ast.Field,
    fields2: []const *const ast.Field,
};

const Overlap = struct {
    v: *Validator,
    cache: std.AutoHashMapUnmanaged(usize, FieldsAndFragments) = .empty,
    /// (fieldMap identity, fragment name) -> areMutuallyExclusive
    field_fragment_pairs: std.AutoHashMapUnmanaged(usize, std.StringHashMapUnmanaged(bool)) = .empty,
    fragment_pairs: std.StringHashMapUnmanaged(std.StringHashMapUnmanaged(bool)) = .empty,

    fn selectionSet(self: *Overlap, parent: ?*NamedType, set: *const ast.SelectionSet) Abort!void {
        var conflicts: std.ArrayList(Conflict) = .empty;
        const ff = try self.getFieldsAndFragmentNames(parent, set);
        try self.collectConflictsWithin(&conflicts, ff.fields);
        for (ff.fragment_names, 0..) |name, i| {
            try self.collectConflictsBetweenFieldsAndFragment(&conflicts, false, ff.fields, name);
            for (ff.fragment_names[i + 1 ..]) |other| {
                try self.collectConflictsBetweenFragments(&conflicts, false, name, other);
            }
        }
        const a = self.v.arena;
        for (conflicts.items) |c| {
            var reason: std.ArrayList(u8) = .empty;
            try writeReason(a, &reason, c.reason.reason);
            const locations = try a.alloc(u32, c.fields1.len + c.fields2.len);
            for (c.fields1, 0..) |f, i| locations[i] = f.loc;
            for (c.fields2, 0..) |f, i| locations[c.fields1.len + i] = f.loc;
            try self.v.reportf(locations, "Fields \"{s}\" conflict because {s}. Use different aliases on the fields to fetch both if this was intentional.", .{ c.reason.response_name, reason.items });
        }
    }

    fn writeReason(a: Allocator, out: *std.ArrayList(u8), reason: Reason) Allocator.Error!void {
        switch (reason) {
            .message => |m| try out.appendSlice(a, m),
            .sub => |subs| for (subs, 0..) |s, i| {
                if (i > 0) try out.appendSlice(a, " and ");
                try out.print(a, "subfields \"{s}\" conflict because ", .{s.response_name});
                try writeReason(a, out, s.reason);
            },
        }
    }

    fn pairHas(map: anytype, key: anytype, b: []const u8, weakly_present: bool, a: Allocator) bool {
        _ = a;
        const inner = map.get(key) orelse return false;
        const result = inner.get(b) orelse return false;
        return if (weakly_present) true else weakly_present == result;
    }

    fn collectConflictsBetweenFieldsAndFragment(self: *Overlap, conflicts: *std.ArrayList(Conflict), exclusive: bool, fields: *FieldMap, fragment_name: []const u8) Abort!void {
        const a = self.v.arena;
        const key = @intFromPtr(fields);
        if (pairHas(self.field_fragment_pairs, key, fragment_name, exclusive, a)) return;
        const gop = try self.field_fragment_pairs.getOrPut(a, key);
        if (!gop.found_existing) gop.value_ptr.* = .empty;
        try gop.value_ptr.put(a, fragment_name, exclusive);
        const frag = self.v.getFragment(fragment_name) orelse return;
        const ff2 = try self.getReferencedFieldsAndFragmentNames(frag);
        if (fields == ff2.fields) return;
        try self.collectConflictsBetween(conflicts, exclusive, fields, ff2.fields);
        for (ff2.fragment_names) |name| {
            try self.collectConflictsBetweenFieldsAndFragment(conflicts, exclusive, fields, name);
        }
    }

    fn collectConflictsBetweenFragments(self: *Overlap, conflicts: *std.ArrayList(Conflict), exclusive: bool, name1: []const u8, name2: []const u8) Abort!void {
        const a = self.v.arena;
        if (std.mem.eql(u8, name1, name2)) return;
        const lo, const hi = if (std.mem.lessThan(u8, name1, name2)) .{ name1, name2 } else .{ name2, name1 };
        if (pairHas(self.fragment_pairs, lo, hi, exclusive, a)) return;
        const gop = try self.fragment_pairs.getOrPut(a, lo);
        if (!gop.found_existing) gop.value_ptr.* = .empty;
        try gop.value_ptr.put(a, hi, exclusive);
        const frag1 = self.v.getFragment(name1) orelse return;
        const frag2 = self.v.getFragment(name2) orelse return;
        const ff1 = try self.getReferencedFieldsAndFragmentNames(frag1);
        const ff2 = try self.getReferencedFieldsAndFragmentNames(frag2);
        try self.collectConflictsBetween(conflicts, exclusive, ff1.fields, ff2.fields);
        for (ff2.fragment_names) |n| try self.collectConflictsBetweenFragments(conflicts, exclusive, name1, n);
        for (ff1.fragment_names) |n| try self.collectConflictsBetweenFragments(conflicts, exclusive, n, name2);
    }

    fn findConflictsBetweenSubSelectionSets(self: *Overlap, exclusive: bool, parent1: ?*NamedType, set1: *const ast.SelectionSet, parent2: ?*NamedType, set2: *const ast.SelectionSet) Abort![]const Conflict {
        var conflicts: std.ArrayList(Conflict) = .empty;
        const ff1 = try self.getFieldsAndFragmentNames(parent1, set1);
        const ff2 = try self.getFieldsAndFragmentNames(parent2, set2);
        try self.collectConflictsBetween(&conflicts, exclusive, ff1.fields, ff2.fields);
        for (ff2.fragment_names) |n| try self.collectConflictsBetweenFieldsAndFragment(&conflicts, exclusive, ff1.fields, n);
        for (ff1.fragment_names) |n| try self.collectConflictsBetweenFieldsAndFragment(&conflicts, exclusive, ff2.fields, n);
        for (ff1.fragment_names) |n1| for (ff2.fragment_names) |n2| {
            try self.collectConflictsBetweenFragments(&conflicts, exclusive, n1, n2);
        };
        return conflicts.items;
    }

    fn collectConflictsWithin(self: *Overlap, conflicts: *std.ArrayList(Conflict), fields: *FieldMap) Abort!void {
        for (fields.names.items) |name| {
            const list = fields.entries.get(name).?.items;
            if (list.len < 2) continue;
            for (list, 0..) |f1, i| for (list[i + 1 ..]) |f2| {
                if (try self.findConflict(false, name, f1, f2)) |c| try conflicts.append(self.v.arena, c);
            };
        }
    }

    fn collectConflictsBetween(self: *Overlap, conflicts: *std.ArrayList(Conflict), exclusive: bool, map1: *FieldMap, map2: *FieldMap) Abort!void {
        for (map1.names.items) |name| {
            const list2 = map2.entries.get(name) orelse continue;
            for (map1.entries.get(name).?.items) |f1| for (list2.items) |f2| {
                if (try self.findConflict(exclusive, name, f1, f2)) |c| try conflicts.append(self.v.arena, c);
            };
        }
    }

    fn findConflict(self: *Overlap, parent_exclusive: bool, response_name: []const u8, f1: FieldEntry, f2: FieldEntry) Abort!?Conflict {
        const a = self.v.arena;
        const exclusive = parent_exclusive or (f1.parent != f2.parent and f1.parent != null and f2.parent != null and
            f1.parent.?.kind == .object and f2.parent.?.kind == .object);
        const one1 = try a.dupe(*const ast.Field, &.{f1.node});
        const one2 = try a.dupe(*const ast.Field, &.{f2.node});
        if (!exclusive) {
            if (!std.mem.eql(u8, f1.node.name.value, f2.node.name.value)) {
                return .{
                    .reason = .{ .response_name = response_name, .reason = .{ .message = try std.fmt.allocPrint(a, "\"{s}\" and \"{s}\" are different fields", .{ f1.node.name.value, f2.node.name.value }) } },
                    .fields1 = one1,
                    .fields2 = one2,
                };
            }
            if (!try sameArguments(a, f1.node.arguments, f2.node.arguments)) {
                return .{ .reason = .{ .response_name = response_name, .reason = .{ .message = "they have differing arguments" } }, .fields1 = one1, .fields2 = one2 };
            }
        }
        const type1 = if (f1.def) |d| d.type else null;
        const type2 = if (f2.def) |d| d.type else null;
        if (type1 != null and type2 != null and doTypesConflict(type1.?, type2.?)) {
            return .{
                .reason = .{ .response_name = response_name, .reason = .{ .message = try std.fmt.allocPrint(a, "they return conflicting types \"{f}\" and \"{f}\"", .{ type1.?, type2.? }) } },
                .fields1 = one1,
                .fields2 = one2,
            };
        }
        const set1 = f1.node.selection_set orelse return null;
        const set2 = f2.node.selection_set orelse return null;
        const sub = try self.findConflictsBetweenSubSelectionSets(exclusive, if (type1) |t| t.namedType() else null, set1, if (type2) |t| t.namedType() else null, set2);
        if (sub.len == 0) return null;
        const reasons = try a.alloc(ConflictReason, sub.len);
        var fields1: std.ArrayList(*const ast.Field) = .empty;
        var fields2: std.ArrayList(*const ast.Field) = .empty;
        try fields1.append(a, f1.node);
        try fields2.append(a, f2.node);
        for (sub, reasons) |c, *r| {
            r.* = c.reason;
            try fields1.appendSlice(a, c.fields1);
            try fields2.appendSlice(a, c.fields2);
        }
        return .{ .reason = .{ .response_name = response_name, .reason = .{ .sub = reasons } }, .fields1 = fields1.items, .fields2 = fields2.items };
    }

    fn getFieldsAndFragmentNames(self: *Overlap, parent: ?*NamedType, set: *const ast.SelectionSet) Abort!FieldsAndFragments {
        const a = self.v.arena;
        if (self.cache.get(@intFromPtr(set))) |cached| return cached;
        const map = try a.create(FieldMap);
        map.* = .{};
        var fragment_names: std.ArrayList([]const u8) = .empty;
        try self.collectFieldsAndFragmentNames(parent, set, map, &fragment_names);
        const result: FieldsAndFragments = .{ .fields = map, .fragment_names = fragment_names.items };
        try self.cache.put(a, @intFromPtr(set), result);
        return result;
    }

    fn getReferencedFieldsAndFragmentNames(self: *Overlap, frag: *const ast.Fragment) Abort!FieldsAndFragments {
        if (self.cache.get(@intFromPtr(frag.selection_set))) |cached| return cached;
        return self.getFieldsAndFragmentNames(self.v.schema.getType(frag.type_condition.value), frag.selection_set);
    }

    fn collectFieldsAndFragmentNames(self: *Overlap, parent: ?*NamedType, set: *const ast.SelectionSet, map: *FieldMap, fragment_names: *std.ArrayList([]const u8)) Abort!void {
        const a = self.v.arena;
        for (set.selections) |sel| switch (sel) {
            .field => |f| {
                const def: ?*const Field = if (parent != null and parent.?.kind == .object) parent.?.field(f.name.value) else null;
                const name = f.responseName();
                const gop = try map.entries.getOrPut(a, name);
                if (!gop.found_existing) {
                    gop.value_ptr.* = .empty;
                    try map.names.append(a, name);
                }
                try gop.value_ptr.append(a, .{ .parent = parent, .node = f, .def = def });
            },
            .fragment_spread => |fs| {
                for (fragment_names.items) |n| {
                    if (std.mem.eql(u8, n, fs.name.value)) break;
                } else try fragment_names.append(a, fs.name.value);
            },
            .inline_fragment => |f| {
                const frag_parent = if (f.type_condition) |tc| self.v.schema.getType(tc.value) else parent;
                try self.collectFieldsAndFragmentNames(frag_parent, f.selection_set, map, fragment_names);
            },
        };
    }
};

fn sameArguments(a: Allocator, args1: []const ast.Argument, args2: []const ast.Argument) !bool {
    if (args1.len == 0) return args2.len == 0;
    if (args2.len == 0) return false;
    if (args1.len != args2.len) return false;
    for (args1) |arg1| {
        // `new Map(args2...)`: the last duplicate name wins.
        var value2: ?*const ast.Value = null;
        for (args2) |arg2| if (std.mem.eql(u8, arg2.name.value, arg1.name.value)) {
            value2 = arg2.value;
        };
        const v2 = value2 orelse return false;
        const s1 = try printer.printValue(a, try sortValueNode(a, arg1.value));
        const s2 = try printer.printValue(a, try sortValueNode(a, v2));
        if (!std.mem.eql(u8, s1, s2)) return false;
    }
    return true;
}

fn sortValueNode(a: Allocator, v: *const ast.Value) Allocator.Error!*const ast.Value {
    switch (v.data) {
        .object => |fields| {
            const sorted = try a.alloc(ast.ObjectField, fields.len);
            for (fields, sorted) |f, *s| s.* = .{ .loc = f.loc, .name = f.name, .value = @constCast(try sortValueNode(a, f.value)) };
            std.mem.sort(ast.ObjectField, sorted, {}, struct {
                fn lessThan(_: void, x: ast.ObjectField, y: ast.ObjectField) bool {
                    return suggest.naturalCompare(x.name.value, y.name.value) < 0;
                }
            }.lessThan);
            const out = try a.create(ast.Value);
            out.* = .{ .loc = v.loc, .data = .{ .object = sorted } };
            return out;
        },
        .list => |items| {
            const sorted = try a.alloc(*ast.Value, items.len);
            for (items, sorted) |item, *s| s.* = @constCast(try sortValueNode(a, item));
            const out = try a.create(ast.Value);
            out.* = .{ .loc = v.loc, .data = .{ .list = sorted } };
            return out;
        },
        else => return v,
    }
}

fn doTypesConflict(t1: *const TypeRef, t2: *const TypeRef) bool {
    if (t1.* == .list) return if (t2.* == .list) doTypesConflict(t1.list, t2.list) else true;
    if (t2.* == .list) return true;
    if (t1.* == .non_null) return if (t2.* == .non_null) doTypesConflict(t1.non_null, t2.non_null) else true;
    if (t2.* == .non_null) return true;
    const n1 = t1.named;
    const n2 = t2.named;
    if (n1.isLeaf() or n2.isLeaf()) return n1 != n2;
    return false;
}
