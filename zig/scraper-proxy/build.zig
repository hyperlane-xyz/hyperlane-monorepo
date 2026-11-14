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
    // Diagnostics only (bench): per-pool checkout hold-time histogram, logged
    // at info. Off by default: the shipped build does no extra work.
    const pool_hold_stats = b.option(bool, "pool-hold-stats", "Record and log DB pool checkout hold times") orelse false;
    const db_options = b.addOptions();
    db_options.addOption(bool, "pool_hold_stats", pool_hold_stats);
    // Fiber-mode event loops (one pinned thread each); the default until the
    // 1-vs-N measurement decides. Not a runtime knob (TS env surface).
    const http_loops = b.option(u32, "http-loops", "HTTP event loops in fiber mode (0: one per CPU; default 1)") orelse 1;
    const http_options = b.addOptions();
    http_options.addOption(u32, "loops", http_loops);
    // Diagnostics only (bench): event-loop counters logged at close (debug
    // level). Off by default: the shipped build logs nothing TS does not.
    const loop_stats = b.option(bool, "loop-stats", "Log HTTP event-loop counters at close") orelse false;
    http_options.addOption(bool, "loop_stats", loop_stats);
    // Diagnostics only (bench): live loop mutex hold-time histograms and
    // replay prefetch outcomes, logged at info. Off by default.
    const loop_hold_stats = b.option(bool, "loop-hold-stats", "Record and log live loop mutex hold times and replay prefetch outcomes") orelse false;
    const live_options = b.addOptions();
    live_options.addOption(bool, "loop_hold_stats", loop_hold_stats);

    // core/fiber.zig defines its context switch in global assembly, which
    // Zig 0.15's self-hosted x86_64 backend (the Debug default there) drops,
    // so the link fails. LLVM emits it (ReleaseFast already uses LLVM).
    const use_llvm: ?bool = if (target.result.cpu.arch == .x86_64) true else null;

    // One module graph per mode (a module has a single optimize mode).
    const exe_modules = moduleGraph(b, target, exe_optimize, pg_lib_dir, pg_include_dir, db_options, http_options, live_options, true);
    const test_modules = if (test_optimize == exe_optimize) exe_modules else moduleGraph(b, target, test_optimize, pg_lib_dir, pg_include_dir, db_options, http_options, live_options, false);

    const exe = b.addExecutable(.{ .name = "scraper-proxy", .root_module = mainModule(b, target, exe_optimize, pg_lib_dir, pg_include_dir, exe_modules), .use_llvm = use_llvm });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the native scraper proxy").dependOn(&run.step);

    const test_all = b.step("test", "Run every module test step");
    inline for (modules, 0..) |entry, i| {
        const tests = b.addTest(.{
            .root_module = test_modules[i],
            .filters = if (test_filter) |f| &.{f} else &.{},
            .use_llvm = use_llvm,
        });
        const run_tests = b.addRunArtifact(tests);
        // DB-backed tests read SCRAPER_PROXY_TEST_DATABASE_URL: always re-run.
        run_tests.has_side_effects = true;
        const step = b.step("test-" ++ entry.name, "Run " ++ entry.name ++ " tests");
        step.dependOn(&run_tests.step);
        test_all.dependOn(step);
    }
    const main_tests = b.addTest(.{ .root_module = mainModule(b, target, test_optimize, pg_lib_dir, pg_include_dir, test_modules), .use_llvm = use_llvm });
    b.step("test-main", "Run main.zig tests").dependOn(&b.addRunArtifact(main_tests).step);
}

fn moduleGraph(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    pg_lib_dir: ?[]const u8,
    pg_include_dir: ?[]const u8,
    db_options: *std.Build.Step.Options,
    http_options: *std.Build.Step.Options,
    live_options: *std.Build.Step.Options,
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
        if (comptime std.mem.eql(u8, entry.name, "db")) module.addOptions("db_options", db_options);
        if (comptime std.mem.eql(u8, entry.name, "http")) module.addOptions("http_options", http_options);
        if (comptime std.mem.eql(u8, entry.name, "live")) module.addOptions("live_options", live_options);
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
