# Always-on unmetered default ISM cache wiring

Root TaskSet fields evm_default_ism_cache (20-byte address family) and native_default_ism_cache (32-byte family), both always enabled regardless of allow_contract_call_caching; observer=null, fixed Source default_ism TTL600000ms, no environment override for that TTL. Both have max_entries=configured.chains.len; independent retained native byte budget=sum(chain.name.len+256), sufficient for each actual typed default key/address and bounded to configured chain count. Existing 8MiB metered cache partitions unchanged.

Driver.Config.default_ism_cache:?*contract_cache.Cache forwards to EVMPreparer.default_ism_cache. Factory.Options.default_ism_cache:?*CacheFor([32]u8).Cache forwards to Source.Options.default_ism_cache and CachedSource.Options.default_ism_cache. Metadata owner provides those callee fields and actual Source classification/getter; Factory will set actual resolved root context before cached/uncached Builder after method API handoff.

Root default caches initialized before supervised users, destroyed only after destination workers, metadata executor and native factories drain. Neither cache has an observer; default_ism requests never emit Source cache metric families. Error cleanup owns each cache exactly after successful init. No signing/key/provider threads are created by these caches.
