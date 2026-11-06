const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const git_sha = buildGitSha(b);
    const native_cpp = b.option([]const u8, "native-cxx-library", "Linux GNU libstdc++ shared library; zig.py discovers the native compiler path");
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "Optimization mode (default ReleaseSafe)") orelse .ReleaseSafe;
    const module = b.addModule("agents", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const exe = b.addExecutable(.{ .name = "hyperlane-zig", .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "agents", .module = module }},
    }) });
    b.installArtifact(exe);
    const protocol = b.createModule(.{
        .root_source_file = b.path("src/protocol/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const bench = b.addExecutable(.{ .name = "zig-agent-bench", .root_module = b.createModule(.{
        .root_source_file = b.path("bench/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "protocol", .module = protocol }},
    }) });
    b.installArtifact(bench);
    b.step("benchmark-driver", "Build only the protocol benchmark/reference driver").dependOn(&b.addInstallArtifact(bench, .{}).step);
    const tests = b.addTest(.{ .root_module = module });
    const test_step = b.step("test", "Run protocol, agent state-machine, and deterministic simulation tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the agents CLI").dependOn(&run.step);
    const integration = b.addExecutable(.{ .name = "zig-evm-integration", .root_module = b.createModule(.{
        .root_source_file = b.path("src/evm_integration.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "agents", .module = module }},
    }) });
    b.step("integration-driver", "Build the loopback-only EVM integration fixture").dependOn(&b.addInstallArtifact(integration, .{}).step);
    const aleo_worker = b.addExecutable(.{ .name = "hyperlane-aleo-vm-worker", .root_module = b.createModule(.{
        .root_source_file = b.path("src/aleo_vm_worker.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    }) });
    b.step("aleo-vm-worker", "Build the isolated bounded Aleo proof worker").dependOn(&b.addInstallArtifact(aleo_worker, .{}).step);
    if (b.option([]const u8, "native-db-libs", "Comma-separated full paths to production RocksDB and compression archives")) |libraries| {
        inline for (.{ "validator", "relayer" }) |role| {
            const service_options = b.addOptions();
            service_options.addOption([]const u8, "role", role);
            service_options.addOption([]const u8, "git_sha", git_sha);
            const validator_module = b.createModule(.{
                .root_source_file = b.path("src/service_main.zig"),
                .target = target,
                .optimize = optimize,
                .link_libc = true,
            });
            validator_module.addOptions("service_options", service_options);
            linkNativeCpp(validator_module, target.result, native_cpp);
            var service_paths = std.mem.splitScalar(u8, libraries, ',');
            while (service_paths.next()) |path| validator_module.addObjectFile(.{ .cwd_relative = path });
            const validator = b.addExecutable(.{ .name = role, .root_module = validator_module });
            b.step(role, "Build the native operational " ++ role).dependOn(&b.addInstallArtifact(validator, .{}).step);
        }
        const native_module = b.createModule(.{
            .root_source_file = b.path("src/db_tests.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        linkNativeCpp(native_module, target.result, native_cpp);
        var paths = std.mem.splitScalar(u8, libraries, ',');
        while (paths.next()) |path| native_module.addObjectFile(.{ .cwd_relative = path });
        const native_tests = b.addTest(.{ .root_module = native_module });
        b.step("native-db-test", "Verify real production RocksDB compatibility").dependOn(&b.addRunArtifact(native_tests).step);
    }
    if (b.option([]const u8, "libpq-library", "Full path to libpq for isolated PostgreSQL integration tests")) |library| {
        const service_options = b.addOptions();
        service_options.addOption([]const u8, "role", "scraper");
        service_options.addOption([]const u8, "git_sha", git_sha);
        const scraper_module = b.createModule(.{
            .root_source_file = b.path("src/service_main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        scraper_module.addOptions("service_options", service_options);
        scraper_module.addObjectFile(.{ .cwd_relative = library });
        const scraper = b.addExecutable(.{ .name = "scraper", .root_module = scraper_module });
        b.step("scraper", "Build the native operational scraper").dependOn(&b.addInstallArtifact(scraper, .{}).step);
        const pg_module = b.createModule(.{
            .root_source_file = b.path("src/pg_tests.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        pg_module.addObjectFile(.{ .cwd_relative = library });
        const pg_tests = b.addTest(.{ .root_module = pg_module });
        b.step("native-pg-test", "Verify PostgreSQL integration against a disposable fixture").dependOn(&b.addRunArtifact(pg_tests).step);
    }
}

fn linkNativeCpp(module: *std.Build.Module, target: std.Target, native_cpp: ?[]const u8) void {
    if (target.os.tag == .macos) {
        module.link_libcpp = true;
    } else if (target.os.tag == .linux) {
        // Match librocksdb-sys' platform C++ ABI instead of mixing libc++ with
        // production archives built against GNU libstdc++.
        // Zig treats both c++ and stdc++ library names as its bundled libc++.
        // Add the actual GNU object instead of that special library-name path.
        const library_path = native_cpp orelse @panic("Linux RocksDB needs -Dnative-cxx-library=<GNU libstdc++.so>; use tools/zig.py for native discovery");
        module.link_libcpp = false;
        module.addObjectFile(.{ .cwd_relative = library_path });
        for ([_][]const u8{ "pthread", "dl", "m" }) |library|
            module.linkSystemLibrary(library, .{ .use_pkg_config = .no });
    } else {
        module.link_libcpp = true;
    }
}

fn buildGitSha(b: *std.Build) []const u8 {
    const unknown = "VERGEN_IDEMPOTENT_OUTPUT";
    const configured = b.option([]const u8, "git-sha", "Compiled agent source commit; use the actual frozen commit for Git-less packaging");
    const value = configured orelse blk: {
        var code: u8 = 0;
        const output = b.runAllowFail(&.{ "git", "-C", b.build_root.path orelse ".", "rev-parse", "HEAD" }, &code, .Ignore) catch break :blk unknown;
        break :blk std.mem.trim(u8, output, " \r\n\t");
    };
    if (!std.mem.eql(u8, value, unknown)) {
        if (value.len != 40) @panic("git-sha must be the exact 40-character hexadecimal commit or VERGEN_IDEMPOTENT_OUTPUT");
        for (value) |c| if (!std.ascii.isHex(c)) @panic("git-sha must be hexadecimal");
    }
    return value;
}
