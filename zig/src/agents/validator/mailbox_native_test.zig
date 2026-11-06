const std = @import("std");
const Mailbox = @import("mailbox.zig").Mailbox;
const DatabaseOwner = @import("../origin_tasks.zig").DatabaseOwner;
const objects = @import("../../storage/objects.zig");
test "actual RocksDB mailbox retains first signature bounds pending slot and reopens completed goal" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const directory = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(directory);
    const path = try std.fs.path.join(a, &.{ directory, "public-db" });
    defer a.free(path);
    const owner = try DatabaseOwner.init(a, path);
    defer owner.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    var mailbox: Mailbox = .{ .allocator = a, .database = owner, .chain_name = "public-mailbox-fixture" };
    const value: objects.Announcement = .{ .validator = .{ 0x19, 0xe7, 0xe3, 0x76, 0xe7, 0xc2, 0x13, 0xb7, 0xe7, 0xe7, 0xe4, 0x6c, 0xc7, 0x0a, 0x5d, 0xd0, 0x86, 0xda, 0xff, 0x2a }, .mailbox_address = @splat(1), .mailbox_domain = 3999999999, .storage_location = "file:///tmp/public-fixture" };
    const first = try objects.SignedAnnouncement.sign(value, @splat(0x11), @splat(0));
    const duplicate = try objects.SignedAnnouncement.sign(value, @splat(0x11), @splat(1));
    _ = mailbox.pending.swap(false, .acq_rel);
    try mailbox.nativeAnnouncement(first, &cancel);
    try std.testing.expect(mailbox.pending.swap(false, .acq_rel));
    try mailbox.nativeAnnouncement(duplicate, &cancel);
    try std.testing.expect(!mailbox.pending.load(.acquire));
    {
        var request = (try mailbox.read(&cancel)).?;
        defer request.deinit();
        try std.testing.expectEqual(@as(u64, 0), request.wire.revision);
        try std.testing.expectEqualSlices(u8, &first.signature.bytes(), &request.signed.?.value.signature.bytes());
    }
    var different = value;
    different.storage_location = "file:///tmp/different-public-fixture";
    const next = try objects.SignedAnnouncement.sign(different, @splat(0x11), @splat(0));
    try std.testing.expectError(error.AnnouncementMailboxFull, mailbox.nativeAnnouncement(next, &cancel));
    try mailbox.completed(value.digest(), &cancel);
    try std.testing.expect(mailbox.pending.swap(false, .acq_rel));
    try mailbox.nativeAnnouncement(duplicate, &cancel);
    try std.testing.expect(mailbox.pending.swap(false, .acq_rel));
    try mailbox.nativeAnnouncement(duplicate, &cancel);
    try std.testing.expect(!mailbox.pending.load(.acquire));
    {
        var request = (try mailbox.read(&cancel)).?;
        defer request.deinit();
        try std.testing.expect(!request.wire.complete);
        try std.testing.expectEqual(@as(u64, 1), request.wire.revision);
        try std.testing.expectEqualSlices(u8, &first.signature.bytes(), &request.signed.?.value.signature.bytes());
    }
    try mailbox.completed(value.digest(), &cancel);
    try mailbox.nativeAnnouncement(next, &cancel);
    {
        var request = (try mailbox.read(&cancel)).?;
        defer request.deinit();
        try std.testing.expectEqual(@as(u64, 0), request.wire.revision);
        try std.testing.expectEqualSlices(u8, &different.digest(), &request.digest);
    }
}
