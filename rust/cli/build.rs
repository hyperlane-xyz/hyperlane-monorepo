// https://crates.io/crates/ethers-solc

use std::path::Path;

use color_eyre::Result;
use ethers_contract_abigen::Abigen;

fn main() -> Result<()> {
    color_eyre::install()?;

    let manifest_dir = Path::new(&env!("CARGO_MANIFEST_DIR"));
    println!("CARGO_MANIFEST_DIR: {:#?}", manifest_dir);

    let contract_base_dir = manifest_dir
        .parent()
        .expect("Failed to get parent dir")
        .parent()
        .expect("Failed to get parent dir")
        .join("solidity/artifacts/contracts");
    let code_dir = manifest_dir.join("src/contracts");

    // Might be a cleaner way to do this using MultiAbigen.
    // See: https://docs.rs/ethers-contract-abigen/latest/ethers_contract_abigen/multi/struct.MultiAbigen.html
    for (contract, source, code_file) in [
        ("Mailbox", "Mailbox.sol/Mailbox.json", "mailbox.rs"),
        (
            "MockMailbox",
            "mock/MockMailbox.sol/MockMailbox.json",
            "mock_mailbox.rs",
        ),
        (
            "MockHyperlaneEnvironment",
            "mock/MockHyperlaneEnvironment.sol/MockHyperlaneEnvironment.json",
            "mock_hyperlane_environment.rs",
        ),
        (
            "TestRecipient",
            "test/TestRecipient.sol/TestRecipient.json",
            "test_recipient.rs",
        ),
        (
            "InterchainGasPaymaster",
            "igps/InterchainGasPaymaster.sol/InterchainGasPaymaster.json",
            "interchain_gas_paymaster.rs",
        ),
    ] {
        let contract_path = contract_base_dir.join(source);
        let code_path = code_dir.join(code_file);

        println!("Contract path: {:?}", contract_path);

        let abigen = Abigen::new(contract, &contract_path.to_string_lossy())?;

        let contract = abigen.generate()?;

        contract.write_to_file(&code_path)?;
    }

    Ok(())
}
