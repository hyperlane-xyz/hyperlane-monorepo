const std = @import("std");

// Named modules with an explicit import graph. Import a teammate's module by
// name (`@import("core")`); use relative imports only inside your own directory.
// Each module has a `test-<name>` step; Zig analyses lazily, so a module's step
// compiles only what that module references.
const Mod = struct { name: []const u8, deps: []const []const u8 };
const modules = [_]Mod{
    .{ .name = "core", .deps = &.{} },
    .{ .name = "db", .deps = &.{"core"} },
    .{ .name = "http", .deps = &.{"core"} },
    .{ .name = "scraperdb", .deps = &.{ "core", "db" } },
    .{ .name = "diagnostics", .deps = &.{ "core", "db" } },
    .{ .name = "graphql", .deps = &.{ "core", "db", "http", "scraperdb", "diagnostics" } },
    .{ .name = "live", .deps = &.{ "core", "db", "http", "scraperdb", "diagnostics" } },
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // Build modes: the `scraper-proxy` exe (install/run) defaults to
    // ReleaseFast, test steps to Debug (safety checks). `-Drelease=true`
    // makes both ReleaseFast (bench scripts); `-Doptimize=<mode>` sets both.
    const explicit = b.option(std.builtin.OptimizeMode, "optimize", "Optimization mode for the exe and the tests");
    const release = b.option(bool, "release", "ReleaseFast for the exe and the tests") orelse false;
    const exe_optimize: std.builtin.OptimizeMode = explicit orelse .ReleaseFast;
    const test_optimize: std.builtin.OptimizeMode = explicit orelse if (release) .ReleaseFast else .Debug;
    const pg_lib_dir = b.option([]const u8, "pg-lib-dir", "libpq library directory");
    const pg_include_dir = b.option([]const u8, "pg-include-dir", "libpq include directory");
    const test_filter = b.option([]const u8, "test-filter", "Only run tests whose name contains this text");

    // One module graph per mode (a module has a single optimize mode).
    const exe_modules = moduleGraph(b, target, exe_optimize, pg_lib_dir, pg_include_dir, true);
    const test_modules = if (test_optimize == exe_optimize) exe_modules else moduleGraph(b, target, test_optimize, pg_lib_dir, pg_include_dir, false);

    const exe = b.addExecutable(.{ .name = "scraper-proxy", .root_module = mainModule(b, target, exe_optimize, pg_lib_dir, pg_include_dir, exe_modules) });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the native scraper proxy").dependOn(&run.step);

    const test_all = b.step("test", "Run every module test step");
    inline for (modules, 0..) |entry, i| {
        const tests = b.addTest(.{
            .root_module = test_modules[i],
            .filters = if (test_filter) |f| &.{f} else &.{},
        });
        const run_tests = b.addRunArtifact(tests);
        // DB-backed tests read SCRAPER_PROXY_TEST_DATABASE_URL: always re-run.
        run_tests.has_side_effects = true;
        const step = b.step("test-" ++ entry.name, "Run " ++ entry.name ++ " tests");
        step.dependOn(&run_tests.step);
        test_all.dependOn(step);
    }
    const main_tests = b.addTest(.{ .root_module = mainModule(b, target, test_optimize, pg_lib_dir, pg_include_dir, test_modules) });
    b.step("test-main", "Run main.zig tests").dependOn(&b.addRunArtifact(main_tests).step);
}

fn moduleGraph(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    pg_lib_dir: ?[]const u8,
    pg_include_dir: ?[]const u8,
    exported: bool,
) [modules.len]*std.Build.Module {
    var created: [modules.len]*std.Build.Module = undefined;
    inline for (modules, 0..) |entry, i| {
        const options: std.Build.Module.CreateOptions = .{
            .root_source_file = b.path("src/" ++ entry.name ++ "/root.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        };
        const module = if (exported) b.addModule(entry.name, options) else b.createModule(options);
        linkPq(module, pg_lib_dir, pg_include_dir);
        inline for (entry.deps) |dep| module.addImport(dep, created[indexOf(dep)]);
        created[i] = module;
    }
    return created;
}

fn mainModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    pg_lib_dir: ?[]const u8,
    pg_include_dir: ?[]const u8,
    graph: [modules.len]*std.Build.Module,
) *std.Build.Module {
    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    linkPq(root, pg_lib_dir, pg_include_dir);
    inline for (modules, 0..) |entry, i| root.addImport(entry.name, graph[i]);
    return root;
}

fn indexOf(comptime name: []const u8) usize {
    inline for (modules, 0..) |entry, i| {
        if (comptime std.mem.eql(u8, entry.name, name)) return i;
    }
    @compileError("unknown module " ++ name);
}

fn linkPq(module: *std.Build.Module, lib_dir: ?[]const u8, include_dir: ?[]const u8) void {
    if (lib_dir) |dir| module.addLibraryPath(.{ .cwd_relative = dir });
    if (include_dir) |dir| module.addIncludePath(.{ .cwd_relative = dir });
    module.linkSystemLibrary("pq", .{});
}
