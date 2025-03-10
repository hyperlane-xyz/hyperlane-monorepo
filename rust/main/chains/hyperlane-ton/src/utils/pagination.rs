use hyperlane_core::ChainResult;

use crate::{message::Message, TonProvider};

pub async fn paginate_logs<T, F>(
    provider: &TonProvider,
    address: &str,
    start_utime: i64,
    end_utime: i64,
    limit: u32,
    offset: u32,
    mut parse_fn: F,
) -> ChainResult<Vec<T>>
where
    F: FnMut(Message) -> Option<T> + Send,
{
    let mut results = Vec::new();
    let mut current_offset = offset;

    loop {
        let response = provider
            .get_logs(address, start_utime, end_utime, limit, current_offset)
            .await?;
        let batch_size = response.messages.len();
        for msg in response.messages {
            if let Some(parsed) = parse_fn(msg) {
                results.push(parsed);
            }
        }
        current_offset += batch_size as u32;
        if batch_size < limit as usize {
            break;
        }
    }
    Ok(results)
}
