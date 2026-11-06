const std = @import("std");
const public_relay = @import("public_relay.zig");

test "public relay declarations" {
    _ = public_relay.PublicRelay;
    _ = public_relay.PublicRelay.submissionOwner;
}

test "receipt extraction releases every allocation on every failure" {
    try public_relay.testing.checkReceiptAllocationFailures();
}

test "public admission pending allocation transfers domains exactly once" {
    try @import("public_relay.zig").testing.checkPendingAllocationFailures();
}
