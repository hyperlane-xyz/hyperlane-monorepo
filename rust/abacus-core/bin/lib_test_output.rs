#[cfg(feature = "output")]
use abacus_core::test_output::output_functions::*;

fn main() {
    #[cfg(feature = "output")]
    {
        output_signed_checkpoints();
        output_message_and_leaf();
    }
}
