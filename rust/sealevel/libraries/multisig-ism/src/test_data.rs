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
        version: 3,
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
        id: std::sync::OnceLock::new(),
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
            // Intentionally set to a different value than the message's nonce to test
            // that the checkpoint in the ISM is constructed correctly using the metadata's
            // merkle index.
            index: message.nonce + 1,
        },
        message_id: message.id(),
    };

    // checkpoint.signing_hash() is equal to:
    // 0x3fd308215a20af20b137372f8a69fd336ebf93d57d4076a7c46e13f315255257

    // Validator 0:
    // Address: 0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D
    // Private Key: 0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091
    let validator_0 = H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap();
    // > await (new ethers.Wallet('0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091')).signMessage(ethers.utils.arrayify('0x3fd308215a20af20b137372f8a69fd336ebf93d57d4076a7c46e13f315255257'))
    // '0x081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c'
    let signature_0 = hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap();

    // Validator 1:
    // Address: 0xb25206874C24733F05CC0dD11924724A8E7175bd
    // Private Key: 0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e
    let validator_1 = H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap();
    // > await (new ethers.Wallet('0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e')).signMessage(ethers.utils.arrayify('0x3fd308215a20af20b137372f8a69fd336ebf93d57d4076a7c46e13f315255257'))
    // '0x0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b'
    let signature_1 = hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap();

    // Validator 2:
    // Address: 0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3
    // Private Key: 0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515
    let validator_2 = H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap();
    // > await (new ethers.Wallet('0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515')).signMessage(ethers.utils.arrayify('0x3fd308215a20af20b137372f8a69fd336ebf93d57d4076a7c46e13f315255257'))
    // '0x5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b'
    let signature_2 = hex::decode("5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b").unwrap();

    MultisigIsmTestData {
        message,
        checkpoint,
        validators: vec![validator_0, validator_1, validator_2],
        signatures: vec![signature_0, signature_1, signature_2],
    }
}
