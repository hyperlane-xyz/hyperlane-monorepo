const std = @import("std");
const ism = @import("ism.zig");
const ix = @import("instructions.zig");
const sol = @import("../altvm/solana.zig");
const svm = @import("provider.zig");
const Mailbox = @import("mailbox.zig").Mailbox;
const protocol = @import("../protocol/root.zig");
const rpc = @import("../evm/provider.zig");
const base58 = @import("../altvm/base58.zig");
const A = std.mem.Allocator;
const Key = sol.Key;
fn unhex(a: A, text: []const u8) ![]u8 {
    const out = try a.alloc(u8, text.len / 2);
    errdefer a.free(out);
    _ = try std.fmt.hexToBytes(out, text);
    return out;
}
const Case = struct { data: []const u8, metas: []const sol.AccountMeta, returned: ?[]const u8, failed: bool = false };
const Fixture = struct {
    cases: []const Case,
    next: usize = 0,
    payer: Key = .{3} ** 32,
    program: Key = .{9} ** 32,
    fn exchange(context: *anyopaque, a: A, body: []const u8, _: rpc.Options) anyerror!rpc.WireResponse {
        const self: *Fixture = @ptrCast(@alignCast(context));
        if (self.next >= self.cases.len) return error.UnexpectedSimulation;
        const case = self.cases[self.next];
        self.next += 1;
        const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("simulateTransaction", (try svm.field(parsed.value, "method")).string);
        const params = (try svm.field(parsed.value, "params")).array.items;
        const raw = params[0].string;
        const wire = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(raw));
        defer a.free(wire);
        try std.base64.standard.Decoder.decode(wire, raw);
        var buffer: [1232]u8 = undefined;
        const expected = try sol.compileLegacy(self.payer, .{0} ** 32, &.{.{ .program = self.program, .accounts = case.metas, .data = case.data }}, &buffer);
        var offset: usize = 0;
        const count = try sol.readShortvec(wire, &offset);
        offset += count * 64;
        try std.testing.expectEqualSlices(u8, expected.bytes, wire[offset..]);
        const program = try base58.encode(a, &self.program);
        defer a.free(program);
        const returned = try a.alloc(u8, std.base64.standard.Encoder.calcSize(if (case.returned) |bytes| bytes.len else 0));
        defer a.free(returned);
        if (case.returned) |bytes| _ = std.base64.standard.Encoder.encode(returned, bytes);
        const Ret = struct { programId: []const u8, data: struct { []const u8, []const u8 } };
        const response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = (try svm.field(parsed.value, "id")).integer, .result = .{ .context = .{ .slot = 20 }, .value = .{ .err = if (case.failed) @as(?u8, 1) else null, .unitsConsumed = 1000, .returnData = if (case.returned != null) @as(?Ret, .{ .programId = program, .data = .{ returned, "base64" } }) else null } } }, .{});
        return .{ .bytes = response, .len = response.len };
    }
};
const Oracle = struct { message: []const u8, getter_ix: []const u8, validators_ix: []const u8, validators: []const u8, metas: []const u8, spec_ix: []const u8, spec: []const u8, again: []const u8, domain: []const u8, domain_bump: u8 };
test "SVM HTTP production ISM getter bytes account fixpoint and missing Type return semantics" {
    const a = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Oracle, a, @embedFile("../altvm/fixtures/svm-ism.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const f = parsed.value;
    const raw_message = try unhex(a, f.message);
    defer a.free(raw_message);
    const message = try protocol.Message.decode(raw_message);
    const getter = try unhex(a, f.getter_ix);
    defer a.free(getter);
    const validators_ix = try unhex(a, f.validators_ix);
    defer a.free(validators_ix);
    const validators = try unhex(a, f.validators);
    defer a.free(validators);
    const metas = try unhex(a, f.metas);
    defer a.free(metas);
    const spec_ix = try unhex(a, f.spec_ix);
    defer a.free(spec_ix);
    const spec = try unhex(a, f.spec);
    defer a.free(spec);
    const again = try unhex(a, f.again);
    defer a.free(again);
    const domain = try unhex(a, f.domain);
    defer a.free(domain);
    const program: Key = .{9} ** 32;
    const domain_pda = try ism.domainPda(program, 1000);
    try std.testing.expectEqualSlices(u8, domain, &domain_pda.key);
    try std.testing.expectEqual(f.domain_bump, domain_pda.bump);
    const vam = (try ix.verifyAccountsPda(program)).key;
    const getter_pda = (try ism.validatorsAccountsPda(program)).key;
    const domain_meta = sol.AccountMeta{ .key = domain_pda.key };
    var payer_metas: [39]u8 = .{0} ** 39;
    std.mem.writeInt(u32, payer_metas[0..4], 1, .little);
    payer_metas[4..36].* = .{3} ** 32;
    payer_metas[36] = 1;
    payer_metas[38] = 255;
    var fixture: Fixture = .{ .cases = &.{
        .{ .data = &ix.type_discriminator, .metas = &.{.{ .key = vam }}, .returned = null, .failed = true },
        .{ .data = &ix.type_discriminator, .metas = &.{}, .returned = &.{ 13, 0, 0, 0, 255 } },
        .{ .data = getter, .metas = &.{.{ .key = getter_pda }}, .returned = metas },
        .{ .data = validators_ix, .metas = &.{domain_meta}, .returned = validators },
        .{ .data = spec_ix, .metas = &.{ .{ .key = vam }, domain_meta }, .returned = again },
        .{ .data = spec_ix, .metas = &.{ .{ .key = vam }, domain_meta }, .returned = spec },
        .{ .data = &ix.type_discriminator, .metas = &.{.{ .key = vam }}, .returned = null },
        .{ .data = getter, .metas = &.{.{ .key = getter_pda }}, .returned = &payer_metas },
        .{ .data = validators_ix, .metas = &.{.{ .key = .{3} ** 32, .is_signer = true }}, .returned = validators },
    } };
    var server = try @import("test_rpc.zig").Server.init(.{ .context = &fixture, .fetch_fn = Fixture.exchange }, fixture.cases.len);
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var provider = try svm.Client.init(a, url, .{});
    defer provider.deinit();
    const thread = try std.Thread.spawn(.{}, @import("test_rpc.zig").Server.serve, .{&server});
    var joined = false;
    defer if (!joined) thread.join();
    var mailbox: Mailbox = .{ .client = &provider, .program = .{1} ** 32, .domain = 2000, .payer = fixture.payer };
    const client: ism.Client = .{ .mailbox = &mailbox };
    try std.testing.expectEqual(@as(u32, 13), try client.moduleType(program));
    var set = try client.validatorsAndThreshold(a, program, message);
    defer set.deinit();
    try std.testing.expectEqual(@as(usize, 2), set.addresses.len);
    try std.testing.expectEqual(@as(u8, 1), set.threshold);
    var result = try client.metadataSpec(a, program, message);
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 4), result.spec.?.aggregation.children.len);
    try std.testing.expectError(error.MissingIsmReturnData, client.moduleType(program));
    var payer_set = try client.validatorsAndThreshold(a, program, message);
    defer payer_set.deinit();
    try std.testing.expectEqual(@as(usize, 2), payer_set.addresses.len);
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
    try std.testing.expectEqual(fixture.cases.len, fixture.next);
}
test "SVM HTTP metadata spec bounded nonconvergence" {
    const a = std.testing.allocator;
    const program: Key = .{9} ** 32;
    const message: protocol.Message = .{ .origin = 1000, .destination = 2000 };
    const encoded = try message.encodeAlloc(a);
    defer a.free(encoded);
    var data: [1232]u8 = undefined;
    const used = try ix.metadataSpecData(encoded, &data);
    const vam = (try ix.verifyAccountsPda(program)).key;
    const domain = (try ism.domainPda(program, 1000)).key;
    var returned: [70]u8 = undefined;
    returned[0] = 0;
    std.mem.writeInt(u32, returned[1..5], 2, .little);
    returned[5..37].* = vam;
    returned[37..69].* = domain;
    returned[69] = 255;
    const case: Case = .{ .data = used, .metas = &.{ .{ .key = vam }, .{ .key = domain } }, .returned = &returned };
    var fixture: Fixture = .{ .cases = &(.{case} ** 10) };
    var server = try @import("test_rpc.zig").Server.init(.{ .context = &fixture, .fetch_fn = Fixture.exchange }, fixture.cases.len);
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var provider = try svm.Client.init(a, url, .{});
    defer provider.deinit();
    const thread = try std.Thread.spawn(.{}, @import("test_rpc.zig").Server.serve, .{&server});
    var joined = false;
    defer if (!joined) thread.join();
    var mailbox: Mailbox = .{ .client = &provider, .program = .{1} ** 32, .domain = 2000, .payer = fixture.payer };
    try std.testing.expectError(error.MetadataSpecDidNotConverge, (ism.Client{ .mailbox = &mailbox }).metadataSpec(a, program, message));
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 10), fixture.next);
}
