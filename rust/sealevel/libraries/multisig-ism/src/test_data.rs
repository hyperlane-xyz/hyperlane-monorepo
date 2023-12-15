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
    // 0x5c2b4cbafdd7319d9a3dea4aa078748ae53368e1521494a80cf4259b9c6dba6a

    // Validator 0:
    // Address: 0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D
    // Private Key: 0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091
    let validator_0 = H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap();
    // > await (new ethers.Wallet('0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091')).signMessage(ethers.utils.arrayify('0x5c2b4cbafdd7319d9a3dea4aa078748ae53368e1521494a80cf4259b9c6dba6a'))
    // '0xb8875fb75adf471e43a943b78eb422ffe86a4291fa6324f9f875241605ca831d2b4225358936deee7501cf305aafc1677e3dc9bcfea4caec54f4cde49d416bd91b'
    let signature_0 = hex::decode("b8875fb75adf471e43a943b78eb422ffe86a4291fa6324f9f875241605ca831d2b4225358936deee7501cf305aafc1677e3dc9bcfea4caec54f4cde49d416bd91b").unwrap();

    // Validator 1:
    // Address: 0xb25206874C24733F05CC0dD11924724A8E7175bd
    // Private Key: 0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e
    let validator_1 = H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap();
    // > await (new ethers.Wallet('0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e')).signMessage(ethers.utils.arrayify('0x5c2b4cbafdd7319d9a3dea4aa078748ae53368e1521494a80cf4259b9c6dba6a'))
    // '0xfa8d61da2e0ac6f32c8432e75770d90483613efe96b442fbca9ca8d200447bf979f46529c7341879333a9c24a7d3fba08b53d13447618b71cf2ee4734e82f96e1c'
    let signature_1 = hex::decode("fa8d61da2e0ac6f32c8432e75770d90483613efe96b442fbca9ca8d200447bf979f46529c7341879333a9c24a7d3fba08b53d13447618b71cf2ee4734e82f96e1c").unwrap();

    // Validator 2:
    // Address: 0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3
    // Private Key: 0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515
    let validator_2 = H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap();
    // > await (new ethers.Wallet('0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515')).signMessage(ethers.utils.arrayify('0x5c2b4cbafdd7319d9a3dea4aa078748ae53368e1521494a80cf4259b9c6dba6a'))
    // '0x6c60c3744f6bf779017b8ab9aa8eed60bf53c317cf4d74d765015cc0a7dcad783dee39334bfc7e4baab944355914e7431e4286df8c0557a0c1f6ba867677da421b'
    let signature_2 = hex::decode("6c60c3744f6bf779017b8ab9aa8eed60bf53c317cf4d74d765015cc0a7dcad783dee39334bfc7e4baab944355914e7431e4286df8c0557a0c1f6ba867677da421b").unwrap();

    MultisigIsmTestData {
        message,
        checkpoint,
        validators: vec![validator_0, validator_1, validator_2],
        signatures: vec![signature_0, signature_1, signature_2],
    }
}
