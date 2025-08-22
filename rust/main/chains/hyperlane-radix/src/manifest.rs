use hyperlane_core::H256;
use radix_transactions::{
    manifest::{self, IsBlobProvider},
    model::InstructionV1,
};
use scrypto::{network::NetworkDefinition, prelude::ManifestGlobalAddress};

pub fn find_fee_payer_from_manifest(
    s: &str,
    network: &NetworkDefinition,
    blobs: impl IsBlobProvider,
) -> Option<H256> {
    let val = match manifest::compile(s, network, blobs) {
        Ok(v) => v,
        Err(_) => return None,
    };

    for inst in val.instructions {
        let call_method = match inst {
            InstructionV1::CallMethod(call_method) => call_method,
            _ => continue,
        };
        // https://docs.radixdlt.com/docs/account
        // could be any of:
        // - lock_fee
        // - lock_fee_and_withdraw
        // - lock_fee_and_withdraw_non_fungibles
        if !call_method.method_name.starts_with("lock_fee") {
            continue;
        }

        let address = match call_method.address {
            ManifestGlobalAddress::Static(address) => address,
            _ => continue,
        };

        let address_32: Vec<u8> = (0..32usize.saturating_sub(address.as_bytes().len()))
            .map(|_| 0u8)
            .chain(address.as_bytes().iter().cloned())
            .collect();

        let address_h256 = H256::from_slice(address_32.as_slice());
        return Some(address_h256);
    }
    return None;
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use radix_transactions::manifest::BlobProvider;

    use super::*;

    const MANIFEST: &str = r#"
CALL_METHOD
    Address("account_rdx16xuf7teqapv5gzpsxf2l2yd5xnc84988qd7k5ezp3ws3qh2z4c6rp4")
    "lock_fee_and_withdraw"
    Decimal("10")
    Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
    Decimal("164.25883931284386108")
;
TAKE_ALL_FROM_WORKTOP
    Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
    Bucket("bucket1")
;
CALL_METHOD
    Address("component_rdx1cz79xc57dpuhzd3wylnc88m3pyvfk7c5e03me2qv7x8wh9t6c3aw4g")
    "swap"
    Bucket("bucket1")
;
TAKE_ALL_FROM_WORKTOP
    Address("resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw")
    Bucket("bucket2")
;
CALL_METHOD
    Address("component_rdx1cqm7wcyaeuv7hj2maec65rtscfj4hzkc20kalge89xfmwus2ag4rgs")
    "swap"
    Bucket("bucket2")
;
TAKE_ALL_FROM_WORKTOP
    Address("resource_rdx1tkff46jkeu98jgl8naxpzfkn0m0hytysxzex3l3a8m7qps49f7m45c")
    Bucket("bucket3")
;
CALL_METHOD
    Address("component_rdx1cz9w9kpuj5q0r3hyzl9q065q54ytwgxp22ckvfmp9g2xvjrshmg5mk")
    "swap"
    Bucket("bucket3")
;
ASSERT_WORKTOP_CONTAINS
    Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
    Decimal("164.25883931284386108")
;
CALL_METHOD
    Address("account_rdx16xuf7teqapv5gzpsxf2l2yd5xnc84988qd7k5ezp3ws3qh2z4c6rp4")
    "try_deposit_batch_or_abort"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;
    "#;
    #[test]
    fn test_decode_manifest() {
        let network = NetworkDefinition::mainnet();
        let blob_p = BlobProvider::new();
        let fee_payer =
            find_fee_payer_from_manifest(MANIFEST, &network, blob_p).expect("Fee payer not found");

        let expected_address =
            H256::from_str("0000d1b89f2f20e8594408303255f511b434f07a94e7037d6a64418ba1105d42")
                .unwrap();
        assert_eq!(fee_payer, expected_address);
    }
}
