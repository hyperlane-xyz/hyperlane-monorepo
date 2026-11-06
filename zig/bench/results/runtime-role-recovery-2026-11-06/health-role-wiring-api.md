# Role health/cache/validator-observation wiring (owned implementation stable)

NEW agents/health_set.zig: Set.open(a, configured, environment, registry, base_descriptors, Options{source:chain_source.Options,wallets:?Wallets=null}) returns heap-stable set; descriptors() contains copies of base tasks then one common monitor per applicable configured chain. Validator always selects origin only and ignores any wallet resolver. Settings.chains is already filtered to configured relay/scrape chain selection. Each provider opens from immutable settings with no signer/key/network work. Providers own independent mutable query state. Relayer/scraper pass existing shared HTTP runtime/read budget; validator uses one bounded HealthSet-owned runtime (8 concurrent/8 pending/8 sessions,64MiB aggregate reservation) and role-local read budget. Per-chain RPC pools are bounded default2; health has no metadata concurrency grant.

Lifecycle service_main: role owner -> health set -> Supervisor; unwind reverses Supervisor join -> health task/provider/read journals -> role runtime/lanes -> Registry -> settings. Health descriptor arrays remain alive through join. Supervise stop/drain already cancels all common-monitor stop callbacks; HealthSet deinit closes providers after monitors. No monitor is destroyed while a worker can still access it.

NEW PublicWallet embedded in each stable relayer Lane: publish(public_text) copies bounded256 bytes under mutex; interface() returns WalletSource.load_into_fn which copies under same mutex into caller buffer. It never reads Lane.resources, signer/key state, or performs I/O. Lane.ensure publishes only after successful actual network/signer/destination initialization+refresh. Factory.publicWalletInto formats initialized backend public identities: SVM payer base58; Cosmos canonical existing signer_address; Radix Ed25519 public-key preallocated account encoded for actual network; Tron existing signer's Base58Check address; Starknet account felt hex; Aleo actual native Crypto.addressText. Ethereum actual digest signer address lowercase0x. No fabricated transaction hash/public identity.

Cache adapter embedded in stable TaskSet and installed once into both existing cache Options, .evm/.native. Registry remains alive through both cache retirement callbacks. Permanent default/native roots import cache_metrics_tests.zig and health_metrics_tests.zig.

Validator-observation manager embedded optional in TaskSet, Active optional per stable Lane; resolve domains from immutable configured names. UTC milliseconds sampled without signer/network for Source180s grace. Driver.Callbacks.observation now forwards to EVMPreparer; nativeFactory.Options.observation forwards into Source and cached/uncached Builder with actual appContext or Source Unknown. Manager teardown follows destination workers and metadata executor drain.

Configured scraper wallets now use one lazy public_identity.Resolver per configured signer. Construction performs no key/credential/network work. The first supervised begin prepares public identity before CommonMonitor snapshots the wallet; per-cycle snapshot state survives PIO. Local identity uses existing public-address primitives; AWS/GCP public-key initialization uses one bounded auth-only curl transport, no pool/thread, and retires it plus temporary signer/credentials Manager after success. Validator never constructs a resolver. Relayer keeps actual existing lane signer publication. Actual Aleo identity uses the existing isolated SDK key_address worker without proving/parameter load. Public fixture/mock tests only; no production keys read.

## Actual initialization boundaries installed

Each Lane owns optional stable `initialization_metrics: ops/init_metrics.Adapter`.
`mailbox`: one existing `Resources.open` + `network.source` shared contract-client/mailbox Source factory construction/identity check. Its timer survives PendingReadIo and is discarded on an ordinary failed attempt; successful component marks reported once. This is a shared native client factory boundary, not three copies of one elapsed time.
`dispatcher_and_entrypoint`: actual first Lander.Service.open, only if configured submitter=Lander; timer survives retained pending, no classic/native sample.
`ccip_signers`: actual configured chain.signer DigestSigner.open on Ethereum, or actual native Tron digest signer open. Source destination.rs130–154 checks Ethereum|Tron and chain_conf.signer, NOT ccs_signer. Completed failed signer builds also report actual elapsed, preserving the original error. No label for unsupported VMs or missing configured signer. Native Factory.Options.initialization_observer is default-null.
`application_operation_verifier`: no distinct persistent constructor exists in this Zig architecture; no sample invented from composite Factory.open. Current verification is typed provider/prepare policy operations. This entity remains explicit N/A until a real equivalent constructor exists.

Gas enforcer: Control.ensurePolicy now times the actual pure RulesLedger.buildPolicy constructor only on successful null→Policy transition; default-null optional lane callback preserves generic fake lanes. Direct reprocess constructor now uses the existing ensurePolicy helper. Actual Lane callback calls OriginSlot.observeGasEnforcer, whose per-origin atomic first-wins prevents later destination policy construction overwriting Source's origin gauge. Admin policy replacements are not initialization samples. A failed Policy allocation emits no sample; retry and repeated ensure are tested through the real production Registry.

Critical-error family was deliberately not assigned fake startup zeros here. Actual Rust validator false is after successful hook-sync construction (validator.rs823), true after exhausted attempts827; scraper false is after successful start_chain (agent.rs189), with true on failed setup. These lifecycle owners require exact callbacks, not common-monitor RPC failure or generic descriptor construction. Parent owns any separate Source-correct critical state changes.

## Updated: per-chain provider construction is lazy and isolated

Set allocates one stable Node per monitor. CommonMonitor.Provider.begin constructs its Adapter once from immutable settings/options on the existing supervised worker; constructor errors affect that chain's task, not Role open or healthy sibling monitors. Stop always targets the preallocated CommonMonitor atomic; no mutable lazy adapter pointer is read by a cancellation owner. Node.end/deinit tolerate a never-created adapter. Role allocation/OOM still propagates normally.

Relayer stable shared critical trackers live in TaskSet (one per configured chain). healthCriticals() resolves the SAME tracker used by destination/origin owners. Node records destination_metrics only on actual provider-constructor failure and clears only that reason after actual successful construction. Ordinary balance/head RPC failures never touch critical state. Common monitor supervised constructor retries are an intentional availability difference from Rust relayer's startup skip, until exact Source retry policy is separately selected; there is no fake success sample.

## Dynamic-tip cache ownership

Relayer TaskSet owns one bounded shared net/dynamic_tip_cache.Cache, enabled only by indexingSourceOptions used for origins.Set. Public sourceOptions and destinationOptions remain indexer_tip_cache=false, including origin signer discovery, delivery, metadata and health. Scraper owns one shared cache enabled only for actual head-indexing lane Resources; receipt/enrichment/reconciliation/CCR are fresh. Both caches deinitialize after every role resource/client/replay/Pool drains. health_provider additionally forces the flag false even if caller supplies indexing options; the retained-health regression passes an enabled cache and still expects both startup head reads as physical requests.

## Additional always-on cache

Default-ISM Root caches and forwards are documented separately at /tmp/ziggy-default-ism-role-cache-api.md. They are independent of the two metered contract partitions and the 250ms provider-tip cache. Metadata owner must finish the classification/getter callee API before final current-head compile.

## Verification

Current final logs and source hashes are archived with the runtime role recovery report. Full health suite42/42 and permanent role/cache/capacity/constructor integration44/44 passed; actual local/remote scraper first-wallet paths each8/8. Native explicit-app metadata cache/current source test14/14 passed. All three actual service_main roles compiled ReleaseSafe with -fno-emit-bin after the operational telemetry fix. These are correctness checks, not benchmark results. External metadata owner work remains separately gated; no final Source-complete claim.

## Root validator-observation capacity

Root configures Manager.max_contexts from checked configured_chains² × (metric_app_contexts.len+2 for default_ism/Unknown), capped at existing Registry.max_series. Label budget derives from that context bound × (2×longest configured chain name + longest configured/default app name), capped by Registry.max_storage_bytes. No route-map preallocation. The finite registry/validator limits still apply; best-effort failures remain diagnostic and never fail metadata. A production-Registry regression sends 300 real route observations (18 configured chains), proving valid contexts continue past the former fixed256 lifetime ceiling.

## Optional operational telemetry liveness

Production Lane callbacks catch Registry series/storage/allocator failures, tracker budget errors, and optional clock/timer failures, count each in telemetry_failures and log only the first. Pure Adapter/MetadataObserver interfaces remain fallible. DB reads, policy, canonical authorization, driver/control/security and I/O errors retain their original propagation. No broad error classifier swallows arbitrary operation errors.

Completed actor retirement calls Lane.releaseCompleted after durable advance success, drains pending/wait refs and resets timers even when registry updates fail, then releases loader/core bytes/actor exactly once. Core admission allocations still roll back on failure. Optional app label storage cannot reject an otherwise admitted message; failed labels disable only that actor's operational telemetry. Metadata pending/error outcomes are unchanged. Production callback success cannot convert successful metadata to retry.
