//! Existing serde JSON enum/record formats stored in RocksDB. No fallback for
//! unknown variants: those indicate unsupported state and must stop recovery.
const std = @import("std");
const Value = std.json.Value;
const Allocator = std.mem.Allocator;

pub const ApplicationReport = enum { AmountBelowMinimum, MalformedMessage, ZeroAmount };
pub const ConfirmReason = enum { SubmittedBySelf, AlreadySubmitted, ErrorConfirmingDelivery, ErrorRecordingProcessSuccess };
pub const ReprepareReason = union(enum) {
    Manual,
    ErrorCheckingDeliveryStatus,
    ErrorCheckingIfRecipientIsContract,
    ErrorFetchingIsmAddress,
    ErrorGettingMetadataBuilder,
    ErrorSubmitting,
    ErrorBuildingMetadata,
    CouldNotFetchMetadata,
    ErrorEstimatingGas,
    ErrorCheckingGasRequirement,
    GasPaymentRequirementNotMet,
    GasPaymentNotFound,
    ExceedsMaxGasLimit,
    RevertedOrReorged,
    MessageMetadataRefused,
    ApplicationReport: ApplicationReport,
    ErrorCreatingPayload,
    ErrorStoringPayloadUuidsByMessageId,
    ErrorRetrievingPayloadUuids,
    ErrorRetrievingPayloadStatus,
    ErrorPersistingTerminalMessage,
    ErrorCreatingPayloadSuccessCriteria,
    AwaitingValidatorSignatures,
    AwaitingIcaReveal,
    ErrorFetchingOriginTxSender,

    pub fn jsonStringify(self: ReprepareReason, writer: *std.json.Stringify) !void {
        switch (self) {
            .ApplicationReport => |report| {
                try writer.beginObject();
                try writer.objectField("ApplicationReport");
                try writer.write(@tagName(report));
                try writer.endObject();
            },
            else => try writer.write(@tagName(self)),
        }
    }

    pub fn fromValue(value: Value) !ReprepareReason {
        if (value == .string) {
            inline for (std.meta.fields(ReprepareReason)) |field| {
                if (field.type == void and std.mem.eql(u8, field.name, value.string))
                    return @unionInit(ReprepareReason, field.name, {});
            }
            return error.UnknownRetryReason;
        }
        if (value != .object or value.object.count() != 1) return error.InvalidRetryReason;
        const report = value.object.get("ApplicationReport") orelse return error.UnknownRetryReason;
        if (report != .string) return error.InvalidApplicationReport;
        return .{ .ApplicationReport = std.meta.stringToEnum(ApplicationReport, report.string) orelse return error.UnknownApplicationReport };
    }
};

pub const Status = union(enum) {
    FirstPrepareAttempt,
    Retry: ReprepareReason,
    ReadyToSubmit,
    Confirm: ConfirmReason,

    pub fn jsonStringify(self: Status, writer: *std.json.Stringify) !void {
        switch (self) {
            .FirstPrepareAttempt, .ReadyToSubmit => try writer.write(@tagName(self)),
            .Retry => |reason| {
                try writer.beginObject();
                try writer.objectField("Retry");
                try writer.write(reason);
                try writer.endObject();
            },
            .Confirm => |reason| {
                try writer.beginObject();
                try writer.objectField("Confirm");
                try writer.write(@tagName(reason));
                try writer.endObject();
            },
        }
    }

    pub fn fromValue(value: Value) !Status {
        if (value == .string) {
            if (std.mem.eql(u8, value.string, "FirstPrepareAttempt")) return .FirstPrepareAttempt;
            if (std.mem.eql(u8, value.string, "ReadyToSubmit")) return .ReadyToSubmit;
            return error.UnknownStatus;
        }
        if (value != .object or value.object.count() != 1) return error.InvalidStatus;
        if (value.object.get("Retry")) |reason| return .{ .Retry = try ReprepareReason.fromValue(reason) };
        if (value.object.get("Confirm")) |reason| {
            if (reason != .string) return error.InvalidConfirmReason;
            return .{ .Confirm = std.meta.stringToEnum(ConfirmReason, reason.string) orelse return error.UnknownConfirmReason };
        }
        return error.UnknownStatus;
    }

    pub fn toJson(self: Status, allocator: Allocator) ![]u8 {
        return std.json.Stringify.valueAlloc(allocator, self, .{});
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !Status {
        const parsed = try std.json.parseFromSlice(Value, allocator, bytes, .{ .parse_numbers = false });
        defer parsed.deinit();
        return fromValue(parsed.value);
    }
};

fn unsigned(comptime T: type, value: Value) !T {
    if (value != .number_string) return error.InvalidInteger;
    return std.fmt.parseInt(T, value.number_string, 10);
}

fn optionalUnsigned(comptime T: type, value: ?Value) !?T {
    if (value) |number| return if (number == .null) null else try unsigned(T, number);
    return null;
}

pub const RetryState = struct {
    version: u8 = 1,
    retry_count: u32,
    next_attempt_at_millis: ?u64,
    retry_delay_millis: ?u64,
    reason: ?ReprepareReason,

    pub fn validate(self: RetryState) !void {
        if (self.version != 1 or (self.next_attempt_at_millis != null) != (self.retry_delay_millis != null))
            return error.UnsupportedRetryState;
    }

    pub fn toJson(self: RetryState, allocator: Allocator) ![]u8 {
        try self.validate();
        return std.json.Stringify.valueAlloc(allocator, self, .{});
    }

    pub fn parse(allocator: Allocator, bytes: []const u8) !RetryState {
        const parsed = try std.json.parseFromSlice(Value, allocator, bytes, .{ .parse_numbers = false });
        defer parsed.deinit();
        const value = parsed.value;
        if (value != .object) return error.InvalidRetryState;
        const version = value.object.get("version") orelse return error.MissingVersion;
        const count = value.object.get("retry_count") orelse return error.MissingRetryCount;
        const reason = value.object.get("reason");
        const result: RetryState = .{
            .version = try unsigned(u8, version),
            .retry_count = try unsigned(u32, count),
            .next_attempt_at_millis = try optionalUnsigned(u64, value.object.get("next_attempt_at_millis")),
            .retry_delay_millis = try optionalUnsigned(u64, value.object.get("retry_delay_millis")),
            .reason = if (reason) |r| if (r == .null) null else try ReprepareReason.fromValue(r) else null,
        };
        try result.validate();
        return result;
    }
};

test "serde status wire spelling nested report and fail-closed recovery" {
    const allocator = std.testing.allocator;
    const status: Status = .{ .Retry = .{ .ApplicationReport = .ZeroAmount } };
    const encoded = try status.toJson(allocator);
    defer allocator.free(encoded);
    try std.testing.expectEqualStrings("{\"Retry\":{\"ApplicationReport\":\"ZeroAmount\"}}", encoded);
    const decoded = try Status.parse(allocator, encoded);
    try std.testing.expectEqual(ApplicationReport.ZeroAmount, decoded.Retry.ApplicationReport);
    try std.testing.expectError(error.UnknownStatus, Status.parse(allocator, "\"Unknown\""));
    try std.testing.expectError(error.UnknownRetryReason, Status.parse(allocator, "{\"Retry\":\"Unknown\"}"));
    try std.testing.expectError(error.UnsupportedRetryState, RetryState.parse(allocator, "{\"version\":2,\"retry_count\":0}"));
    try std.testing.expectError(error.UnsupportedRetryState, RetryState.parse(allocator, "{\"version\":1,\"retry_count\":0,\"next_attempt_at_millis\":1}"));
    const max = try RetryState.parse(allocator, "{\"version\":1,\"retry_count\":0,\"next_attempt_at_millis\":18446744073709551615,\"retry_delay_millis\":18446744073709551615}");
    try std.testing.expectEqual(std.math.maxInt(u64), max.next_attempt_at_millis);
}
