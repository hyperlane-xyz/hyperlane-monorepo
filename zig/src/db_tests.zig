test {
    _ = @import("agents/indexing/native_test.zig");
    _ = @import("agents/indexing/cooperative_native_test.zig");
    _ = @import("agents/indexing/cosmos_native_test.zig");
    _ = @import("agents/scraper/aleo_cooperative_test.zig");
    _ = @import("agents/scraper/testing.zig");
    _ = @import("agents/scraper/task.zig");
    _ = @import("db/native_test.zig");
    _ = @import("agents/store_test.zig");
    _ = @import("agents/validator/test.zig");
    _ = @import("agents/validator/concurrent_test.zig");
    _ = @import("agents/origin_test.zig");
    _ = @import("agents/operation_test.zig");
    _ = @import("agents/payload_links_test.zig");
    _ = @import("agents/origin_tasks_test.zig");
    _ = @import("agents/destination/operation_test.zig");
    _ = @import("lander/tests.zig");
    _ = @import("lander/http_tests.zig");
    _ = @import("lander/anvil_tests.zig");
    _ = @import("evm/eip2930.zig");
}

test {
    _ = @import("agents/validator_task_test.zig");
    _ = @import("agents/validator/fetch_backoff_native_test.zig");
    _ = @import("agents/validator/mailbox_native_test.zig");
}

test {
    _ = @import("relayer_reservation_native_test.zig");
    _ = @import("retained_halt_tests.zig");
    _ = @import("relayer_halt_tests.zig");
}

// Runtime pipeline regressions must run under native-db-test, not only via
// delegated development entrypoints.
test {
    _ = @import("agents/relayer/evm_accounting_test.zig");
    _ = @import("agents/relayer/evm_driver_test.zig");
    _ = @import("evm_prepare_delegated_tests.zig");
    _ = @import("agents/relayer/native_driver_test.zig");
    _ = @import("agents/destination/source_metadata_svm_test.zig");
    _ = @import("agents/relayer/ccip_sessions_test.zig");
    _ = @import("agents/relayer/ccs_signer_test.zig");
    _ = @import("agents/relayer/control_test.zig");
    _ = @import("agents/relayer/public_relay_test.zig");
    _ = @import("agents/relayer/public_server.zig");
    _ = @import("agents/stream/relayer_test.zig");
    _ = @import("agents/stream/relayer_store.zig");
    _ = @import("agents/stream/relayer_bridge.zig");
    _ = @import("agent_metrics_tests.zig");
    _ = @import("agents/process_clock.zig");
}

test {
    _ = @import("cache_metrics_tests.zig");
    _ = @import("health_metrics_tests.zig");
    _ = @import("ops/init_metrics.zig");
    _ = @import("critical_metrics_tests.zig");
    _ = @import("app_context_tests.zig");
    _ = @import("public_identity_tests.zig");
}

test {
    _ = @import("agents/indexing/tx_id_native_test.zig");
    _ = @import("transaction_adapter_native_tests.zig");
}

// Shared native account submission ownership and cold sender recovery use real
// RocksDB; keep these regressions outside the libc-only default aggregate.
test {
    _ = @import("native_group_tests.zig");
    _ = @import("agents/destination/group_guard_native_test.zig");
    _ = @import("starknet_group_control_native_test.zig");
    _ = @import("native_sender_recovery_test.zig");
    _ = @import("shared_remote_signer_timeout_tests.zig");
    _ = @import("optional_ccs_tests.zig");
    _ = @import("validator_metadata_native_tests.zig");
    _ = @import("url_host_tests.zig");
    _ = @import("configured_rpc_transport_tests.zig");
    _ = @import("configured_rpc_producer_tests.zig");
    _ = @import("configured_cosmos_absence_tests.zig");
    _ = @import("configured_svm_unavailable_tests.zig");
    _ = @import("starknet_chain_id_tests.zig");
    _ = @import("starknet/testing.zig");
    _ = @import("radix/testing.zig");
    _ = @import("svm_scraper_log_index_tests.zig");
    _ = @import("cosmos_compat_default_tests.zig");
}

// Shared announcement replay ownership must be covered by native-db-test.
test {
    _ = @import("announcement_replay_owner_tests.zig");
}

// Existing Rust-derived settings golden cases must run in the native CI suite.
test {
    _ = @import("settings_tests.zig");
}
