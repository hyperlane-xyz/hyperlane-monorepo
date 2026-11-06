# EVM Driver default-ISM fixture recovery

**442/442 passed**, zero skips/failures/leaks, ReleaseSafe using actual RocksDB/native HTTP and available development SDKs. Includes34 EVM Driver lifecycle cases and4 accounting cases. Six recorded Source/test hashes unchanged across acceptance and current readback. Only `zig/src/agents/relayer/evm_driver_test.zig` changed; no production change.

The broad native DB run failed preparation because `readySteps()` omitted the now-required mailbox default-ISM read. Strict root classification always queries `defaultIsm()` when no explicit context is configured, before querying `moduleType()`. The old fixture supplied its moduleType word to defaultIsm; the subsequent actual moduleType eth_call then encountered expected eth_estimateGas. The Driver correctly returned a metadata retry, causing prepared-state assertions to fail. One test subsequently unwrapped its missing payload and panicked.

The focused negative reproduction records the exact underlying fixture error: `fixture RPC step7: expected eth_estimateGas, got eth_call`. Independent baseline source readback confirmed the same chain. Header DTOs, caller clocks and fallback budgets were not the cause.

Correction: the ready sequence now has9 calls, including an actual defaultIsm response between recipientIsm and moduleType. Selector assertions distinguish all three calls, preventing an extra eth_call from consuming a semantically wrong fixture response. Existing request exhaustion, cancellation, DB restart, nonce, fee, relation and600-second confirmation assertions remain. Fresh-preparation test helpers additionally assert prepared state and non-null payload before unwrap so a failed precondition unwinds runtime/DB defers instead of crashing. Failure-only method diagnostics show exact fixture method mismatch.

An initial unfiltered run passed all Driver/accounting cases but failed3 unrelated opt-in RSA tests because the test environment enabled OpenSSL without supplying HYPERLANE_TEST_RSA_FIXTURE_DIR. The accepted run uses the existing Node RSA generator and loopback HTTP/2 gRPC fixture, matching normal helper setup, alongside the full explicit dev SDK environment. All442 cases executed. Temporary generated RSA files and servers were retired afterward; no key material is retained in artifacts. Parent owns correcting the global runner's environment/setup.

Accepted exact command/environment/setup, result, raw log, setup runner and complete SHA strings are lossless gzip files. Historical missing-default-call and missing-RSA-environment logs are preserved separately. Original broad failure remains untouched at `../global-source-final-20261106T0853-safe/native-db.log`.

This is delegated functional acceptance, not the parent's full native/global/cold SDK/container or benchmark acceptance. No tests or skips were disabled to pass.
