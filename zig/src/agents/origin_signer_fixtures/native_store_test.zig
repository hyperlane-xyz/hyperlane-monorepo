const std = @import("std");
const origin = @import("../origin_signer_source.zig");
const support = @import("support.zig");
const native_store = @import("../store.zig");
const db = @import("../../db/root.zig");
const protocol = @import("../../protocol/root.zig");

// The bundled bzip2 archive references but does not contain this abort-only
// internal error handler. Supply the same failure behavior for the test link.
export fn bz_internal_error(_: c_int) callconv(.c) void {
    @panic("bzip2 internal error");
}

test "production Source.init uses canonical native Store provenance through UTC HTTP lookup" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "origin-signers" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{ .sync = true });
    defer database.deinit();
    var store = native_store.Store.init(a, &database, "ethereum");
    const value: protocol.Message = .{ .nonce = 70, .origin = 1000, .destination = 2000, .sender = .{0x11} ** 32, .recipient = .{0x22} ** 32, .body = "canonical" };
    const hash = support.nativeHash(.{0x44} ** 32);
    try std.testing.expect(try store.storeMessage(value, 7, hash));

    var steps = [_]support.Step{.{ .method = "eth_getTransactionByHash", .result = "null" }};
    var rpc = try support.Rpc.init(&steps);
    defer rpc.deinit();
    const url = try rpc.url(a);
    defer a.free(url);
    const urls = [_][]const u8{url};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const owner = try support.openResources(a, .ethereum, &urls, &env);
    defer owner.deinit();
    var source = origin.Source.init(owner, &store);
    try rpc.start();
    const signers = try source.interface().fetch(a, value, try support.deadline(), null);
    defer a.free(signers);
    try std.testing.expectEqual(@as(usize, 0), signers.len);

    var stale = value;
    stale.body = "not-canonical";
    try std.testing.expectError(error.StaleCanonicalMessage, source.interface().fetch(a, stale, try support.deadline(), null));
}
