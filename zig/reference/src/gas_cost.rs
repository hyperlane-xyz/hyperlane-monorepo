use hyperlane_core::{gas_used_by_operation, FixedPointNumber, TxOutcome, H512, U256};

fn outcome(gas_used: U256) -> TxOutcome {
    TxOutcome {
        transaction_id: H512::zero(),
        executed: true,
        gas_used,
        gas_price: FixedPointNumber::from(1),
    }
}

fn main() {
    let cases = [
        (
            U256::from(1_000_000u64),
            U256::from(333_333u64),
            U256::from(1_000_000u64),
        ),
        (
            U256::from(21_000u64),
            U256::from(100u64),
            U256::from(300u64),
        ),
        (U256::from(44u64), U256::from(100u64), U256::zero()),
        (U256::from(51u64), U256::zero(), U256::from(100u64)),
        (U256::MAX, U256::MAX, U256::from(1u64)),
    ];
    for (actual, operation, submission) in cases {
        let gas = gas_used_by_operation(&outcome(actual), submission, operation).unwrap_or(actual);
        println!("{actual} {operation} {submission} {gas}");
    }
}
