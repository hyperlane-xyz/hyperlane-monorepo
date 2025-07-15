pub use escalator::escalate_gas_price_if_needed;
pub use estimator::estimate_gas_price;
pub use price::{extract_gas_price, GasPrice};

mod escalator;
mod estimator;
mod price;
