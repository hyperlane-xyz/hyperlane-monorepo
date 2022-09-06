const RELAY_URL: &str = "https://relay.gelato.digital";

pub mod chains;
pub mod err;
pub mod sponsored_call;
pub mod task_status_call;

#[cfg(test)]
pub mod test_data;
