use fuels::macros::abigen;

abigen!(
    Contract(
        name = "AggregationISM",
        abi = "utils/run-locally/src/fuel/fuel-contracts/aggregation-ism-abi.json",
    ),
    Contract(
        name = "DomainRoutingISM",
        abi = "utils/run-locally/src/fuel/fuel-contracts/domain-routing-ism-abi.json",
    ),
    Contract(
        name = "FallbackDomainRoutingHook",
        abi = "utils/run-locally/src/fuel/fuel-contracts/fallback-domain-routing-hook-abi.json",
    ),
    Contract(
        name = "GasOracle",
        abi = "utils/run-locally/src/fuel/fuel-contracts/gas-oracle-abi.json",
    ),
    Contract(
        name = "GasPaymaster",
        abi = "utils/run-locally/src/fuel/fuel-contracts/gas-paymaster-abi.json",
    ),
    Contract(
        name = "PausableISM",
        abi = "utils/run-locally/src/fuel/fuel-contracts/pausable-ism-abi.json",
    ),
    Contract(
        name = "Mailbox",
        abi = "utils/run-locally/src/fuel/fuel-contracts/mailbox-abi.json",
    ),
    Contract(
        name = "MessageIdMultisigISM",
        abi = "utils/run-locally/src/fuel/fuel-contracts/message-id-multisig-ism-abi.json",
    ),
    Contract(
        name = "MerkleTreeHook",
        abi = "utils/run-locally/src/fuel/fuel-contracts/merkle-tree-hook-abi.json",
    ),
    Contract(
        name = "MsgRecipientTest",
        abi = "utils/run-locally/src/fuel/fuel-contracts/msg-recipient-test-abi.json",
    ),
    Contract(
        name = "ValidatorAnnounce",
        abi = "utils/run-locally/src/fuel/fuel-contracts/validator-announce-abi.json",
    ),
);
