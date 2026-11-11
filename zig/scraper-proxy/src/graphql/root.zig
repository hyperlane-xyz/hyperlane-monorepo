//! graphql module root: GraphQL engine (lexer/parser/validator/executor) and
//! the `/graphql` route (mercurius + scraper-proxy semantics).
const std = @import("std");

pub const ast = @import("ast.zig");
pub const lexer = @import("lexer.zig");
pub const parser = @import("parser.zig");
pub const printer = @import("printer.zig");
pub const suggest = @import("suggest.zig");
pub const schema = @import("schema.zig");
pub const validate = @import("validate.zig");
pub const validation_rule = @import("validation_rule.zig");
pub const js = @import("js.zig");
pub const values = @import("values.zig");
pub const execute = @import("execute.zig");
pub const resolvers = @import("resolvers.zig");
pub const compat = @import("compat.zig");
pub const cache = @import("cache.zig");
pub const request_schema = @import("request_schema.zig");
pub const v8json = @import("v8json.zig");
pub const route = @import("route.zig");
pub const root_pool = @import("root_pool.zig");
pub const App = @import("app.zig").App;

pub const Schema = schema.Schema;
pub const GraphqlRoute = route.GraphqlRoute;
pub const RouteOptions = route.Options;
pub const ResolverMap = resolvers.ResolverMap;
pub const Diagnostics = resolvers.Diagnostics;
pub const ResolveFailure = execute.ResolveFailure;
pub const buildScraperSchema = schema.buildScraperSchema;
pub const max_request_bytes = route.max_request_bytes;

test {
    std.testing.refAllDecls(@This());
    _ = @import("fixtures_test.zig");
    _ = @import("module_test.zig");
    _ = @import("bench_test.zig");
    _ = @import("execute_golden_test.zig");
}
