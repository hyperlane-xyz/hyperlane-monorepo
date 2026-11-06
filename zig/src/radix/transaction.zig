//! Production agents use a V2 transaction with one root intent, no child
//! subintents/blobs/messages/extra signers, and the notary as signatory. This
//! codec implements that concrete model, rejecting unsupported embedded input.
const std = @import("std");
const sbor = @import("sbor.zig");
const crypto = @import("crypto.zig");
pub const Call = struct { component: [30]u8, method: []const u8, args: []const u8 };
pub fn processArgs(allocator: std.mem.Allocator, metadata: []const u8, message: []const u8, visible: []const [30]u8) ![]u8 {
    if (visible.len > 256) return error.TooManyVisibleComponents;
    var w: sbor.Writer = .{ .allocator = allocator };
    errdefer w.deinit();
    try w.byte(0x4d);
    try w.tuple(3);
    try w.bytes(metadata);
    try w.bytes(message);
    try w.array(0x80, visible.len);
    for (visible) |address| {
        try w.byte(0);
        try w.raw(&address);
    }
    return w.owned();
}
pub fn instructions(allocator: std.mem.Allocator, payer: ?[30]u8, fee_attos: i192, calls: []const Call) ![]u8 {
    if (calls.len > 256 or fee_attos < 0) return error.InvalidRadixManifest;
    var w: sbor.Writer = .{ .allocator = allocator };
    errdefer w.deinit();
    try w.raw(&.{ 0x4d, 0x20, 0x22 });
    try w.size(calls.len + @intFromBool(payer != null));
    if (payer) |address| {
        try w.raw(&.{ 0x41, 3 });
        try w.address(address);
        try w.text("lock_fee");
        try w.tuple(1);
        try w.decimal(fee_attos);
    }
    for (calls) |call| {
        const value = try sbor.decode(call.args, .manifest);
        if (value.kind != 0x21) return error.RadixArgumentsMustBeTuple;
        try w.raw(&.{ 0x41, 3 });
        try w.address(call.component);
        try w.text(call.method);
        try w.raw(call.args[1..]);
    }
    return w.owned();
}
pub const Header = struct { network_id: u8, epoch: u64, discriminator: u64, notary_key: [32]u8, tip_basis_points: u32 = 0 };
pub const Prepared = struct {
    allocator: std.mem.Allocator,
    header: Header,
    manifest_instructions: []u8,
    intent: []u8,
    preview: []u8,
    signed_intent: []u8,
    intent_hash: [32]u8,
    signed_intent_hash: [32]u8,
    core_hash: [32]u8,
    notary_key: [32]u8,
    epoch: u64,
    end_epoch_exclusive: u64,
    pub fn deinit(self: *Prepared) void {
        self.allocator.free(self.manifest_instructions);
        self.allocator.free(self.intent);
        self.allocator.free(self.preview);
        self.allocator.free(self.signed_intent);
        self.* = undefined;
    }
};
fn tupleFromPayload(w: *sbor.Writer, payload: []const u8) !void { // encode inner transaction as tuple, not top-level discriminator
    try w.byte(0x21);
    try w.raw(payload[3..]);
}
pub fn prepare(allocator: std.mem.Allocator, header: Header, manifest_instructions: []const u8) !Prepared {
    const parsed = try sbor.decode(manifest_instructions, .manifest);
    if (parsed.kind != 0x20 or parsed.body.len < 2 or parsed.body[0] != 0x22) return error.InvalidRadixInstructions;
    const end_epoch = try std.math.add(u64, header.epoch, 2);
    _ = try std.crypto.sign.Ed25519.PublicKey.fromBytes(header.notary_key);
    var th: sbor.Writer = .{ .allocator = allocator };
    defer th.deinit();
    try th.tuple(3);
    try th.enumeration(1, 1);
    try th.bytes(&header.notary_key);
    try th.raw(&.{ 1, 1 });
    try th.uint(u32, header.tip_basis_points);
    var ih: sbor.Writer = .{ .allocator = allocator };
    defer ih.deinit();
    try ih.tuple(6);
    try ih.uint(u8, header.network_id);
    try ih.uint(u64, header.epoch);
    try ih.uint(u64, end_epoch);
    try ih.enumeration(0, 0);
    try ih.enumeration(0, 0);
    try ih.uint(u64, header.discriminator);
    var core: sbor.Writer = .{ .allocator = allocator };
    defer core.deinit();
    try core.tuple(5);
    try core.raw(ih.list.items);
    try core.raw(&.{ 0x20, 0x20, 0 }); // blobs
    try core.enumeration(0, 0); // no transaction message
    try core.raw(&.{ 0x20, 0x20, 0 }); // no child hashes
    try core.raw(manifest_instructions[1..]);
    const empty_hash = crypto.hash("");
    const core_hash = crypto.hashParts(&.{ &crypto.hash(ih.list.items[1..]), &empty_hash, &crypto.hash(&.{ 0, 0 }), &empty_hash, &crypto.hash(manifest_instructions[2..]) });
    var intent: sbor.Writer = .{ .allocator = allocator };
    defer intent.deinit();
    try intent.raw(&.{ 0x4d, 0x22, 9, 3 });
    try intent.raw(th.list.items);
    try intent.raw(core.list.items);
    try intent.raw(&.{ 0x20, 0x21, 0 });
    const intent_hash = crypto.hashParts(&.{ &.{ 0x54, 9 }, &crypto.hash(th.list.items[1..]), &core_hash, &empty_hash });
    var signed: sbor.Writer = .{ .allocator = allocator };
    defer signed.deinit();
    try signed.raw(&.{ 0x4d, 0x22, 10, 3 });
    try tupleFromPayload(&signed, intent.list.items);
    try signed.raw(&.{ 0x20, 0x22, 0, 0x20, 0x20, 0 });
    const signed_hash = crypto.hashParts(&.{ &.{ 0x54, 10 }, &intent_hash, &crypto.hash(&.{ 0x22, 0 }), &empty_hash });
    var preview: sbor.Writer = .{ .allocator = allocator };
    defer preview.deinit();
    try preview.raw(&.{ 0x4d, 0x22, 15, 3 });
    try tupleFromPayload(&preview, intent.list.items);
    try preview.raw(&.{ 0x20, 0x22, 0, 0x20, 0x20, 0 });
    const intent_bytes = try intent.owned();
    errdefer allocator.free(intent_bytes);
    const signed_bytes = try signed.owned();
    errdefer allocator.free(signed_bytes);
    const preview_bytes = try preview.owned();
    errdefer allocator.free(preview_bytes);
    return .{ .allocator = allocator, .header = header, .manifest_instructions = try allocator.dupe(u8, manifest_instructions), .intent = intent_bytes, .signed_intent = signed_bytes, .preview = preview_bytes, .intent_hash = intent_hash, .signed_intent_hash = signed_hash, .core_hash = core_hash, .notary_key = header.notary_key, .epoch = header.epoch, .end_epoch_exclusive = end_epoch };
}
pub const Signed = struct {
    allocator: std.mem.Allocator,
    raw: []u8,
    intent_hash: [32]u8,
    notarized_hash: [32]u8,
    pub fn deinit(self: *Signed) void {
        self.allocator.free(self.raw);
        self.* = undefined;
    }
};
pub fn notarize(allocator: std.mem.Allocator, prepared: Prepared, seed: [32]u8) !Signed {
    if (!std.mem.eql(u8, &prepared.notary_key, &try crypto.publicKey(seed))) return error.WrongRadixNotary;
    // Security boundary: signing commits to exactly the bytes and metadata
    // previously prepared. Recompute all SDK hash layers before using a key.
    var expected = try prepare(allocator, prepared.header, prepared.manifest_instructions);
    defer expected.deinit();
    if (!std.mem.eql(u8, prepared.intent, expected.intent) or
        !std.mem.eql(u8, prepared.preview, expected.preview) or
        !std.mem.eql(u8, prepared.signed_intent, expected.signed_intent) or
        !std.mem.eql(u8, &prepared.intent_hash, &expected.intent_hash) or
        !std.mem.eql(u8, &prepared.signed_intent_hash, &expected.signed_intent_hash) or
        !std.mem.eql(u8, &prepared.core_hash, &expected.core_hash) or
        !std.mem.eql(u8, &prepared.notary_key, &expected.notary_key) or
        prepared.epoch != expected.epoch or prepared.end_epoch_exclusive != expected.end_epoch_exclusive)
        return error.InvalidRadixPreparedTransaction;
    const signature = try crypto.sign(seed, prepared.signed_intent_hash);
    var w: sbor.Writer = .{ .allocator = allocator };
    defer w.deinit();
    try w.raw(&.{ 0x4d, 0x22, 12, 2 });
    try tupleFromPayload(&w, prepared.signed_intent);
    const signature_start = w.list.items.len;
    try w.enumeration(1, 1);
    try w.tuple(1);
    try w.bytes(&signature);
    const notary_hash = crypto.hash(w.list.items[signature_start + 1 ..]);
    return .{ .allocator = allocator, .raw = try w.owned(), .intent_hash = prepared.intent_hash, .notarized_hash = crypto.hashParts(&.{ &.{ 0x54, 12 }, &prepared.signed_intent_hash, &notary_hash }) };
}
