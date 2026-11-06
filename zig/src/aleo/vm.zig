//! Explicit native SnarkVM authorization/proving boundary. Host retains transport,
//! transaction policy and durable state. Jobs and buffers borrow the loaded VM.
const std = @import("std");
const provider = @import("provider.zig");
const json = @import("../net/json_rpc.zig");
const Hash = [32]u8;
const Buffer = extern struct { data: ?[*]u8 = null, len: usize = 0 };
const Create = *const fn (u16, *?*anyopaque) callconv(.c) i32;
const Destroy = *const fn (?*anyopaque) callconv(.c) void;
const Add = *const fn (*anyopaque, [*]const u8, usize, u16) callconv(.c) i32;
const Authorize = *const fn (*anyopaque, *const Hash, *const Hash, [*]const u8, usize, *?*anyopaque) callconv(.c) i32;
const Estimate = *const fn (*anyopaque, *anyopaque, u32, *u64) callconv(.c) i32;
const Fee = *const fn (*anyopaque, *anyopaque, *const Hash, *const Hash, u64, u64, u8) callconv(.c) i32;
const Export = *const fn (*anyopaque, u8, [*]u8, usize, *usize) callconv(.c) i32;
const Restore = *const fn (*anyopaque, [*]const u8, usize, *?*anyopaque) callconv(.c) i32;
const Free = *const fn (Buffer) callconv(.c) void;
const Prove = *const fn (*anyopaque, *anyopaque, *const Hash, [*]const u8, usize, *Buffer) callconv(.c) i32;
const Validate = *const fn (*anyopaque, [*]const u8, usize, *Buffer) callconv(.c) i32;
const BlockInfo = *const fn (u16, [*]const u8, usize, *Buffer) callconv(.c) i32;
const Info = *const fn ([*]const u8, usize, *Buffer) callconv(.c) i32;
const Address = *const fn (*const Hash, *Hash) callconv(.c) i32;
pub const Bytes = struct {
    buffer: Buffer,
    free_fn: Free,
    pub fn slice(self: *const Bytes) ![]const u8 {
        const data = self.buffer.data orelse return error.InvalidAleoVmOutput;
        if (self.buffer.len > 64 * 1024 * 1024) return error.AleoVmOutputLimit;
        return data[0..self.buffer.len];
    }
    pub fn deinit(self: *Bytes) void {
        self.free_fn(self.buffer);
        self.* = undefined;
    }
};
pub const Json = struct {
    bytes: Bytes,
    parsed: std.json.Parsed(std.json.Value),
    pub fn value(self: *const Json) std.json.Value {
        return self.parsed.value;
    }
    pub fn deinit(self: *Json) void {
        self.parsed.deinit();
        self.bytes.deinit();
        self.* = undefined;
    }
};
pub const Vm = struct {
    allocator: std.mem.Allocator,
    library: std.DynLib,
    handle: *anyopaque,
    destroy_fn: Destroy,
    add_fn: Add,
    authorize_fn: Authorize,
    restore_fn: Restore,
    job_destroy_fn: Destroy,
    estimate_fn: Estimate,
    fee_fn: Fee,
    export_fn: Export,
    free_fn: Free,
    prove_fn: Prove,
    validate_fn: Validate,
    program_info_fn: Info,
    address_fn: Address,
    block_info_fn: BlockInfo,
    transaction_info_fn: BlockInfo,
    confirmed_info_fn: BlockInfo,
    programs: std.ArrayList([]u8) = .empty,
    program_bytes: usize = 0,
    network: u16,
    pub fn init(a: std.mem.Allocator, path: []const u8, network: u16) !Vm {
        if (network > 2) return error.UnknownAleoNetwork;
        var lib = try std.DynLib.open(path);
        errdefer lib.close();
        const version = try symbol(&lib, *const fn () callconv(.c) u32, "ziggy_aleo_vm_abi_version");
        if (version() != 1) return error.IncompatibleAleoVmAbi;
        const create = try symbol(&lib, Create, "ziggy_aleo_vm_create");
        const destroy = try symbol(&lib, Destroy, "ziggy_aleo_vm_destroy");
        var handle: ?*anyopaque = null;
        try status(create(network, &handle));
        errdefer destroy(handle);
        return .{ .allocator = a, .library = lib, .handle = handle orelse return error.InvalidAleoVmOutput, .network = network, .destroy_fn = destroy, .add_fn = try symbol(&lib, Add, "ziggy_aleo_vm_add_program"), .authorize_fn = try symbol(&lib, Authorize, "ziggy_aleo_vm_authorize"), .restore_fn = try symbol(&lib, Restore, "ziggy_aleo_job_restore"), .job_destroy_fn = try symbol(&lib, Destroy, "ziggy_aleo_job_destroy"), .estimate_fn = try symbol(&lib, Estimate, "ziggy_aleo_vm_estimate"), .fee_fn = try symbol(&lib, Fee, "ziggy_aleo_vm_authorize_fee"), .export_fn = try symbol(&lib, Export, "ziggy_aleo_job_export"), .free_fn = try symbol(&lib, Free, "ziggy_aleo_buffer_destroy"), .prove_fn = try symbol(&lib, Prove, "ziggy_aleo_vm_prove"), .validate_fn = try symbol(&lib, Validate, "ziggy_aleo_job_validate_transaction"), .program_info_fn = try symbol(&lib, Info, "ziggy_aleo_program_info"), .address_fn = try symbol(&lib, Address, "ziggy_aleo_private_key_address"), .block_info_fn = try symbol(&lib, BlockInfo, "ziggy_aleo_block_info"), .transaction_info_fn = try symbol(&lib, BlockInfo, "ziggy_aleo_transaction_info"), .confirmed_info_fn = try symbol(&lib, BlockInfo, "ziggy_aleo_confirmed_info") };
    }
    /// All jobs/buffers must be destroyed before VM/library destruction.
    pub fn deinit(self: *Vm) void {
        for (self.programs.items) |name| self.allocator.free(name);
        self.programs.deinit(self.allocator);
        self.destroy_fn(self.handle);
        self.library.close();
        self.* = undefined;
    }
    pub fn privateKeyAddress(self: *Vm, key: Hash) !Hash {
        var copy = key;
        defer std.crypto.secureZero(u8, &copy);
        var out: Hash = undefined;
        try status(self.address_fn(&copy, &out));
        return out;
    }
    pub fn confirmedInfo(self: *Vm, transaction: []const u8) !Json {
        if (transaction.len == 0 or transaction.len > 16 * 1024 * 1024) return error.AleoTransactionLimit;
        var out: Buffer = .{};
        try status(self.confirmed_info_fn(self.network, transaction.ptr, transaction.len, &out));
        return self.parse(.{ .buffer = out, .free_fn = self.free_fn });
    }
    pub fn transactionInfo(self: *Vm, transaction: []const u8) !Json {
        if (transaction.len == 0 or transaction.len > 16 * 1024 * 1024) return error.AleoTransactionLimit;
        var out: Buffer = .{};
        try status(self.transaction_info_fn(self.network, transaction.ptr, transaction.len, &out));
        return self.parse(.{ .buffer = out, .free_fn = self.free_fn });
    }
    pub fn blockInfo(self: *Vm, block: []const u8) !Json {
        if (block.len == 0 or block.len > 16 * 1024 * 1024) return error.AleoBlockLimit;
        var out: Buffer = .{};
        try status(self.block_info_fn(self.network, block.ptr, block.len, &out));
        return self.parse(.{ .buffer = out, .free_fn = self.free_fn });
    }
    pub fn programInfo(self: *Vm, program: []const u8) !Json {
        if (program.len == 0 or program.len > 16 * 1024 * 1024) return error.AleoProgramLimit;
        var buffer: Buffer = .{};
        try status(self.program_info_fn(program.ptr, program.len, &buffer));
        return self.parse(.{ .buffer = buffer, .free_fn = self.free_fn });
    }
    fn parse(self: *Vm, bytes: Bytes) !Json {
        var owned = bytes;
        errdefer owned.deinit();
        const parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, try owned.slice(), .{ .duplicate_field_behavior = .@"error" });
        return .{ .bytes = owned, .parsed = parsed };
    }
    fn hasProgram(self: *Vm, name: []const u8) bool {
        if (std.mem.eql(u8, name, "credits.aleo")) return true;
        for (self.programs.items) |existing| if (std.mem.eql(u8, existing, name)) return true;
        return false;
    }
    pub fn loadProgram(self: *Vm, client: *provider.Provider, name: []const u8, cancel: ?*const std.atomic.Value(bool)) !void {
        if (client.client.network != self.network) return error.WrongAleoVmNetwork;
        var active: std.ArrayList([]const u8) = .empty;
        defer active.deinit(self.allocator);
        try self.load(client, name, &active, cancel);
    }
    fn load(self: *Vm, client: *provider.Provider, name: []const u8, active: *std.ArrayList([]const u8), cancel: ?*const std.atomic.Value(bool)) anyerror!void {
        try cancelled(cancel);
        if (self.hasProgram(name)) return;
        if (active.items.len >= 64 or self.programs.items.len >= 1024) return error.AleoProgramImportLimit;
        for (active.items) |ancestor| if (std.mem.eql(u8, ancestor, name)) return error.AleoProgramImportCycle;
        try active.append(self.allocator, name);
        defer _ = active.pop();
        var edition = try client.client.get(&.{ "program", name, "latest_edition" }, &.{});
        defer edition.deinit();
        const version = try json.integer(u16, edition.value());
        var digits: [8]u8 = undefined;
        var response = try client.client.get(&.{ "program", name, try std.fmt.bufPrint(&digits, "{d}", .{version}) }, &.{});
        defer response.deinit();
        const program = try json.string(response.value());
        if (program.len > 16 * 1024 * 1024 or program.len > 64 * 1024 * 1024 - self.program_bytes) return error.AleoProgramLimit;
        var info = try self.programInfo(program);
        defer info.deinit();
        if (!std.mem.eql(u8, name, try json.string(try json.field(info.value(), "program_id")))) return error.WrongAleoProgram;
        const imports = try json.field(info.value(), "imports");
        if (imports != .array or imports.array.items.len > 64) return error.AleoProgramImportLimit;
        for (imports.array.items) |item| try self.load(client, try json.string(item), active, cancel);
        try cancelled(cancel);
        try self.programs.ensureUnusedCapacity(self.allocator, 1);
        const owned = try self.allocator.dupe(u8, name);
        errdefer self.allocator.free(owned);
        try status(self.add_fn(self.handle, program.ptr, program.len, version));
        self.programs.appendAssumeCapacity(owned);
        self.program_bytes += program.len;
    }
    pub fn restoreJob(self: *Vm, bytes: []const u8) !Job {
        if (bytes.len == 0 or bytes.len > 16 * 1024 * 1024) return error.AleoAuthorizationLimit;
        var handle: ?*anyopaque = null;
        try status(self.restore_fn(self.handle, bytes.ptr, bytes.len, &handle));
        var job: Job = .{ .vm = self, .handle = handle orelse return error.InvalidAleoVmOutput };
        errdefer job.deinit();
        var info = try job.info();
        defer info.deinit();
        job.fee_authorized = try json.field(info.value(), "fee_authorization") != .null;
        return job;
    }
    pub fn authorize(self: *Vm, key: Hash, seed: Hash, program: []const u8, function: []const u8, inputs: []const []const u8, unchecked: bool) !Job {
        if (inputs.len > 1024 or program.len > 128 or function.len > 128) return error.AleoAuthorizationLimit;
        const request = try std.json.Stringify.valueAlloc(self.allocator, .{ .program_id = program, .function_name = function, .inputs = inputs, .unchecked = unchecked }, .{});
        defer {
            std.crypto.secureZero(u8, request);
            self.allocator.free(request);
        }
        if (request.len > 16 * 1024 * 1024) return error.AleoAuthorizationLimit;
        var secret = key;
        defer std.crypto.secureZero(u8, &secret);
        var entropy = seed;
        defer std.crypto.secureZero(u8, &entropy);
        var handle: ?*anyopaque = null;
        try status(self.authorize_fn(self.handle, &secret, &entropy, request.ptr, request.len, &handle));
        var job: Job = .{ .vm = self, .handle = handle orelse return error.InvalidAleoVmOutput };
        errdefer job.deinit();
        var info = try job.info();
        defer info.deinit();
        const transitions = try json.field(info.value(), "transitions");
        if (transitions != .array or transitions.array.items.len > 1024) return error.InvalidAleoAuthorization;
        for (transitions.array.items) |transition| {
            const id = try json.string(try json.field(transition, "program_id"));
            const name = try json.string(try json.field(transition, "function_name"));
            if ((std.mem.eql(u8, id, "credits.aleo") or std.mem.eql(u8, id, "token_registry.aleo")) and std.mem.eql(u8, name, "transfer_public_as_signer")) return error.MaliciousAleoAuthorization;
        }
        return job;
    }
};
pub const Job = struct {
    vm: *Vm,
    handle: *anyopaque,
    fee_authorized: bool = false,
    pub fn deinit(self: *Job) void {
        self.vm.job_destroy_fn(self.handle);
        self.* = undefined;
    }
    pub fn exportBytes(self: *Job, mode: u8) ![]u8 {
        var tiny: [1]u8 = undefined;
        var len: usize = 0;
        const result = self.vm.export_fn(self.handle, mode, &tiny, tiny.len, &len);
        if (result != 0 and result != -4) try status(result);
        if (len == 0 or len > 16 * 1024 * 1024) return error.AleoVmOutputLimit;
        const bytes = try self.vm.allocator.alloc(u8, len);
        errdefer self.vm.allocator.free(bytes);
        try status(self.vm.export_fn(self.handle, mode, bytes.ptr, bytes.len, &len));
        if (len != bytes.len) return error.InvalidAleoVmOutput;
        return bytes;
    }
    pub fn info(self: *Job) !Json {
        const bytes = try self.exportBytes(0);
        defer {
            std.crypto.secureZero(u8, bytes);
            self.vm.allocator.free(bytes);
        } // Copy into a native owning buffer is unnecessary: parsed output owns all strings.
        const parsed = try std.json.parseFromSlice(std.json.Value, self.vm.allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        return .{ .bytes = .{ .buffer = .{}, .free_fn = self.vm.free_fn }, .parsed = parsed };
    }
    pub fn estimate(self: *Job, height: u32) !u64 {
        var value: u64 = 0;
        try status(self.vm.estimate_fn(self.vm.handle, self.handle, height, &value));
        return value;
    }
    pub fn authorizeFee(self: *Job, key: Hash, seed: Hash, base: u64, priority: u64, unchecked: bool) !void {
        if (self.fee_authorized) return error.AleoFeeAlreadyAuthorized;
        _ = try std.math.add(u64, base, priority);
        var secret = key;
        defer std.crypto.secureZero(u8, &secret);
        var entropy = seed;
        defer std.crypto.secureZero(u8, &entropy);
        try status(self.vm.fee_fn(self.vm.handle, self.handle, &secret, &entropy, base, priority, @intFromBool(unchecked)));
        self.fee_authorized = true;
    }
    pub fn prove(self: *Job, seed: Hash, query: []const u8, cancel: ?*const std.atomic.Value(bool)) !Bytes {
        try cancelled(cancel);
        if (!self.fee_authorized) return error.AleoFeeNotAuthorized;
        if (query.len == 0 or query.len > 16 * 1024 * 1024) return error.AleoQueryLimit;
        var entropy = seed;
        defer std.crypto.secureZero(u8, &entropy);
        var out: Buffer = .{};
        try status(self.vm.prove_fn(self.vm.handle, self.handle, &entropy, query.ptr, query.len, &out));
        var bytes: Bytes = .{ .buffer = out, .free_fn = self.vm.free_fn };
        errdefer bytes.deinit();
        try cancelled(cancel);
        _ = try bytes.slice();
        return bytes;
    }
    pub fn validateTransaction(self: *Job, transaction: []const u8) !Json {
        if (transaction.len == 0 or transaction.len > 16 * 1024 * 1024) return error.AleoTransactionLimit;
        var out: Buffer = .{};
        try status(self.vm.validate_fn(self.handle, transaction.ptr, transaction.len, &out));
        return self.vm.parse(.{ .buffer = out, .free_fn = self.vm.free_fn });
    }
};
fn symbol(lib: *std.DynLib, comptime T: type, name: [:0]const u8) !T {
    return lib.lookup(T, name) orelse error.MissingAleoVmSymbol;
}
fn cancelled(flag: ?*const std.atomic.Value(bool)) !void {
    if (flag) |value| if (value.load(.acquire)) return error.AleoOperationCancelled;
}
fn status(code: i32) !void {
    return switch (code) {
        0 => {},
        -1 => error.InvalidAleoVmInput,
        -2 => error.AleoVmRejected,
        -4 => error.AleoVmBufferTooSmall,
        -5 => error.AleoProofIntentMismatch,
        else => error.AleoVmFailure,
    };
}
