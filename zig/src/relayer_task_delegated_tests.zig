const std = @import("std");
const tasks = @import("agents/relayer_task.zig");
test "operational relayer task declarations" {
    std.testing.refAllDecls(tasks);
    std.testing.refAllDecls(tasks.Lane);
}
