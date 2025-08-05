use eyre::Context;

use hyperlane_base::cache::FunctionCallCache;
use hyperlane_core::{ValidatorAnnounce, H256};

const METHOD_NAME: &str = "get_announced_storage_locations";

/// Helper function to fetch storage locations for validators.
pub async fn fetch_storage_locations_helper(
    validators: &[H256],
    cache: &impl FunctionCallCache,
    validator_announce: &dyn ValidatorAnnounce,
) -> eyre::Result<Vec<Vec<String>>> {
    const CTX: &str = "When fetching storage locations";

    let origin = validator_announce.domain().name(); // Dynamically fetch domain name

    let mut storage_locations = Vec::new();
    let mut missing_validators = Vec::new();

    for (index, validator) in validators.iter().enumerate() {
        let key = generate_cache_key(validator);

        // Attempt to retrieve from cache
        if let Some(cached) = cache
            .get_cached_call_result::<Vec<String>>(origin, METHOD_NAME, &key)
            .await?
        {
            storage_locations.push(cached);
        } else {
            missing_validators.push((index, *validator));
            storage_locations.push(Vec::new()); // Placeholder for missing validator
        }
    }

    if missing_validators.is_empty() {
        // Cache contains storage locations for all validators
        return Ok(storage_locations);
    }

    // Fetch from validator_announce for missing validators
    let fetched_locations = validator_announce
        .get_announced_storage_locations(
            &missing_validators
                .iter()
                .map(|(_, v)| *v)
                .collect::<Vec<_>>(),
        )
        .await
        .context(CTX)?;

    for (fetched_index, (index, validator)) in missing_validators.iter().enumerate() {
        let key = generate_cache_key(validator);
        let locations = &fetched_locations[fetched_index];

        // Store in cache
        cache
            .cache_call_result(origin, METHOD_NAME, &key, locations)
            .await?;

        // Update the placeholder in storage_locations
        storage_locations[*index] = locations.clone();
    }

    Ok(storage_locations)
}

/// Generates a cache key for a given validator.
fn generate_cache_key(validator: &H256) -> String {
    format!("storage_location:{:?}", validator)
}

#[cfg(test)]
mod tests;
