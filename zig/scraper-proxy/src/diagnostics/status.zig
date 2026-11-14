//! Port of `src/diagnostics/status.ts`: zod-equivalent activity validation and
//! the relayer status reduction. Output objects are built with the same spread
//! and assignment sequence as the TypeScript so key order (and therefore the
//! WebSocket bytes) matches.
const std = @import("std");
const Allocator = std.mem.Allocator;
const js = @import("js.zig");
const Value = js.Value;
const Object = js.Object;

pub const phases = [_][]const u8{
    "unknown",    "preparing",  "ready_to_submit", "awaiting_signatures", "retrying",
    "submitting", "confirming", "delivered",       "dropped",
};
pub const verification_outcomes = [_][]const u8{ "unknown", "started", "succeeded", "failed", "no_estimate", "unavailable" };

// ------------------------------------------------------------ mini zod

/// The subset of zod 4 the TypeScript schemas use. Objects emit declared keys
/// in declaration order (absent optionals omitted), then — for loose objects —
/// undeclared keys in input order; zod drops own `__proto__` keys.
pub const Schema = union(enum) {
    string,
    /// `z.number().int().nonnegative()`: safe integer >= 0.
    count,
    unknown,
    phase,
    /// `z.string().nullish().transform(...)` onto VerificationOutcome.
    verification,
    nullable: *const Schema,
    optional: *const Schema,
    nullish: *const Schema,
    array: *const Schema,
    record: *const Schema,
    object: ObjectSchema,
    any_of: []const Schema,
    discriminated: []const Option,

    pub const Field = struct { key: []const u8, schema: Schema };
    pub const ObjectSchema = struct { fields: []const Field, loose: bool = false };
    pub const Option = struct { tag: []const u8, fields: []const Field };
};

pub const Invalid = error{ Invalid, OutOfMemory };

fn acceptsMissing(schema: Schema) bool {
    return switch (schema) {
        .optional, .nullish, .verification => true,
        else => false,
    };
}

pub fn validate(arena: Allocator, schema: Schema, input: Value) Invalid!Value {
    switch (schema) {
        .string => return if (input == .string) input else error.Invalid,
        .count => {
            if (input != .number or !js.isSafeInteger(input.number) or input.number < 0) return error.Invalid;
            return input;
        },
        .unknown => return input,
        .phase => {
            const s = input.str() orelse return error.Invalid;
            for (phases) |p| if (std.mem.eql(u8, p, s)) return input;
            return error.Invalid;
        },
        .verification => {
            if (input.isNullish()) return input;
            const s = input.str() orelse return error.Invalid;
            return .{ .string = outcome(s) };
        },
        .nullable => |inner| return if (input == .null) input else validate(arena, inner.*, input),
        .optional => |inner| return if (input == .undefined) input else validate(arena, inner.*, input),
        .nullish => |inner| return if (input.isNullish()) input else validate(arena, inner.*, input),
        .array => |inner| {
            if (input != .array) return error.Invalid;
            const out = try js.newArray(arena, &.{});
            try out.ensureTotalCapacity(arena, input.array.items.len);
            for (input.array.items) |item| out.appendAssumeCapacity(try validate(arena, inner.*, item));
            return .{ .array = out };
        },
        .record => |inner| {
            if (input != .object) return error.Invalid;
            const out = try js.newObject(arena);
            for (input.object.entries.items) |entry| {
                if (std.mem.eql(u8, entry.key, "__proto__")) continue;
                try out.put(arena, entry.key, try validate(arena, inner.*, entry.value));
            }
            return .{ .object = out };
        },
        .object => |shape| return validateObject(arena, shape.fields, shape.loose, input),
        .any_of => |options| {
            for (options) |option| {
                return validate(arena, option, input) catch |err| switch (err) {
                    error.Invalid => continue,
                    else => return err,
                };
            }
            return error.Invalid;
        },
        .discriminated => |options| {
            if (input != .object) return error.Invalid;
            const discriminator = input.object.get("type").str() orelse return error.Invalid;
            for (options) |option| {
                if (std.mem.eql(u8, option.tag, discriminator)) return validateObject(arena, option.fields, false, input);
            }
            return error.Invalid;
        },
    }
}

fn validateObject(arena: Allocator, fields: []const Schema.Field, loose: bool, input: Value) Invalid!Value {
    if (input != .object) return error.Invalid;
    const in = input.object;
    const out = try js.newObject(arena);
    for (fields) |field| {
        const value = in.get(field.key);
        if (value == .undefined) {
            if (acceptsMissing(field.schema)) continue;
            return error.Invalid;
        }
        try out.put(arena, field.key, try validate(arena, field.schema, value));
    }
    if (loose) {
        outer: for (in.entries.items) |entry| {
            if (std.mem.eql(u8, entry.key, "__proto__")) continue;
            for (fields) |field| if (std.mem.eql(u8, field.key, entry.key)) continue :outer;
            try out.put(arena, entry.key, entry.value);
        }
    }
    return .{ .object = out };
}

fn outcome(s: []const u8) []const u8 {
    for (verification_outcomes) |o| if (std.mem.eql(u8, o, s)) return o;
    return "unknown";
}

// ------------------------------------------------------------ schemas

const S = Schema;
const string: S = .string;
const count: S = .count;
const string_nullish: S = .{ .nullish = &string };
const string_nullable: S = .{ .nullable = &string };
const string_array: S = .{ .array = &string };
const count_nullish: S = .{ .nullish = &count };
const count_nullable: S = .{ .nullable = &count };
const unknown_record: S = .{ .record = &.unknown };
const reason: S = .{ .any_of = &.{ string, unknown_record } };

const child: S = .{ .object = .{ .fields = &.{ .{ .key = "node_id", .schema = string }, .{ .key = "ism", .schema = string } } } };
const signer: S = .{ .object = .{ .fields = &.{
    .{ .key = "validator", .schema = string },
    .{ .key = "location", .schema = string_nullish },
} } };
const unavailable_entry: S = .{ .object = .{ .fields = &.{
    .{ .key = "validator", .schema = string },
    .{ .key = "reason", .schema = string },
} } };
const snapshot_signatures: S = .{ .object = .{ .fields = &.{
    .{ .key = "collection_id", .schema = string_nullish },
    .{ .key = "index", .schema = count_nullish },
    .{ .key = "root", .schema = string_nullish },
    .{ .key = "collected", .schema = count_nullish },
    .{ .key = "signers", .schema = .{ .optional = &S{ .array = &signer } } },
    .{ .key = "threshold", .schema = count },
    .{ .key = "unavailable", .schema = .{ .array = &unavailable_entry } },
} } };
const snapshot_offchain_read: S = .{ .object = .{ .fields = &.{
    .{ .key = "state", .schema = string },
    .{ .key = "attempt", .schema = count_nullish },
    .{ .key = "endpoint", .schema = count_nullable },
    .{ .key = "http_status", .schema = count_nullable },
} } };
const snapshot_module: S = .{ .object = .{ .loose = true, .fields = &.{
    .{ .key = "node_id", .schema = string },
    .{ .key = "ism", .schema = string },
    .{ .key = "module_type", .schema = string_nullish },
    .{ .key = "validators", .schema = .{ .nullish = &string_array } },
    .{ .key = "threshold", .schema = count_nullish },
    .{ .key = "children", .schema = .{ .optional = &S{ .array = &child } } },
    .{ .key = "selected_children", .schema = .{ .optional = &string_array } },
    .{ .key = "verified", .schema = count_nullish },
    .{ .key = "verification", .schema = .verification },
    .{ .key = "metadata_error", .schema = string_nullish },
    .{ .key = "signatures", .schema = .{ .nullish = &snapshot_signatures } },
    .{ .key = "offchain_read", .schema = .{ .nullish = &snapshot_offchain_read } },
} } };
const snapshot_failure: S = .{ .object = .{ .fields = &.{
    .{ .key = "stage", .schema = string },
    .{ .key = "reason", .schema = string },
} } };
const snapshot_retry: S = .{ .object = .{ .fields = &.{
    .{ .key = "reason", .schema = string },
    .{ .key = "count", .schema = count },
    .{ .key = "next_attempt_at_millis", .schema = count_nullable },
} } };
const snapshot_state_fields = [_]S.Field{
    .{ .key = "phase", .schema = .phase },
    .{ .key = "tree_root", .schema = string_nullable },
    .{ .key = "modules", .schema = .{ .array = &snapshot_module } },
    .{ .key = "failure", .schema = .{ .nullish = &snapshot_failure } },
    .{ .key = "retry", .schema = .{ .nullish = &snapshot_retry } },
};
const snapshot_state: S = .{ .object = .{ .loose = true, .fields = &snapshot_state_fields } };
const snapshot_update_state: S = .{ .object = .{
    .loose = true,
    .fields = &(snapshot_state_fields ++ [_]S.Field{.{ .key = "removed_modules", .schema = string_array }}),
} };

const tag: S = .string; // checked by the discriminated union
const observation: S = .{ .discriminated = &.{
    .{ .tag = "fetching", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "index", .schema = count } } },
    .{ .tag = "signature", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "index", .schema = count },
        .{ .key = "root", .schema = string },
        .{ .key = "collected", .schema = count },
        .{ .key = "validator", .schema = string },
    } },
    .{ .tag = "unavailable", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "index", .schema = count_nullable },
        .{ .key = "validator", .schema = string },
        .{ .key = "reason", .schema = string },
    } },
    .{ .tag = "latest_index", .fields = &.{.{ .key = "type", .schema = tag }} },
} };
const summary: S = .{ .object = .{ .fields = &.{
    .{ .key = "index", .schema = count_nullable },
    .{ .key = "root", .schema = string_nullable },
    .{ .key = "collected", .schema = count },
    .{ .key = "unavailable", .schema = .{ .record = &string } },
} } };
const status_value: S = .{ .any_of = &.{
    string,
    .{ .object = .{ .fields = &.{.{ .key = "Confirm", .schema = reason }} } },
    .{ .object = .{ .fields = &.{.{ .key = "Retry", .schema = reason }} } },
} };

pub const event: S = .{ .discriminated = &.{
    .{ .tag = "snapshot", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "state", .schema = snapshot_state } } },
    .{ .tag = "snapshot_update", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "state", .schema = snapshot_update_state } } },
    .{ .tag = "chain_failure", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "stage", .schema = string },
        .{ .key = "reason", .schema = string },
    } },
    .{ .tag = "offchain_read", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "state", .schema = string },
        .{ .key = "attempt", .schema = count },
        .{ .key = "endpoint", .schema = count_nullable },
        .{ .key = "http_status", .schema = count_nullable },
    } },
    .{ .tag = "status", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "status", .schema = status_value } } },
    .{ .tag = "metadata_started", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "ism", .schema = string } } },
    .{ .tag = "metadata_module", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "module_type", .schema = string },
    } },
    .{ .tag = "validator_set", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string_nullable },
        .{ .key = "validators", .schema = string_array },
        .{ .key = "threshold", .schema = count },
    } },
    .{ .tag = "routing", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "module", .schema = string },
    } },
    .{ .tag = "aggregation", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "modules", .schema = string_array },
        .{ .key = "threshold", .schema = count },
    } },
    .{ .tag = "aggregation_progress", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "verified", .schema = count },
        .{ .key = "threshold", .schema = count },
    } },
    .{ .tag = "ism_verification", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "outcome", .schema = string },
    } },
    .{ .tag = "metadata", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string },
        .{ .key = "error", .schema = string_nullable },
    } },
    .{ .tag = "checkpoint", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "ism", .schema = string_nullable },
        .{ .key = "collection_id", .schema = string },
        .{ .key = "threshold", .schema = count },
        .{ .key = "summary", .schema = .{ .optional = &summary } },
        .{ .key = "observation", .schema = .{ .optional = &observation } },
    } },
    .{ .tag = "retry", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "reason", .schema = .{ .nullable = &reason } },
        .{ .key = "retry_count", .schema = count },
        .{ .key = "next_attempt_at_millis", .schema = count_nullable },
    } },
    .{ .tag = "progress", .fields = &.{
        .{ .key = "type", .schema = tag },
        .{ .key = "stage", .schema = string },
        .{ .key = "outcome", .schema = string },
    } },
    .{ .tag = "delivered", .fields = &.{.{ .key = "type", .schema = tag }} },
    .{ .tag = "dropped", .fields = &.{.{ .key = "type", .schema = tag }} },
    .{ .tag = "filtered", .fields = &.{ .{ .key = "type", .schema = tag }, .{ .key = "reason", .schema = string } } },
    .{ .tag = "retry_limit_reached", .fields = &.{.{ .key = "type", .schema = tag }} },
} };

// ------------------------------------------------------------ reducer

/// A validated `ActivityRow` (see service.zig); `object` is the row as
/// emitted, the other fields are views into it.
pub const ActivityRow = struct {
    object: *Object,
    id: []const u8,
    relayer: []const u8,
    observed_at: []const u8,
    version: f64,
    activity: *Object,
};

fn eql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

fn str(s: []const u8) Value {
    return .{ .string = s };
}

fn objectOf(value: Value) ?*Object {
    return if (value == .object) value.object else null;
}

/// Ordered string map with JavaScript `Map` semantics (set keeps position,
/// delete then set appends).
fn OrderedMap(comptime V: type) type {
    return std.StringArrayHashMapUnmanaged(V);
}

/// Last observed diagnostics, never authoritative on-chain delivery state.
/// Rows are ordered by insertion ID; each relayer and checkpoint collection is isolated.
pub fn reduceStatus(arena: Allocator, rows: []const ActivityRow) Allocator.Error![]Value {
    var relayers: OrderedMap(*Object) = .empty;
    var anchors: OrderedMap(*Object) = .empty;
    for (rows) |row| {
        const entry = try relayers.getOrPut(arena, row.relayer);
        if (!entry.found_existing) {
            const created = try js.newObject(arena);
            try created.put(arena, "relayer", str(row.relayer));
            try created.put(arena, "phase", str("unknown"));
            try created.put(arena, "observed_at", str(row.observed_at));
            try created.put(arena, "modules", .{ .array = try js.newArray(arena, &.{}) });
            entry.value_ptr.* = created;
        }
        const state = entry.value_ptr.*;
        try state.put(arena, "observed_at", str(row.observed_at));
        // Unknown versions/types remain visible in history without inventing semantics.
        if (row.version != 1) continue;
        const parsed = validate(arena, event, .{ .object = row.activity }) catch |err| switch (err) {
            error.Invalid => continue,
            error.OutOfMemory => return error.OutOfMemory,
        };
        const value = parsed.object;
        const kind = value.get("type").string;
        if (eql(kind, "snapshot") or eql(kind, "snapshot_update")) {
            const update = eql(kind, "snapshot_update");
            const value_state = value.get("state").object;
            if (!update) try anchors.put(arena, row.relayer, value_state);
            // A cumulative update cannot describe nodes omitted from a missing anchor.
            const anchor = anchors.get(row.relayer) orelse continue;
            var modules: OrderedMap(*Object) = .empty;
            for (anchor.get("modules").array.items) |module| {
                try modules.put(arena, module.object.get("node_id").string, module.object);
            }
            if (update) {
                for (value_state.get("removed_modules").array.items) |id| _ = modules.orderedRemove(id.string);
                for (value_state.get("modules").array.items) |module| {
                    try modules.put(arena, module.object.get("node_id").string, module.object);
                }
            }
            const next = try value_state.clone(arena);
            try next.put(arena, "relayer", str(row.relayer));
            try next.put(arena, "observed_at", str(row.observed_at));
            const out_modules = try js.newArray(arena, &.{});
            for (modules.values()) |module| {
                try out_modules.append(arena, .{ .object = try snapshotModuleOutput(arena, module, row.observed_at) });
            }
            try next.put(arena, "modules", .{ .array = out_modules });
            entry.value_ptr.* = next;
            continue;
        }
        if (value.has("ism")) try applyModuleEvent(arena, state, value, kind, row.observed_at);
        try applyPhase(arena, state, value, kind);
        const phase = state.get("phase").str() orelse "";
        if (!eql(phase, "retrying") and !eql(phase, "awaiting_signatures")) try state.put(arena, "retry", .undefined);
    }
    const out = try arena.alloc(Value, relayers.count());
    for (relayers.values(), out) |state, *slot| slot.* = .{ .object = state };
    return out;
}

fn snapshotModuleOutput(arena: Allocator, module: *Object, observed_at: []const u8) Allocator.Error!*Object {
    const out = try module.clone(arena);
    try out.put(arena, "observed_at", str(observed_at));
    // `module.children?.map((child) => child.ism)`
    var children: Value = .undefined;
    if (module.get("children") == .array) {
        const items = module.get("children").array.items;
        const isms = try js.newArray(arena, &.{});
        for (items) |c| try isms.append(arena, c.object.get("ism"));
        children = .{ .array = isms };
    }
    try out.put(arena, "modules", children);
    // `module.signatures && { ...signatures, collection_id: signatures.collection_id ?? null }`
    const signatures = module.get("signatures");
    if (signatures == .object) {
        const copy = try signatures.object.clone(arena);
        const id = copy.get("collection_id");
        try copy.put(arena, "collection_id", if (id.isNullish()) .null else id);
        try out.put(arena, "signatures", .{ .object = copy });
    } else try out.put(arena, "signatures", signatures);
    const offchain = module.get("offchain_read");
    if (offchain == .object) {
        const copy = try offchain.object.clone(arena);
        const attempt = copy.get("attempt");
        try copy.put(arena, "attempt", if (attempt.isNullish()) .null else attempt);
        try out.put(arena, "offchain_read", .{ .object = copy });
    } else try out.put(arena, "offchain_read", offchain);
    return out;
}

fn applyModuleEvent(arena: Allocator, state: *Object, value: *Object, kind: []const u8, observed_at: []const u8) Allocator.Error!void {
    // Null ISMs still carry validator/checkpoint progress from the relayer.
    const ism_value = value.get("ism");
    const module_ism = ism_value.str() orelse "unknown";
    const current = state.get("modules").array;
    var module: ?*Object = null;
    for (current.items) |m| {
        if (js.strictEqual(m.object.get("ism"), str(module_ism))) {
            module = m.object;
            break;
        }
    }
    if (module == null or eql(kind, "metadata_started") or eql(kind, "metadata_module")) {
        const filtered = try js.newArray(arena, &.{});
        for (current.items) |m| {
            if (!js.strictEqual(m.object.get("ism"), str(module_ism))) try filtered.append(arena, m);
        }
        const created = try js.newObject(arena);
        try created.put(arena, "ism", str(module_ism));
        try created.put(arena, "observed_at", str(observed_at));
        try filtered.append(arena, .{ .object = created });
        try state.put(arena, "modules", .{ .array = filtered });
        module = created;
    }
    const m = module.?;
    try m.put(arena, "observed_at", str(observed_at));
    if (eql(kind, "metadata_module")) {
        try m.put(arena, "module_type", value.get("module_type"));
    } else if (eql(kind, "validator_set")) {
        try m.put(arena, "validators", value.get("validators"));
        try m.put(arena, "threshold", value.get("threshold"));
    } else if (eql(kind, "routing")) {
        try m.put(arena, "routed_module", value.get("module"));
    } else if (eql(kind, "aggregation")) {
        try m.put(arena, "modules", value.get("modules"));
        try m.put(arena, "threshold", value.get("threshold"));
    } else if (eql(kind, "aggregation_progress")) {
        try m.put(arena, "verified", value.get("verified"));
        try m.put(arena, "threshold", value.get("threshold"));
    } else if (eql(kind, "ism_verification")) {
        try m.put(arena, "verification", str(outcome(value.get("outcome").string)));
    } else if (eql(kind, "metadata")) {
        try m.put(arena, "metadata_error", value.get("error"));
    } else if (eql(kind, "offchain_read")) {
        const read = try js.newObject(arena);
        try read.put(arena, "state", value.get("state"));
        try read.put(arena, "attempt", value.get("attempt"));
        try read.put(arena, "endpoint", value.get("endpoint"));
        try read.put(arena, "http_status", value.get("http_status"));
        try m.put(arena, "offchain_read", .{ .object = read });
    } else if (eql(kind, "checkpoint")) {
        try applyCheckpoint(arena, m, value);
    }
}

fn applyCheckpoint(arena: Allocator, module: *Object, value: *Object) Allocator.Error!void {
    const collection_id = value.get("collection_id");
    if (objectOf(value.get("summary"))) |sum| {
        const signatures = try js.newObject(arena);
        try signatures.put(arena, "collection_id", collection_id);
        try signatures.put(arena, "threshold", value.get("threshold"));
        try signatures.put(arena, "index", sum.get("index"));
        try signatures.put(arena, "root", sum.get("root"));
        try signatures.put(arena, "collected", sum.get("collected"));
        const unavailable = try js.newArray(arena, &.{});
        for (sum.get("unavailable").object.entries.items) |e| {
            const item = try js.newObject(arena);
            try item.put(arena, "validator", str(e.key));
            try item.put(arena, "reason", e.value);
            try unavailable.append(arena, .{ .object = item });
        }
        try signatures.put(arena, "unavailable", .{ .array = unavailable });
        try module.put(arena, "signatures", .{ .object = signatures });
        return;
    }
    const obs = objectOf(value.get("observation")) orelse return;
    const obs_type = obs.get("type").string;
    const obs_index = obs.get("index"); // undefined for latest_index
    const has_index = obs.has("index") and obs_index != .null;
    var progress = objectOf(module.get("signatures"));
    if (progress == null or
        !js.strictEqual(progress.?.get("collection_id"), collection_id) or
        (has_index and !js.strictEqual(progress.?.get("index"), obs_index)))
    {
        const fresh = try js.newObject(arena);
        try fresh.put(arena, "collection_id", collection_id);
        try fresh.put(arena, "threshold", value.get("threshold"));
        try fresh.put(arena, "unavailable", .{ .array = try js.newArray(arena, &.{}) });
        try module.put(arena, "signatures", .{ .object = fresh });
        progress = fresh;
    }
    const p = progress.?;
    if (eql(obs_type, "latest_index")) return;
    if (has_index) try p.put(arena, "index", obs_index);
    if (eql(obs_type, "fetching") or obs_index == .null) return;
    const validator = obs.get("validator");
    const kept = try js.newArray(arena, &.{});
    for (p.get("unavailable").array.items) |v| {
        if (!js.strictEqual(v.object.get("validator"), validator)) try kept.append(arena, v);
    }
    try p.put(arena, "unavailable", .{ .array = kept });
    if (eql(obs_type, "signature")) {
        // Never add counts from different roots or attempts.
        try p.put(arena, "root", obs.get("root"));
        try p.put(arena, "collected", obs.get("collected"));
    } else {
        const item = try js.newObject(arena);
        try item.put(arena, "validator", validator);
        try item.put(arena, "reason", obs.get("reason"));
        try kept.append(arena, .{ .object = item });
    }
}

fn applyPhase(arena: Allocator, state: *Object, value: *Object, kind: []const u8) Allocator.Error!void {
    if (eql(kind, "chain_failure")) {
        const failure = try js.newObject(arena);
        try failure.put(arena, "stage", value.get("stage"));
        try failure.put(arena, "reason", value.get("reason"));
        try state.put(arena, "failure", .{ .object = failure });
    } else if (eql(kind, "metadata_started")) {
        try state.put(arena, "phase", str("preparing"));
        try state.put(arena, "failure", .undefined);
    } else if (eql(kind, "status")) {
        const status = value.get("status");
        switch (status) {
            .string => |s| {
                if (eql(s, "ReadyToSubmit")) {
                    try state.put(arena, "phase", str("ready_to_submit"));
                } else if (eql(s, "FirstPrepareAttempt")) {
                    try state.put(arena, "phase", str("preparing"));
                }
            },
            .object => |o| try state.put(arena, "phase", str(if (o.has("Confirm")) "confirming" else retryPhase(o.get("Retry")))),
            else => {},
        }
    } else if (eql(kind, "retry")) {
        const why = value.get("reason");
        if (why == .null) return;
        try state.put(arena, "phase", str(retryPhase(why)));
        const retry = try js.newObject(arena);
        try retry.put(arena, "reason", str(try reasonCode(arena, why)));
        try retry.put(arena, "count", value.get("retry_count"));
        try retry.put(arena, "next_attempt_at_millis", value.get("next_attempt_at_millis"));
        try state.put(arena, "retry", .{ .object = retry });
    } else if (eql(kind, "progress")) {
        if (!eql(value.get("outcome").string, "started")) return;
        const stage = value.get("stage").string;
        if (eql(stage, "prepare")) {
            try state.put(arena, "phase", str("preparing"));
            try state.put(arena, "modules", .{ .array = try js.newArray(arena, &.{}) });
            try state.put(arena, "failure", .undefined);
        } else if (eql(stage, "submit")) {
            try state.put(arena, "phase", str("submitting"));
        } else if (eql(stage, "confirm")) {
            try state.put(arena, "phase", str("confirming"));
        }
    } else if (eql(kind, "delivered")) {
        try state.put(arena, "phase", str("delivered"));
        try state.put(arena, "failure", .undefined);
    } else if (eql(kind, "dropped") or eql(kind, "filtered") or eql(kind, "retry_limit_reached")) {
        try state.put(arena, "phase", str("dropped"));
    }
}

fn retryPhase(why: Value) []const u8 {
    return if (js.strictEqual(why, str("AwaitingValidatorSignatures"))) "awaiting_signatures" else "retrying";
}

/// Serde represents payload-carrying reasons as externally tagged objects.
fn reasonCode(arena: Allocator, why: Value) Allocator.Error![]const u8 {
    switch (why) {
        .string => |s| return s,
        .object => |o| {
            const entries = o.entries.items;
            if (entries.len == 1 and entries[0].value == .string) {
                return std.fmt.allocPrint(arena, "{s}.{s}", .{ entries[0].key, entries[0].value.string });
            }
            return "unknown";
        },
        else => return "unknown",
    }
}
