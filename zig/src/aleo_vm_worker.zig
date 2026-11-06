//! Isolated explicit-input SnarkVM worker. stdout contains only framed replies.
const std = @import("std");
const builtin = @import("builtin");
const native = @import("aleo/vm.zig");
const protocol = @import("aleo/worker.zig");
const json = @import("net/json_rpc.zig");
const Config = struct { library: []const u8, network: u16 };
const Add = struct { program: []const u8, edition: u16 };
const Auth = struct { program_id: []const u8, function_name: []const u8, inputs: []const []const u8, unchecked: bool };
const a = std.heap.page_allocator;
pub fn main() void {
    run() catch {};
}
fn read(bytes: []u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const count = try std.posix.read(std.posix.STDIN_FILENO, bytes[offset..]);
        if (count == 0) return error.WorkerEof;
        offset += count;
    }
}
fn write(bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const count = try std.posix.write(std.posix.STDOUT_FILENO, bytes[offset..]);
        if (count == 0) return error.WorkerEof;
        offset += count;
    }
}
fn reply(status: u8, bytes: []const u8) !void {
    var header: [5]u8 = undefined;
    std.mem.writeInt(u32, header[0..4], @intCast(bytes.len + 1), .big);
    header[4] = status;
    try write(&header);
    try write(bytes);
}
fn parse(comptime T: type, bytes: []const u8) !std.json.Parsed(T) {
    return std.json.parseFromSlice(T, a, bytes, .{ .duplicate_field_behavior = .@"error" });
}
fn run() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 4) return error.InvalidWorkerArguments;
    const memory = try std.fmt.parseInt(u64, args[1], 10);
    const input = try std.fmt.parseInt(u32, args[2], 10);
    const output = try std.fmt.parseInt(u32, args[3], 10);
    if (memory < 16 * 1024 * 1024 or input == 0 or input > 64 * 1024 * 1024 or output == 0 or output > 64 * 1024 * 1024) return error.InvalidWorkerLimits;
    // Linux applies a kernel virtual-address limit. Darwin's RSS limit is not a
    // hard bound; the parent additionally samples resident bytes every <=10ms.
    if (builtin.os.tag == .linux) try std.posix.setrlimit(.AS, .{ .cur = memory, .max = memory });
    try std.posix.setrlimit(.CORE, .{ .cur = 0, .max = 0 });
    try @import("aleo/sandbox.zig").denyNetwork();
    var vm: ?native.Vm = null;
    defer if (vm) |*value| value.deinit();
    var job: ?native.Job = null;
    defer if (job) |*value| value.deinit();
    var input_used: usize = 0;
    var output_used: usize = 0;
    while (true) {
        var header: [4]u8 = undefined;
        try read(&header);
        const size = std.mem.readInt(u32, &header, .big);
        if (size == 0 or size > input - input_used) return error.WorkerInputLimit;
        input_used += size;
        const frame = try a.alloc(u8, size);
        defer {
            std.crypto.secureZero(u8, frame);
            a.free(frame);
        }
        try read(frame);
        const command = std.meta.intToEnum(protocol.Command, frame[0]) catch return error.InvalidWorkerCommand;
        const response = execute(&vm, &job, command, frame[1..]) catch {
            try reply(1, &.{ 0, 1 });
            return;
        };
        defer {
            std.crypto.secureZero(u8, response);
            a.free(response);
        }
        const bytes = try std.math.add(usize, response.len, 1);
        if (bytes > output - output_used) return error.WorkerOutputLimit;
        output_used += bytes;
        try reply(0, response);
    }
}
fn execute(vm: *?native.Vm, job: *?native.Job, command: protocol.Command, payload: []const u8) ![]u8 {
    if (command == .init) {
        if (vm.* != null or job.* != null) return error.AlreadyInitialized;
        var config = try parse(Config, payload);
        defer config.deinit();
        vm.* = try native.Vm.init(a, config.value.library, config.value.network);
        return a.alloc(u8, 0);
    }
    if (command == .network_probe) {
        if (payload.len != 2) return error.InvalidProbeInput;
        const port = std.mem.readInt(u16, payload[0..2], .big);
        return networkProbe(port);
    }
    const machine = if (vm.*) |*value| value else return error.WorkerNotInitialized;
    switch (command) {
        .init => unreachable,
        .add_program => {
            if (job.* != null) return error.WorkerJobExists;
            var addition = try parse(Add, payload);
            defer addition.deinit();
            var info = try machine.programInfo(addition.value.program);
            defer info.deinit();
            const name = try json.string(try json.field(info.value(), "program_id"));
            if (machine.programs.items.len >= 1024 or addition.value.program.len > 64 * 1024 * 1024 - machine.program_bytes) return error.WorkerProgramLimit;
            try machine.programs.ensureUnusedCapacity(a, 1);
            const owned = try a.dupe(u8, name);
            errdefer a.free(owned);
            if (machine.add_fn(machine.handle, addition.value.program.ptr, addition.value.program.len, addition.value.edition) != 0) return error.NativeProgramRejected;
            machine.programs.appendAssumeCapacity(owned);
            machine.program_bytes += addition.value.program.len;
            return a.alloc(u8, 0);
        },
        .program_info => {
            var info = try machine.programInfo(payload);
            defer info.deinit();
            return a.dupe(u8, try info.bytes.slice());
        },
        .confirmed_info => {
            var info = try machine.confirmedInfo(payload);
            defer info.deinit();
            return a.dupe(u8, try info.bytes.slice());
        },
        .transaction_info => {
            var info = try machine.transactionInfo(payload);
            defer info.deinit();
            return a.dupe(u8, try info.bytes.slice());
        },
        .block_info => {
            var info = try machine.blockInfo(payload);
            defer info.deinit();
            return a.dupe(u8, try info.bytes.slice());
        },
        .key_address => {
            if (payload.len != 32) return error.InvalidKeyInput;
            return a.dupe(u8, &try machine.privateKeyAddress(payload[0..32].*));
        },
        .restore => {
            if (job.* != null) return error.WorkerJobExists;
            job.* = try machine.restoreJob(payload);
            return job.*.?.exportBytes(0);
        },
        .authorize => {
            if (job.* != null or payload.len < 64) return error.InvalidAuthorizeInput;
            var request = try parse(Auth, payload[64..]);
            defer request.deinit();
            job.* = try machine.authorize(payload[0..32].*, payload[32..64].*, request.value.program_id, request.value.function_name, request.value.inputs, request.value.unchecked);
            return job.*.?.exportBytes(0);
        },
        else => {},
    }
    const prepared = if (job.*) |*value| value else return error.WorkerJobMissing;
    switch (command) {
        .estimate => {
            if (payload.len != 4) return error.InvalidEstimateInput;
            const amount = try prepared.estimate(std.mem.readInt(u32, payload[0..4], .big));
            const out = try a.alloc(u8, 8);
            std.mem.writeInt(u64, out[0..8], amount, .big);
            return out;
        },
        .fee => {
            if (payload.len != 81 or payload[80] > 1) return error.InvalidFeeInput;
            try prepared.authorizeFee(payload[0..32].*, payload[32..64].*, std.mem.readInt(u64, payload[64..72], .big), std.mem.readInt(u64, payload[72..80], .big), payload[80] != 0);
            return a.alloc(u8, 0);
        },
        .job_info => {
            if (payload.len != 0) return error.InvalidProvingInput;
            return prepared.exportBytes(0);
        },
        .proving_request => {
            if (payload.len != 0) return error.InvalidProvingInput;
            return prepared.exportBytes(1);
        },
        .prove => {
            if (payload.len < 33) return error.InvalidProveInput;
            var result = try prepared.prove(payload[0..32].*, payload[32..], null);
            defer result.deinit();
            return a.dupe(u8, try result.slice());
        },
        .validate => {
            var result = try prepared.validateTransaction(payload);
            defer result.deinit();
            return a.dupe(u8, try result.bytes.slice());
        },
        else => return error.InvalidWorkerCommand,
    }
}

fn networkProbe(port: u16) ![]u8 {
    if (port == 0) return error.InvalidProbeInput;
    if (builtin.os.tag == .linux) {
        // The worker's seccomp filter returns EPERM. Zig's POSIX socket wrapper
        // recognizes EACCES, but maps EPERM to Unexpected; inspect that exact
        // syscall here rather than accepting arbitrary transport failures.
        const linux = std.os.linux;
        const result = linux.socket(std.posix.AF.INET, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0);
        switch (linux.E.init(result)) {
            .PERM, .ACCES => return a.dupe(u8, &.{1}),
            .SUCCESS => std.posix.close(@intCast(result)),
            else => return error.WorkerNetworkProbeFailed,
        }
    }
    const address = try std.net.Address.parseIp4("127.0.0.1", port);
    const connection = std.net.tcpConnectToAddress(address) catch |err| switch (err) {
        error.PermissionDenied, error.AccessDenied => return a.dupe(u8, &.{1}),
        else => return err,
    };
    connection.close();
    return a.dupe(u8, &.{0});
}

test "Aleo worker network probe allowed loopback control and invalid inputs remain distinct" {
    var listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{ .force_nonblocking = true });
    defer listener.deinit();
    const response = try networkProbe(listener.listen_address.getPort());
    defer a.free(response);
    try std.testing.expectEqualSlices(u8, &.{0}, response);
    var ready = [_]std.posix.pollfd{.{ .fd = listener.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
    try std.testing.expectEqual(@as(usize, 1), try std.posix.poll(&ready, 1000));
    const connection = try listener.accept();
    connection.stream.close();
    try std.testing.expectError(error.InvalidProbeInput, networkProbe(0));
    var vm: ?native.Vm = null;
    var job: ?native.Job = null;
    try std.testing.expectError(error.InvalidProbeInput, execute(&vm, &job, .network_probe, &.{}));
    try std.testing.expectError(error.InvalidProbeInput, execute(&vm, &job, .network_probe, &.{ 0, 0 }));
    if (builtin.os.tag == .linux) {
        // Linux returns an immediate RST for this owned port. Darwin queues
        // the SYN instead; exercising it there would wait for TCP's timeout.
        const unlistened = try std.posix.socket(std.posix.AF.INET, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0);
        defer std.posix.close(unlistened);
        var address = try std.net.Address.parseIp4("127.0.0.1", 0);
        try std.posix.bind(unlistened, &address.any, address.getOsSockLen());
        var length = address.getOsSockLen();
        try std.posix.getsockname(unlistened, &address.any, &length);
        try std.testing.expectError(error.ConnectionRefused, networkProbe(address.getPort()));
    }
}
