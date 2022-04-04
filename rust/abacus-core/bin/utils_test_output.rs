#[cfg(feature = "output")]
use abacus_core::test_output::output_functions::*;

fn main() {
    #[cfg(feature = "output")]
    {
        output_domain_hashes();
        output_destination_and_nonces();
    }
}
