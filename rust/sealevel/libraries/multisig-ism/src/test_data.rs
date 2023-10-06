//! Gated on the "test-data" feature.
//! Useful for use in unit & integration tests, which can't import from
//! each other.

use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneMessage, H160, H256};
use std::str::FromStr;

pub struct MultisigIsmTestData {
    pub message: HyperlaneMessage,
    pub checkpoint: CheckpointWithMessageId,
    pub validators: Vec<H160>,
    pub signatures: Vec<Vec<u8>>,
}

const ORIGIN_DOMAIN: u32 = 1234u32;
const DESTINATION_DOMAIN: u32 = 4321u32;

pub fn get_multisig_ism_test_data() -> MultisigIsmTestData {
    let message = HyperlaneMessage {
        version: 0,
        nonce: 69,
        origin: ORIGIN_DOMAIN,
        sender: H256::from_str(
            "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
        )
        .unwrap(),
        destination: DESTINATION_DOMAIN,
        recipient: H256::from_str(
            "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
        )
        .unwrap(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    };

    let checkpoint = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: ORIGIN_DOMAIN,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: 69,
        },
        message_id: message.id(),
    };

    // checkpoint.signing_hash() is equal to:
    // 0x4fc33ff33d5e9305a2d87f7824d1b943ba219cff4c153ae8fd39b0d8620fc332

    // Validator 0:
    // Address: 0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D
    // Private Key: 0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091
    let validator_0 = H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap();
    // > await (new ethers.Wallet('0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091')).signMessage(ethers.utils.arrayify('0x4fc33ff33d5e9305a2d87f7824d1b943ba219cff4c153ae8fd39b0d8620fc332'))
    // '0x3a06cc01fef07025ee5ae9e29ae783338fe11f5c21af383fb8cc5878a2ea3616125c230ec07b059eaebb842af0a51040ad3214f9050cccef36b5c21c9c9cc4ba1b'
    let signature_0 = hex::decode("3a06cc01fef07025ee5ae9e29ae783338fe11f5c21af383fb8cc5878a2ea3616125c230ec07b059eaebb842af0a51040ad3214f9050cccef36b5c21c9c9cc4ba1b").unwrap();

    // Validator 1:
    // Address: 0xb25206874C24733F05CC0dD11924724A8E7175bd
    // Private Key: 0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e
    let validator_1 = H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap();
    // > await (new ethers.Wallet('0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e')).signMessage(ethers.utils.arrayify('0x4fc33ff33d5e9305a2d87f7824d1b943ba219cff4c153ae8fd39b0d8620fc332'))
    // '0xfd34aac152ec85a79211c990f308c7e719145e2e67e48f2d10db4347d3a9102131254eccbcd0fe389afad96b88d368192b33649336893dfe1bbad43901d1bef71b'
    let signature_1 = hex::decode("fd34aac152ec85a79211c990f308c7e719145e2e67e48f2d10db4347d3a9102131254eccbcd0fe389afad96b88d368192b33649336893dfe1bbad43901d1bef71b").unwrap();

    // Validator 2:
    // Address: 0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3
    // Private Key: 0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515
    let validator_2 = H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap();
    // > await (new ethers.Wallet('0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515')).signMessage(ethers.utils.arrayify('0x4fc33ff33d5e9305a2d87f7824d1b943ba219cff4c153ae8fd39b0d8620fc332'))
    // '0x85992e471002c40730d2b91831ba40cd8ffcebf4905646c25b7b6abb7575f25d19395045466e833b7700e233bfa5836f0a459da05bf817efd6cb4f55bcaec4b51c'
    let signature_2 = hex::decode("85992e471002c40730d2b91831ba40cd8ffcebf4905646c25b7b6abb7575f25d19395045466e833b7700e233bfa5836f0a459da05bf817efd6cb4f55bcaec4b51c").unwrap();

    MultisigIsmTestData {
        message,
        checkpoint,
        validators: vec![validator_0, validator_1, validator_2],
        signatures: vec![signature_0, signature_1, signature_2],
    }
}
