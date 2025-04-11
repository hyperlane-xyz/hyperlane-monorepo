use eyre::Context;
use tracing::debug;

use hyperlane_base::cache::{FunctionCallCache, OptionalCache};
use hyperlane_core::{ValidatorAnnounce, H256};

/// Helper function to fetch storage locations for validators.
/// This function is independent of `BaseMetadataBuilder` and can be tested separately.
pub async fn fetch_storage_locations_helper(
    validators: &[H256],
    cache: &OptionalCache<impl FunctionCallCache>,
    validator_announce: &dyn ValidatorAnnounce,
) -> eyre::Result<Vec<Vec<String>>> {
    const CTX: &str = "When fetching storage locations";
    const DOMAIN_NAME: &str = "";
    const METHOD_NAME: &str = "get_announced_storage_locations";

    let cache_key = format!("storage_locations:{:?}", validators);

    // Attempt to retrieve from cache
    if let Some(cached) = cache
        .get_cached_call_result::<Vec<Vec<String>>>(DOMAIN_NAME, METHOD_NAME, &cache_key)
        .await?
    {
        debug!(?validators, "Cache hit for storage locations");
        return Ok(cached);
    }

    // Fetch from validator_announce if not cached
    let storage_locations = validator_announce
        .get_announced_storage_locations(validators)
        .await
        .context(CTX)?;

    // Store in cache
    cache
        .cache_call_result(DOMAIN_NAME, METHOD_NAME, &cache_key, &storage_locations)
        .await?;

    Ok(storage_locations)
}
