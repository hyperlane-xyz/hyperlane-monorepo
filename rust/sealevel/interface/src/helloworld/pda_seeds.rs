//! PDA seeds for the HelloWorld program.

/// Seeds relating to the PDA account with program data.
#[macro_export]
macro_rules! program_storage_pda_seeds {
    () => {{
        &[b"hello_world", b"-", b"handle", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hello_world",
            b"-",
            b"handle",
            b"-",
            b"storage",
            &[$bump_seed],
        ]
    }};
}
