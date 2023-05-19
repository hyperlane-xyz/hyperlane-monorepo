//! Gated on the "test-data" feature.
//! Useful for use in unit & integration tests, which can't import from
//! each other.

use hyperlane_core::{Checkpoint, HyperlaneMessage, H160, H256};
use std::str::FromStr;

pub struct MultisigIsmTestData {
    pub message: HyperlaneMessage,
    pub checkpoint: Checkpoint,
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

    let checkpoint = Checkpoint {
        mailbox_address: H256::from_str(
            "0xabababababababababababababababababababababababababababababababab",
        )
        .unwrap(),
        mailbox_domain: ORIGIN_DOMAIN,
        root: H256::from_str("0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd")
            .unwrap(),
        index: 69,
        message_id: message.id(),
    };

    // checkpoint.signing_hash() is equal to:
    // 0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e

    // Validator 0:
    // Address: 0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D
    // Private Key: 0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091
    let validator_0 = H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap();
    //   > await (new ethers.Wallet('0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
    //   '0xba6ac92e3e1156c572ad2a9ba8bfc3a5e9492dfe9d0d00c6522682306614969a181962c07c64f8df863ded67ecc628fb19e4998e0521c4555b380a69b0afbf0c1b'
    let signature_0 = hex::decode("ba6ac92e3e1156c572ad2a9ba8bfc3a5e9492dfe9d0d00c6522682306614969a181962c07c64f8df863ded67ecc628fb19e4998e0521c4555b380a69b0afbf0c1b").unwrap();

    // Validator 1:
    // Address: 0xb25206874C24733F05CC0dD11924724A8E7175bd
    // Private Key: 0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e
    let validator_1 = H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap();
    //   > await (new ethers.Wallet('0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
    //   '0x9034ee44173817edf63c223b5761e3a7580adf34ed6239b25da3e4f9b5c5d6230d903672de6744827f128b89b74be3c3f3ea367a618162f239f1b6d4aae66eec1c'
    let signature_1 = hex::decode("9034ee44173817edf63c223b5761e3a7580adf34ed6239b25da3e4f9b5c5d6230d903672de6744827f128b89b74be3c3f3ea367a618162f239f1b6d4aae66eec1c").unwrap();

    // Validator 2:
    // Address: 0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3
    // Private Key: 0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515
    let validator_2 = H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap();
    //   > await (new ethers.Wallet('0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
    //   '0x2b228823c04b9dd37577763043127fe3307074bb45968302c6111e8e334c3cd25292061618f392549c81351ae9e08d5c4a1e0b9947b79a30f8d693257e8818731c'
    let signature_2 = hex::decode("2b228823c04b9dd37577763043127fe3307074bb45968302c6111e8e334c3cd25292061618f392549c81351ae9e08d5c4a1e0b9947b79a30f8d693257e8818731c").unwrap();

    MultisigIsmTestData {
        message,
        checkpoint,
        validators: vec![validator_0, validator_1, validator_2],
        signatures: vec![signature_0, signature_1, signature_2],
    }
}
