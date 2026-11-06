test {
    _ = @import("agents/scraper/native_test.zig");
    _ = @import("db/postgres_test.zig");
    _ = @import("db/scraper_schema_test.zig");
}

test {
    _ = @import("critical_metrics_tests.zig");
    // Concrete scraper owners include PostgreSQL pool teardown.
    _ = @import("agents/scraper/task.zig");
}
