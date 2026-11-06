const std = @import("std");
const metrics = @import("ops/metrics.zig");
const lander_metrics = @import("ops/lander_metrics.zig");
const relayer_metrics = @import("ops/relayer_metrics.zig");
const lander = @import("lander/observer.zig");
const db = @import("db/json.zig");

const A = std.mem.Allocator;
const signer_label = "0x" ++ ("11" ** 20);

fn registry(a: A) !*metrics.Registry {
    return metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 1024 * 1024 });
}

fn expectSample(text: []const u8, sample: []const u8) !void {
    if (std.mem.indexOf(u8, text, sample) == null) {
        std.debug.print("missing metric sample: {s}\n", .{sample});
        return error.MissingMetricSample;
    }
}

test "Lander observer maps every variant to captured source families and labels" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    var adapter: lander_metrics.Adapter = .{ .registry = r, .destination = "arbitrum" };
    const observer = adapter.observer();
    try std.testing.expect(observer.metric_fn != null);
    try std.testing.expect(observer.finalized_fn == null);
    const signer: [20]u8 = @splat(0x11);

    try observer.metric(.{ .transaction_submission = .{ .gas_price = 5, .priority_fee = 2, .gas_limit = 21_000 } });
    try observer.metric(.finalized_transaction);
    try observer.metric(.{ .dropped_payload = .{ .name = "Reverted" } });
    try observer.metric(.{ .dropped_transaction = .{ .name = "Other" } });
    try observer.metric(.{ .batch_built = .{ .success = true, .payloads = 3 } });
    try observer.metric(.{ .batch_built = .{ .success = false, .payloads = 2 } });
    try observer.metric(.{ .mev_submission = false });
    try observer.metric(.{ .mev_submission = true });
    try observer.metric(.{ .status_read_batch = 4 });
    try observer.metric(.{ .status_read_requests = 1 });
    try observer.metric(.{ .status_read_requests_avoided = 3 });
    try observer.metric(.{ .task_liveness = .{ .stage = .building, .unix_seconds = 10 } });
    try observer.metric(.{ .task_liveness = .{ .stage = .inclusion, .unix_seconds = 11 } });
    try observer.metric(.{ .task_liveness = .{ .stage = .finality, .unix_seconds = 12 } });
    try observer.metric(.{ .finalized_nonce = .{ .signer = signer, .value = 7 } });
    try observer.metric(.{ .upper_nonce = .{ .signer = signer, .value = 8 } });
    try observer.metric(.{ .mismatched_nonce = .{ .signer = signer, .value = 99 } });
    try observer.metric(.{ .mismatched_nonce = .{ .signer = signer, .value = 100 } });
    try observer.metric(.{ .inclusion_error = .{ .name = "NetworkError", .detail = "true" } });
    try observer.metric(.{ .building_queue_length = 4 });
    try observer.metric(.{ .inclusion_pool_length = 5 });
    try observer.metric(.{ .finality_pool_length = 6 });
    try observer.metric(.{ .oldest_unchecked_transaction_age_seconds = 45 });
    try observer.metric(.{ .status_scan_duration_milliseconds = 123 });
    try observer.metric(.{ .call_retries = .{ .name = "send_raw_transaction", .detail = "ChainCommunicationError" } });

    const text = try r.render(a);
    defer a.free(text);
    const samples = [_][]const u8{
        "hyperlane_lander_transaction_submissions{destination=\"arbitrum\"} 1\n",
        "hyperlane_lander_gas_price{destination=\"arbitrum\"} 5\n",
        "hyperlane_lander_priority_fee{destination=\"arbitrum\"} 2\n",
        "hyperlane_lander_gas_limit{destination=\"arbitrum\"} 21000\n",
        "hyperlane_lander_finalized_transactions{destination=\"arbitrum\"} 1\n",
        "hyperlane_lander_dropped_payloads{destination=\"arbitrum\",reason=\"Reverted\"} 1\n",
        "hyperlane_lander_dropped_transactions{destination=\"arbitrum\",reason=\"Other\"} 1\n",
        "hyperlane_lander_batched_transactions{destination=\"arbitrum\",status=\"success\"} 3\n",
        "hyperlane_lander_batched_transactions{destination=\"arbitrum\",status=\"failed\"} 2\n",
        "hyperlane_lander_mev_submissions{destination=\"arbitrum\",status=\"error\"} 1\n",
        "hyperlane_lander_mev_submissions{destination=\"arbitrum\",status=\"success\"} 1\n",
        "hyperlane_lander_status_read_transactions{destination=\"arbitrum\",stage=\"InclusionStage\"} 4\n",
        "hyperlane_lander_status_read_requests{destination=\"arbitrum\",stage=\"InclusionStage\"} 1\n",
        "hyperlane_lander_status_read_requests_avoided{destination=\"arbitrum\",stage=\"InclusionStage\"} 3\n",
        "hyperlane_lander_task_liveness{destination=\"arbitrum\",stage=\"BuildingStage\"} 10\n",
        "hyperlane_lander_task_liveness{destination=\"arbitrum\",stage=\"InclusionStage\"} 11\n",
        "hyperlane_lander_task_liveness{destination=\"arbitrum\",stage=\"FinalityStage\"} 12\n",
        "hyperlane_lander_finalized_nonce{destination=\"arbitrum\",signer=\"" ++ signer_label ++ "\"} 7\n",
        "hyperlane_lander_upper_nonce{destination=\"arbitrum\",signer=\"" ++ signer_label ++ "\"} 8\n",
        "hyperlane_lander_mismatched_nonce{destination=\"arbitrum\",signer=\"" ++ signer_label ++ "\"} 2\n",
        "hyperlane_lander_inclusion_stage_error{destination=\"arbitrum\",error_type=\"NetworkError\",infra_error=\"true\"} 1\n",
        "hyperlane_lander_building_stage_queue_length{destination=\"arbitrum\"} 4\n",
        "hyperlane_lander_inclusion_stage_pool_length{destination=\"arbitrum\"} 5\n",
        "hyperlane_lander_finality_stage_pool_length{destination=\"arbitrum\"} 6\n",
        "hyperlane_lander_oldest_unchecked_transaction_age_seconds{destination=\"arbitrum\",stage=\"InclusionStage\"} 45\n",
        "hyperlane_lander_status_scan_duration_milliseconds{destination=\"arbitrum\",stage=\"InclusionStage\"} 123\n",
        "hyperlane_lander_call_retries{destination=\"arbitrum\",error_type=\"ChainCommunicationError\",call_type=\"send_raw_transaction\"} 1\n",
    };
    for (samples) |sample| try expectSample(text, sample);
}

test "Lander zero and overflow conversions match source casts and Duration saturation" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    var adapter: lander_metrics.Adapter = .{ .registry = r, .destination = "zero" };
    const signer: [20]u8 = @splat(0x11);
    try adapter.record(.{ .transaction_submission = .{ .gas_price = 0, .priority_fee = 0, .gas_limit = 0 } });
    try adapter.record(.{ .finalized_nonce = .{ .signer = signer, .value = 0 } });
    try adapter.record(.{ .building_queue_length = 0 });
    try adapter.record(.{ .oldest_unchecked_transaction_age_seconds = 0 });
    try adapter.record(.{ .status_scan_duration_milliseconds = 0 });
    const zero = try r.render(a);
    defer a.free(zero);
    for ([_][]const u8{
        "hyperlane_lander_gas_price{destination=\"zero\"} 0\n",
        "hyperlane_lander_priority_fee{destination=\"zero\"} 0\n",
        "hyperlane_lander_gas_limit{destination=\"zero\"} 0\n",
        "hyperlane_lander_finalized_nonce{destination=\"zero\",signer=\"" ++ signer_label ++ "\"} 0\n",
        "hyperlane_lander_building_stage_queue_length{destination=\"zero\"} 0\n",
        "hyperlane_lander_oldest_unchecked_transaction_age_seconds{destination=\"zero\",stage=\"InclusionStage\"} 0\n",
        "hyperlane_lander_status_scan_duration_milliseconds{destination=\"zero\",stage=\"InclusionStage\"} 0\n",
    }) |sample| try expectSample(zero, sample);

    const over64 = @as(u256, 1) << 64;
    try adapter.record(.{ .transaction_submission = .{ .gas_price = std.math.maxInt(u256), .priority_fee = over64 + 9, .gas_limit = std.math.maxInt(u256) } });
    try adapter.record(.{ .finalized_nonce = .{ .signer = signer, .value = std.math.maxInt(u256) } });
    try adapter.record(.{ .upper_nonce = .{ .signer = signer, .value = over64 } });
    try adapter.record(.{ .building_queue_length = std.math.maxInt(u64) });
    try adapter.record(.{ .task_liveness = .{ .stage = .inclusion, .unix_seconds = std.math.maxInt(u64) } });
    try adapter.record(.{ .oldest_unchecked_transaction_age_seconds = std.math.maxInt(u64) });
    try adapter.record(.{ .status_scan_duration_milliseconds = std.math.maxInt(u64) });
    const overflow = try r.render(a);
    defer a.free(overflow);
    for ([_][]const u8{
        "hyperlane_lander_gas_price{destination=\"zero\"} -1\n",
        "hyperlane_lander_priority_fee{destination=\"zero\"} 9\n",
        "hyperlane_lander_gas_limit{destination=\"zero\"} -1\n",
        "hyperlane_lander_finalized_nonce{destination=\"zero\",signer=\"" ++ signer_label ++ "\"} -1\n",
        "hyperlane_lander_upper_nonce{destination=\"zero\",signer=\"" ++ signer_label ++ "\"} 0\n",
        "hyperlane_lander_building_stage_queue_length{destination=\"zero\"} -1\n",
        "hyperlane_lander_task_liveness{destination=\"zero\",stage=\"InclusionStage\"} -1\n",
        "hyperlane_lander_oldest_unchecked_transaction_age_seconds{destination=\"zero\",stage=\"InclusionStage\"} 9223372036854775807\n",
        "hyperlane_lander_status_scan_duration_milliseconds{destination=\"zero\",stage=\"InclusionStage\"} 9223372036854775807\n",
    }) |sample| try expectSample(overflow, sample);
}

test "Lander labels are escaped and registry errors reach the observer caller" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    var adapter: lander_metrics.Adapter = .{ .registry = r, .destination = "dest\"\\\n" };
    try adapter.record(.{ .dropped_payload = .{ .name = "reason\"\\\n" } });
    try adapter.record(.{ .inclusion_error = .{ .name = "NetworkError" } });
    try adapter.record(.{ .call_retries = .{ .name = "account_nonce" } });
    const text = try r.render(a);
    defer a.free(text);
    try expectSample(text, "hyperlane_lander_dropped_payloads{destination=\"dest\\\"\\\\\\n\",reason=\"reason\\\"\\\\\\n\"} 1\n");
    try expectSample(text, "infra_error=\"false\"");
    try expectSample(text, "error_type=\"account_nonce\",call_type=\"account_nonce\"");
    var invalid: lander_metrics.Adapter = .{ .registry = r, .destination = "" };
    try std.testing.expectError(error.InvalidMetricDestination, invalid.observer().metric(.finalized_transaction));
}

test "relayer processed operation metadata and queue metrics use source terminal semantics" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    const tracker = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 8, .max_bytes = 16 * 1024 });
    defer tracker.deinit();
    const adapter = try relayer_metrics.Adapter.init(a, tracker, "ethereum", "arbitrum");
    defer adapter.deinit();

    try adapter.recordProcessed(0);
    try adapter.recordProcessed(7);
    try adapter.recordProcessed(3);
    inline for (.{ .prepared, .submitted, .confirmed, .failed, .dropped }) |phase| try adapter.recordOperation(phase, null);
    try adapter.recordMetadataBuild(.{ .app_context = null, .status = .success, .duration_ns = 1_500_000_000 });
    try adapter.recordMetadataBuild(.{ .app_context = "app", .status = .failure, .duration_ns = 0 });
    try adapter.setQueueLength(.prepare_queue, .FirstPrepareAttempt, null, 0);
    try adapter.setQueueLength(.submit_queue, .ReadyToSubmit, "app", 2);
    try adapter.setQueueLength(.confirm_queue, .{ .Confirm = .SubmittedBySelf }, "app", 1);
    try adapter.setQueueLength(.prepare_queue, .{ .Retry = .Manual }, "app", 4);
    try adapter.setQueueLength(.prepare_queue, .{ .Retry = .{ .ApplicationReport = .ZeroAmount } }, "app", 5);

    const text = try r.render(a);
    defer a.free(text);
    for ([_][]const u8{
        "hyperlane_last_known_message_nonce{phase=\"message_processed\",origin=\"ethereum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 7\n",
        "hyperlane_messages_processed_count{origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 3\n",
        "hyperlane_operations_processed_count{app_context=\"Unknown\",phase=\"prepared\",chain=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_operations_processed_count{app_context=\"Unknown\",phase=\"submitted\",chain=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_operations_processed_count{app_context=\"Unknown\",phase=\"confirmed\",chain=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_operations_processed_count{app_context=\"Unknown\",phase=\"failed\",chain=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_operations_processed_count{app_context=\"Unknown\",phase=\"dropped\",chain=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_metadata_build_count{app_context=\"Unknown\",origin=\"ethereum\",remote=\"arbitrum\",status=\"success\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_metadata_build_duration{app_context=\"Unknown\",origin=\"ethereum\",remote=\"arbitrum\",status=\"success\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1.5\n",
        "hyperlane_metadata_build_count{app_context=\"app\",origin=\"ethereum\",remote=\"arbitrum\",status=\"failure\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_metadata_build_duration{app_context=\"app\",origin=\"ethereum\",remote=\"arbitrum\",status=\"failure\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n",
        "hyperlane_submitter_queue_length{remote=\"arbitrum\",queue_name=\"prepare_queue\",operation_status=\"FirstPrepareAttempt\",app_context=\"Unknown\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n",
        "hyperlane_submitter_queue_length{remote=\"arbitrum\",queue_name=\"submit_queue\",operation_status=\"ReadyToSubmit\",app_context=\"app\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 2\n",
        "hyperlane_submitter_queue_length{remote=\"arbitrum\",queue_name=\"confirm_queue\",operation_status=\"Confirm(Submitted by this relayer)\",app_context=\"app\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_submitter_queue_length{remote=\"arbitrum\",queue_name=\"prepare_queue\",operation_status=\"Retry(Manual retry)\",app_context=\"app\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 4\n",
        "hyperlane_submitter_queue_length{remote=\"arbitrum\",queue_name=\"prepare_queue\",operation_status=\"Retry(ApplicationReport(ZeroAmount))\",app_context=\"app\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 5\n",
    }) |sample| try expectSample(text, sample);
}

test "pending tracker deduplicates references contexts and ordered oldest timestamps" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    const tracker = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 8, .max_bytes = 16 * 1024 });
    defer tracker.deinit();
    const adapter = try relayer_metrics.Adapter.init(a, tracker, "ethereum", "arbitrum");
    defer adapter.deinit();
    const first: [32]u8 = @splat(1);
    const second: [32]u8 = @splat(2);

    try std.testing.expect(try adapter.recordPending(.{ .message_id = first, .app_context = "test-app", .first_seen_unix_seconds = 20 }));
    try std.testing.expect(!try adapter.recordPending(.{ .message_id = first, .app_context = "other-app", .first_seen_unix_seconds = 99 }));
    try std.testing.expect(try adapter.recordPending(.{ .message_id = second, .app_context = "test-app", .first_seen_unix_seconds = 10 }));
    var text = try r.render(a);
    try expectSample(text, "hyperlane_pending_message_active{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 2\n");
    try expectSample(text, "hyperlane_pending_message_oldest_timestamp_seconds{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 10\n");
    try std.testing.expect(std.mem.indexOf(u8, text, "other-app") == null);
    try std.testing.expect(std.mem.indexOf(u8, text, "message_id") == null);
    a.free(text);

    try std.testing.expect(!try adapter.finishPending(first));
    try std.testing.expect(try adapter.finishPending(first));
    try std.testing.expect(try adapter.finishPending(second));
    try std.testing.expect(!try adapter.finishPending(second));
    try std.testing.expect(try adapter.recordPending(.{ .message_id = first, .app_context = "new-app", .first_seen_unix_seconds = 30 }));
    text = try r.render(a);
    defer a.free(text);
    try expectSample(text, "hyperlane_pending_message_active{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n");
    try expectSample(text, "hyperlane_pending_message_oldest_timestamp_seconds{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n");
    try expectSample(text, "hyperlane_pending_message_active{app_context=\"new-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n");
}

test "metadata wait attempts recovery cancellation and wait-only to pending transition match source" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    const tracker = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 8, .max_bytes = 16 * 1024 });
    defer tracker.deinit();
    const adapter = try relayer_metrics.Adapter.init(a, tracker, "ethereum", "arbitrum");
    defer adapter.deinit();
    const first: [32]u8 = @splat(3);
    const second: [32]u8 = @splat(4);

    const initial = try adapter.recordMetadataWait(.{ .message_id = first, .app_context = "test-app", .unix_timestamp_seconds = 20, .monotonic_ms = 100 });
    try std.testing.expect(initial.first_observation);
    try std.testing.expectEqual(@as(u64, 0), initial.elapsed_ms);
    const retry = try adapter.recordMetadataWait(.{ .message_id = first, .app_context = "test-app", .unix_timestamp_seconds = 99, .monotonic_ms = 150 });
    try std.testing.expect(!retry.first_observation);
    try std.testing.expectEqual(@as(u64, 50), retry.elapsed_ms);
    _ = try adapter.recordMetadataWait(.{ .message_id = second, .app_context = "test-app", .unix_timestamp_seconds = 10, .monotonic_ms = 160 });
    try std.testing.expectEqual(@as(usize, 2), tracker.activeCount());
    try std.testing.expectEqual(@as(?u64, 100), try adapter.finishMetadataWait(first, .recovered, 200));
    try std.testing.expectEqual(@as(?u64, 10), try adapter.finishMetadataWait(second, .cancelled, 170));
    try std.testing.expectEqual(@as(?u64, null), try adapter.finishMetadataWait(second, .ended, 999));
    try std.testing.expectEqual(@as(usize, 0), tracker.activeCount());

    const wait_only = try adapter.recordMetadataWait(.{ .message_id = first, .app_context = null, .unix_timestamp_seconds = std.math.maxInt(u64), .monotonic_ms = 300 });
    try std.testing.expect(wait_only.first_observation);
    try std.testing.expectEqual(@as(?u64, 20), try adapter.finishMetadataWait(first, .ended, 320));
    try std.testing.expect(try adapter.recordPending(.{ .message_id = first, .app_context = null, .first_seen_unix_seconds = 40 }));

    const text = try r.render(a);
    defer a.free(text);
    for ([_][]const u8{
        "hyperlane_metadata_wait_event_count{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",event=\"wait\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 3\n",
        "hyperlane_metadata_wait_event_count{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",event=\"recovered\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_metadata_wait_event_count{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",event=\"ended\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_metadata_wait_active{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n",
        "hyperlane_metadata_wait_oldest_timestamp_seconds{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n",
        "hyperlane_pending_message_active{app_context=\"Unknown\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n",
        "hyperlane_pending_message_oldest_timestamp_seconds{app_context=\"Unknown\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 40\n",
    }) |sample| try expectSample(text, sample);
    try std.testing.expect(std.mem.indexOf(u8, text, "message_id") == null);
}

test "role tracker owns labels bounds entries and shares pending with waits" {
    const a = std.testing.allocator;
    const r = try registry(a);
    defer r.deinit();
    const tracker = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 1, .max_bytes = 16 * 1024, .max_label_bytes = 32 });
    defer tracker.deinit();
    const origin = try a.dupe(u8, "ethereum");
    defer a.free(origin);
    const remote = try a.dupe(u8, "arbitrum");
    defer a.free(remote);
    const adapter = try relayer_metrics.Adapter.init(a, tracker, origin, remote);
    defer adapter.deinit();
    const context = try a.dupe(u8, "test-app");
    defer a.free(context);
    const first: [32]u8 = @splat(5);
    const second: [32]u8 = @splat(6);

    try std.testing.expect(try adapter.recordPending(.{ .message_id = first, .app_context = context, .first_seen_unix_seconds = 20 }));
    try std.testing.expectError(error.MetricTrackerLimit, adapter.recordPending(.{ .message_id = second, .app_context = context, .first_seen_unix_seconds = 10 }));
    _ = try adapter.recordMetadataWait(.{ .message_id = first, .app_context = context, .unix_timestamp_seconds = 20, .monotonic_ms = 100 });
    try std.testing.expectEqual(@as(usize, 1), tracker.activeCount());
    @memset(origin, 'x');
    @memset(remote, 'x');
    @memset(context, 'x');
    try std.testing.expect(try adapter.finishPending(first));
    try std.testing.expectEqual(@as(usize, 1), tracker.activeCount());
    try std.testing.expectEqual(@as(?u64, 50), try adapter.finishMetadataWait(first, .ended, 150));
    try std.testing.expectEqual(@as(usize, 0), tracker.activeCount());
    try std.testing.expectEqual(@as(usize, 0), tracker.retainedBytes());
    try std.testing.expect(try adapter.recordPending(.{ .message_id = second, .app_context = null, .first_seen_unix_seconds = 10 }));

    const text = try r.render(a);
    defer a.free(text);
    try expectSample(text, "hyperlane_pending_message_active{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 0\n");
    try expectSample(text, "hyperlane_metadata_wait_event_count{app_context=\"test-app\",origin=\"ethereum\",remote=\"arbitrum\",event=\"ended\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n");
    try std.testing.expect(std.mem.indexOf(u8, text, "xxxxxxxx") == null);

    const tiny = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 1, .max_bytes = 1 });
    defer tiny.deinit();
    const tiny_adapter = try relayer_metrics.Adapter.init(a, tiny, "ethereum", "arbitrum");
    defer tiny_adapter.deinit();
    try std.testing.expectError(error.MetricTrackerLimit, tiny_adapter.recordPending(.{ .message_id = first, .app_context = null, .first_seen_unix_seconds = 1 }));
    const narrow = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 1, .max_bytes = 1024, .max_label_bytes = 2 });
    defer narrow.deinit();
    try std.testing.expectError(error.InvalidMetricLabel, relayer_metrics.Adapter.init(a, narrow, "ethereum", "arbitrum"));
}

test "relayer adapters release entries and registry labels on every allocation failure" {
    const Sweep = struct {
        fn run(a: A) !void {
            const r = try registry(a);
            defer r.deinit();
            const tracker = try relayer_metrics.WaitTracker.init(a, r, .{ .max_active = 4, .max_bytes = 4096 });
            defer tracker.deinit();
            const adapter = try relayer_metrics.Adapter.init(a, tracker, "ethereum", "arbitrum");
            defer adapter.deinit();
            const id: [32]u8 = @splat(7);
            _ = try adapter.recordPending(.{ .message_id = id, .app_context = "test-app", .first_seen_unix_seconds = 20 });
            _ = try adapter.recordMetadataWait(.{ .message_id = id, .app_context = "test-app", .unix_timestamp_seconds = 20, .monotonic_ms = 100 });
            _ = try adapter.finishPending(id);
            _ = try adapter.finishMetadataWait(id, .recovered, 150);
            try adapter.recordProcessed(9);
            try adapter.recordOperation(.prepared, "test-app");
            try adapter.recordMetadataBuild(.{ .app_context = "test-app", .status = .success, .duration_ns = 100 });
            try adapter.setQueueLength(.prepare_queue, .{ .Retry = .CouldNotFetchMetadata }, "test-app", 1);
            const text = try r.render(a);
            defer a.free(text);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Sweep.run, .{});
}

test {
    _ = @import("ops/metrics.zig");
    _ = @import("ops/lander_metrics.zig");
    _ = @import("ops/relayer_metrics.zig");
}
