use hyperlane_core::{Signable, H160};

use crate::{error::MultisigIsmError, signature::EcdsaSignature};

pub struct MultisigIsm<T: Signable> {
    signed_data: T,
    signatures: Vec<EcdsaSignature>,
    validators: Vec<H160>,
    threshold: u8,
}

impl<T: Signable> MultisigIsm<T> {
    pub fn new(
        signed_data: T,
        signatures: Vec<EcdsaSignature>,
        validators: Vec<H160>,
        threshold: u8,
    ) -> Self {
        Self {
            signed_data,
            signatures,
            validators,
            threshold,
        }
    }

    pub fn verify(&self) -> Result<(), MultisigIsmError> {
        let signed_digest = self.signed_data.eth_signed_message_hash();
        let signed_digest_bytes = signed_digest.as_bytes();

        let validator_count = self.validators.len();
        let mut validator_index = 0;

        // Assumes that signatures are ordered by validator
        for i in 0..self.threshold {
            let signer = self.signatures[i as usize]
                .secp256k1_recover_ethereum_address(signed_digest_bytes)
                .map_err(|_| MultisigIsmError::InvalidSignature)?;

            while validator_index < validator_count && signer != self.validators[validator_index] {
                validator_index += 1;
            }

            if validator_index >= validator_count {
                return Err(MultisigIsmError::ThresholdNotMet);
            }

            validator_index += 1;
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    use crate::signature::EcdsaSignature;

    use std::str::FromStr;

    use hyperlane_core::H256;

    struct TestSignedPayload();

    impl Signable for TestSignedPayload {
        fn signing_hash(&self) -> H256 {
            H256::from_str("0xf00000000000000000000000000000000000000000000000000000000000000f")
                .unwrap()
        }
    }

    #[test]
    fn test_secp256k1_recover_ethereum_address() {
        // A test signature from this Ethereum address:
        //   Address: 0xfdB65576568b99A8a00a292577b8fc51abB115bD
        //   Private Key: 0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691
        // The signature was generated using ethers-js:
        //   wallet = new ethers.Wallet('0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691')
        //   await wallet.signMessage(ethers.utils.arrayify('0xf00000000000000000000000000000000000000000000000000000000000000f'))

        let signature = EcdsaSignature::from_bytes(
            &hex::decode("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c").unwrap()[..]
        ).unwrap();

        let signed_hash = TestSignedPayload().eth_signed_message_hash();

        let recovered_signer = signature
            .secp256k1_recover_ethereum_address(signed_hash.as_fixed_bytes())
            .unwrap();
        assert_eq!(
            recovered_signer,
            H160::from_str("0xfdB65576568b99A8a00a292577b8fc51abB115bD").unwrap()
        );
    }

    #[test]
    fn test_multisig_ism_verify_success() {
        // A test signature from this Ethereum address:
        //   Address: 0xfdB65576568b99A8a00a292577b8fc51abB115bD
        //   Private Key: 0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691
        // The signature was generated using ethers-js:
        //   wallet = new ethers.Wallet('0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691')
        //   await wallet.signMessage(ethers.utils.arrayify('0xf00000000000000000000000000000000000000000000000000000000000000f'))

        let validator_0 = H160::from_str("0xfdB65576568b99A8a00a292577b8fc51abB115bD").unwrap();
        let signature_0 = EcdsaSignature::from_bytes(
            &hex::decode("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c").unwrap()[..]
        ).unwrap();

        // Address: 0x5090cEd8BC5A7D3c2FbE2b2702eE4a8e7b227181
        // Private Key: 0xe2dc693322e2b96b4405cb635cb3fb8aa35f65cca9c9171d54dd6f6dfe23dd14

        let validator_1 = H160::from_str("0x5090cEd8BC5A7D3c2FbE2b2702eE4a8e7b227181").unwrap();
        let signature_1 = EcdsaSignature::from_bytes(
            &hex::decode("9d510e0d988e44cf05a4e29d7b1ecec6e3277a8be137164f89d6cf52325190f058101ef9aa57d118f9452a38c156efbdb1b69d4022ac2c35370c433ca5b61aeb1c").unwrap()[..]
        ).unwrap();

        let multisig_ism = MultisigIsm::new(
            TestSignedPayload(),
            vec![signature_0, signature_1],
            vec![validator_0, validator_1],
            2,
        );

        let result = multisig_ism.verify();
        assert!(result.is_ok());
    }

    #[test]
    fn test_multisig_ism_verify_threshold_not_met() {
        let validator_0 = H160::from_str("0xfdB65576568b99A8a00a292577b8fc51abB115bD").unwrap();
        let signature_0 = EcdsaSignature::from_bytes(
            &hex::decode("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c").unwrap()[..]
        ).unwrap();

        let validator_1 = H160::from_str("0x5090cEd8BC5A7D3c2FbE2b2702eE4a8e7b227181").unwrap();
        // This signature corresponds to validator_0
        let signature_1 = EcdsaSignature::from_bytes(
            &hex::decode("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c").unwrap()[..]
        ).unwrap();

        let multisig_ism = MultisigIsm::new(
            TestSignedPayload(),
            vec![signature_0, signature_1],
            vec![validator_0, validator_1],
            2,
        );

        assert_eq!(
            multisig_ism.verify().unwrap_err(),
            MultisigIsmError::ThresholdNotMet
        );
    }

    #[test]
    fn test_multisig_ism_validators_out_of_order() {
        let validator_0 = H160::from_str("0xfdB65576568b99A8a00a292577b8fc51abB115bD").unwrap();
        let signature_0 = EcdsaSignature::from_bytes(
            &hex::decode("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c").unwrap()[..]
        ).unwrap();

        let validator_1 = H160::from_str("0x5090cEd8BC5A7D3c2FbE2b2702eE4a8e7b227181").unwrap();
        let signature_1 = EcdsaSignature::from_bytes(
            &hex::decode("9d510e0d988e44cf05a4e29d7b1ecec6e3277a8be137164f89d6cf52325190f058101ef9aa57d118f9452a38c156efbdb1b69d4022ac2c35370c433ca5b61aeb1c").unwrap()[..]
        ).unwrap();

        let multisig_ism = MultisigIsm::new(
            TestSignedPayload(),
            // Sigs out of order
            vec![signature_1, signature_0],
            vec![validator_0, validator_1],
            2,
        );

        assert_eq!(
            multisig_ism.verify().unwrap_err(),
            MultisigIsmError::ThresholdNotMet
        );
    }
}
