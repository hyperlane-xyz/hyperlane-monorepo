//! How many event loops `-Dhttp-loops=0` ("auto") runs: the CPUs this
//! process may use, i.e. its affinity mask capped by its cgroup CPU quota
//! (rounded down, at least 1), clamped to 1..`auto_max`. A quota of 1.5 CPUs
//! gives 1 loop: two loops sharing one CPU's worth of quota lose throughput
//! and double their tail latency. The quota is the smallest along the
//! process's cgroup and its ancestors (v2 `cpu.max`, else v1 CFS files). No
//! readable quota (none set, files missing, not Linux): the affinity count.

const std = @import("std");
const builtin = @import("builtin");
const linux = std.os.linux;

/// Most loops "auto" picks (more was not measured to help).
pub const auto_max: u32 = 4;

/// Loops for `-Dhttp-loops=0`.
pub fn autoLoops() u32 {
    const cpus = effectiveCpus();
    const quota = if (builtin.os.tag == .linux) cgroupQuotaCpus() else null;
    return std.math.clamp(@min(cpus, quota orelse cpus), 1, auto_max);
}

/// CPUs this process may run on (its affinity mask; 1 if unknown). Use it
/// instead of `std.Thread.getCpuCount`, whose fixed 1024-CPU mask makes the
/// kernel answer EINVAL on larger hosts, which std treats as unreachable.
pub fn effectiveCpus() u32 {
    if (builtin.os.tag != .linux) return @intCast(std.math.clamp(std.Thread.getCpuCount() catch 1, 1, 1 << 16));
    return affinityCount() orelse 1;
}

/// CPUs in this thread's affinity mask, asking with a mask that grows on
/// EINVAL (the kernel's is larger) up to 131072 CPUs; null if the call fails.
fn affinityCount() ?u32 {
    var mask = [_]usize{0} ** (131072 / @bitSizeOf(usize));
    var len: usize = 128; // bytes: 1024 CPUs
    while (true) : (len *= 2) {
        const rc = linux.syscall3(.sched_getaffinity, 0, len, @intFromPtr(&mask));
        switch (linux.E.init(rc)) {
            .SUCCESS => {
                // The kernel wrote `rc` bytes.
                var n: u32 = 0;
                for (mask[0 .. rc / @sizeOf(usize)]) |word| n += @popCount(word);
                return if (n == 0) null else n;
            },
            .INVAL => if (len * 2 > @sizeOf(@TypeOf(mask))) return null,
            else => return null,
        }
    }
}

/// Whole CPUs of the smallest CPU quota on this process's cgroup path (v2,
/// else v1); null: no quota anywhere, or nothing readable.
fn cgroupQuotaCpus() ?u32 {
    var buf: [4096]u8 = undefined;
    const self_cgroup = readFile("/proc/self/cgroup", &buf);
    var rel_buf: [std.fs.max_path_bytes]u8 = undefined;
    // v2 (unified), also mounted at /sys/fs/cgroup/unified on hybrid hosts.
    if (self_cgroup) |text| if (v2Path(text)) |rel| if (copy(&rel_buf, rel)) |r| {
        for ([_][]const u8{ "/sys/fs/cgroup", "/sys/fs/cgroup/unified" }) |mount| {
            if (minQuota(mount, r, .v2)) |q| return q;
        }
    };
    // A container with its own cgroup namespace sees itself at the root.
    if (minQuota("/sys/fs/cgroup", "/", .v2)) |q| return q;
    // v1: the cpu controller's hierarchy, under whichever name it's mounted.
    const rel_v1 = if (self_cgroup) |text| (if (v1CpuPath(text)) |rel| copy(&rel_buf, rel) else null) else null;
    for ([_][]const u8{ "/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup/cpuacct,cpu" }) |mount| {
        if (rel_v1) |rel| if (minQuota(mount, rel, .v1)) |q| return q;
        if (minQuota(mount, "/", .v1)) |q| return q;
    }
    return null;
}

fn copy(buf: []u8, s: []const u8) ?[]const u8 {
    if (s.len > buf.len) return null;
    @memcpy(buf[0..s.len], s);
    return buf[0..s.len];
}

/// The smallest quota from `mount ++ rel` up to `mount` (each directory's
/// files; a missing one is skipped); null when none sets one.
fn minQuota(mount: []const u8, rel: []const u8, comptime version: enum { v1, v2 }) ?u32 {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    var buf: [128]u8 = undefined;
    var period_buf: [64]u8 = undefined;
    var best: ?u32 = null;
    var dir = std.mem.trimRight(u8, rel, "/");
    while (true) {
        const q: ?u32 = switch (version) {
            .v2 => blk: {
                const p = std.fmt.bufPrint(&path_buf, "{s}{s}/cpu.max", .{ mount, dir }) catch break :blk null;
                break :blk if (readFile(p, &buf)) |text| parseCpuMax(text) else null;
            },
            .v1 => blk: {
                const qp = std.fmt.bufPrint(&path_buf, "{s}{s}/cpu.cfs_quota_us", .{ mount, dir }) catch break :blk null;
                const quota = readFile(qp, &buf) orelse break :blk null;
                const pp = std.fmt.bufPrint(&path_buf, "{s}{s}/cpu.cfs_period_us", .{ mount, dir }) catch break :blk null;
                const period = readFile(pp, &period_buf) orelse break :blk null;
                break :blk parseCfs(quota, period);
            },
        };
        if (q) |v| best = if (best) |b| @min(b, v) else v;
        if (dir.len == 0) break;
        dir = dir[0 .. std.mem.lastIndexOfScalar(u8, dir, '/') orelse 0];
    }
    return best;
}

/// The file's contents; null if unreadable or if it filled `buf` (possibly
/// truncated: treated as unknown).
fn readFile(path: []const u8, buf: []u8) ?[]const u8 {
    const file = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file.close();
    const n = file.readAll(buf) catch return null;
    if (n == buf.len) return null;
    return buf[0..n];
}

/// The cgroup v2 path in /proc/self/cgroup ("0::/kubepods/..."); null on a
/// v1-only host.
fn v2Path(text: []const u8) ?[]const u8 {
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "0::")) return checkedPath(line[3..]);
    }
    return null;
}

/// The v1 cpu controller's path in /proc/self/cgroup ("4:cpu,cpuacct:/x").
fn v1CpuPath(text: []const u8) ?[]const u8 {
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        var parts = std.mem.splitScalar(u8, line, ':');
        _ = parts.next() orelse continue;
        const controllers = parts.next() orelse continue;
        const rel = parts.rest();
        var it = std.mem.splitScalar(u8, controllers, ',');
        while (it.next()) |c| if (std.mem.eql(u8, c, "cpu")) return checkedPath(rel);
    }
    return null;
}

fn checkedPath(raw: []const u8) ?[]const u8 {
    const rel = std.mem.trim(u8, raw, " \r");
    if (rel.len == 0 or rel[0] != '/' or std.mem.indexOf(u8, rel, "..") != null) return null;
    return rel;
}

/// cgroup v2 `cpu.max`: "<quota> <period>" or "max <period>".
fn parseCpuMax(text: []const u8) ?u32 {
    var it = std.mem.tokenizeAny(u8, text, " \t\r\n");
    const quota = it.next() orelse return null;
    const period = it.next() orelse return null;
    if (std.mem.eql(u8, quota, "max")) return null;
    return wholeCpus(quota, period);
}

/// cgroup v1 `cpu.cfs_quota_us` (-1: none) and `cpu.cfs_period_us`.
fn parseCfs(quota_text: []const u8, period_text: []const u8) ?u32 {
    const quota = std.mem.trim(u8, quota_text, " \t\r\n");
    if (std.mem.startsWith(u8, quota, "-")) return null;
    return wholeCpus(quota, std.mem.trim(u8, period_text, " \t\r\n"));
}

fn wholeCpus(quota_text: []const u8, period_text: []const u8) ?u32 {
    const quota = std.fmt.parseInt(u64, quota_text, 10) catch return null;
    const period = std.fmt.parseInt(u64, period_text, 10) catch return null;
    if (quota == 0 or period == 0) return null;
    return @intCast(std.math.clamp(quota / period, 1, 1 << 16));
}

const testing = std.testing;

test "cpu.max: no quota, whole and fractional quotas, malformed" {
    try testing.expectEqual(@as(?u32, null), parseCpuMax("max 100000\n"));
    try testing.expectEqual(@as(?u32, 2), parseCpuMax("200000 100000\n"));
    try testing.expectEqual(@as(?u32, 1), parseCpuMax("150000 100000\n")); // 1.5 rounds down
    try testing.expectEqual(@as(?u32, 1), parseCpuMax("50000 100000\n")); // half a CPU: at least 1
    try testing.expectEqual(@as(?u32, 64), parseCpuMax("6400000 100000"));
    try testing.expectEqual(@as(?u32, null), parseCpuMax(""));
    try testing.expectEqual(@as(?u32, null), parseCpuMax("200000"));
    try testing.expectEqual(@as(?u32, null), parseCpuMax("abc 100000"));
    try testing.expectEqual(@as(?u32, null), parseCpuMax("0 100000"));
}

test "v1 cfs: -1 means none; quota over period rounds down" {
    try testing.expectEqual(@as(?u32, null), parseCfs("-1\n", "100000\n"));
    try testing.expectEqual(@as(?u32, 2), parseCfs("200000\n", "100000\n"));
    try testing.expectEqual(@as(?u32, 1), parseCfs("150000\n", "100000\n"));
    try testing.expectEqual(@as(?u32, 1), parseCfs("10000\n", "100000\n"));
    try testing.expectEqual(@as(?u32, null), parseCfs("200000\n", "0\n"));
    try testing.expectEqual(@as(?u32, null), parseCfs("", "100000"));
}

test "/proc/self/cgroup: the v2 path and the v1 cpu controller's path" {
    try testing.expectEqualStrings("/kubepods/burstable/pod1/abc", v2Path("0::/kubepods/burstable/pod1/abc\n").?);
    try testing.expectEqualStrings("/", v2Path("0::/\n").?);
    try testing.expectEqualStrings("/user.slice", v2Path("12:cpu,cpuacct:/docker/x\n0::/user.slice\n").?);
    try testing.expectEqual(@as(?[]const u8, null), v2Path("12:cpu,cpuacct:/docker/x\n11:memory:/docker/x\n"));
    try testing.expectEqual(@as(?[]const u8, null), v2Path(""));
    try testing.expectEqual(@as(?[]const u8, null), v2Path("0::/../etc\n"));
    try testing.expectEqualStrings("/docker/x", v1CpuPath("11:memory:/m\n4:cpu,cpuacct:/docker/x\n0::/\n").?);
    try testing.expectEqualStrings("/y", v1CpuPath("3:cpuacct,cpu:/y\n").?);
    try testing.expectEqual(@as(?[]const u8, null), v1CpuPath("5:cpuacct:/z\n4:cpuset:/z\n0::/\n"));
}

test "quota files: the smallest along the cgroup path wins; missing levels are skipped" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("a/b/c");
    try tmp.dir.writeFile(.{ .sub_path = "cpu.max", .data = "max 100000\n" });
    try tmp.dir.writeFile(.{ .sub_path = "a/cpu.max", .data = "300000 100000\n" });
    try tmp.dir.writeFile(.{ .sub_path = "a/b/c/cpu.max", .data = "max 100000\n" });
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try tmp.dir.realpath(".", &root_buf);
    try testing.expectEqual(@as(?u32, 3), minQuota(root, "/a/b/c", .v2));
    try tmp.dir.writeFile(.{ .sub_path = "a/b/cpu.max", .data = "200000 100000\n" });
    try testing.expectEqual(@as(?u32, 2), minQuota(root, "/a/b/c/", .v2));
    try testing.expectEqual(@as(?u32, null), minQuota(root, "/", .v2));
    try tmp.dir.writeFile(.{ .sub_path = "a/cpu.cfs_quota_us", .data = "150000\n" });
    try tmp.dir.writeFile(.{ .sub_path = "a/cpu.cfs_period_us", .data = "100000\n" });
    try tmp.dir.writeFile(.{ .sub_path = "cpu.cfs_quota_us", .data = "-1\n" });
    try tmp.dir.writeFile(.{ .sub_path = "cpu.cfs_period_us", .data = "100000\n" });
    try testing.expectEqual(@as(?u32, 1), minQuota(root, "/a/b", .v1));
}

test "unreadable or buffer-filling files count as unknown" {
    var buf: [16]u8 = undefined;
    try testing.expectEqual(@as(?[]const u8, null), readFile("/nonexistent/cpu.max", &buf));
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "long", .data = "0123456789abcdefXYZ" });
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try tmp.dir.realpath("long", &path_buf);
    try testing.expectEqual(@as(?[]const u8, null), readFile(path, &buf));
}

test "auto picks between 1 and auto_max loops, never more than the affinity allows" {
    const n = autoLoops();
    try testing.expect(n >= 1 and n <= auto_max);
    try testing.expect(n <= @max(1, std.Thread.getCpuCount() catch 1));
    try testing.expect(effectiveCpus() >= 1);
    if (builtin.os.tag == .linux) try testing.expectEqual(@as(?u32, @intCast(std.Thread.getCpuCount() catch 0)), affinityCount());
}
