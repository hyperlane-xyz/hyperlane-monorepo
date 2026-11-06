const task = @import("agents/validator_task.zig");
test "operational validator jobs are concrete" {
    @import("std").testing.refAllDeclsRecursive(task);
}
