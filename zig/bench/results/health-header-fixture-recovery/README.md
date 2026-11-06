# Health fixture recovery

**44/44 passed**, zero skips/failures, full development SDK environment from `/tmp/ziggy-global-checks.py`, actual native curl and available Aleo crypto/VM worker. Four recorded health Source/test files unchanged during acceptance. This is focused functional evidence; the parent owns subsequent default/native/PG/global acceptance.

Only `agents/health_set_test.zig` and `agents/health_provider_test.zig` changed. Their Ethereum block fixtures omitted `hash`, `parentHash`, and `timestamp`. The strict header DTO correctly rejected them and caused Pool retries, changing exact request counts and suppressing samples. Fixtures now provide valid mined headers; all original exact request, fee, null-block, metric, identity and cleanup assertions remain.

The shared-runtime test also omitted cleanup if an assertion failed before its explicit success-path shutdown. Immediate deferred Set and Supervisor teardown now stop/join before provider/runtime/Registry destruction. A new regression deliberately returns an error with a genuine suspended fourth loopback request and verifies clean error unwind under the testing allocator. No production health cleanup bug was found; production ownership already documents Supervisor stop/join before Set deinit.

- `command.json.gz`, `result.json.gz`, `tests.log.gz`: lossless accepted run.
- `manifest.json.gz`: exact source hashes and artifact digests.
- Historical first focused failure and curl-only42-pass/2-skip logs retained separately.
- Original global failure remains unchanged at `../global-source-candidate-20261106T0727/default.log`.
