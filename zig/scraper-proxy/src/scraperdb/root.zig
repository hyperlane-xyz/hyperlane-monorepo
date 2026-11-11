//! scraperdb: SQL builder, provisional-message SQL and the query service that
//! GraphQL resolvers call. See IMPLEMENTATION.md.
const std = @import("std");

pub const value = @import("value.zig");
pub const Value = value.Value;
pub const tables = @import("tables.zig");
pub const Table = tables.Table;
pub const sql = @import("sql.zig");
pub const Diag = sql.Diag;
pub const Sql = sql.Sql;
pub const Source = sql.Source;
pub const SelectArgs = sql.SelectArgs;
pub const CountArgs = sql.CountArgs;
pub const buildSelect = sql.buildSelect;
pub const buildCount = sql.buildCount;
pub const buildByPk = sql.buildByPk;
pub const provisional = @import("provisional_message.zig");
pub const scalars = @import("scalars.zig");
pub const service = @import("service.zig");
pub const resolvers = @import("resolvers.zig");
pub const Database = service.Database;
pub const Service = service.Service;
pub const MessageSelectArgs = service.MessageSelectArgs;

test {
    std.testing.refAllDeclsRecursive(@This());
    _ = @import("corpus_test.zig");
    _ = @import("spec_test.zig");
    _ = @import("pg_test.zig");
}
