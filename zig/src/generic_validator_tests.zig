const generic = @import("agents/validator/generic.zig");
comptime {
    _ = generic.Role.open;
    _ = generic.Role.tick;
    _ = generic.Role.deinit;
}
test "generic validator operational API is concrete" {
    @import("std").testing.refAllDeclsRecursive(generic);
}
