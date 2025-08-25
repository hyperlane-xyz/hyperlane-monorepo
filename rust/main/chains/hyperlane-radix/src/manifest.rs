use hyperlane_core::H256;
use radix_transactions::{
    manifest::{self, IsBlobProvider},
    model::InstructionV1,
};
use scrypto::{network::NetworkDefinition, prelude::ManifestGlobalAddress};

use crate::global_address_to_h256;

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
        // - lock_fee_from_faucet
        if !call_method.method_name.starts_with("lock_fee") {
            continue;
        }

        let address = match call_method.address {
            ManifestGlobalAddress::Static(address) => address,
            _ => continue,
        };

        // For some reason, radix addresses are 30 bytes instead of 32.
        let address_h256 = global_address_to_h256(&address);
        return Some(address_h256);
    }
    None
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use radix_transactions::manifest::BlobProvider;

    use crate::encode_module_address;

    use super::*;

    #[test]
    fn test_decode_manifest_lock_fee_and_withdraw() {
        let manifest = r#"
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
        let network = NetworkDefinition::mainnet();
        let blob_p = BlobProvider::new();
        let fee_payer =
            find_fee_payer_from_manifest(manifest, &network, blob_p).expect("Fee payer not found");

        let expected_address =
            H256::from_str("0000d1b89f2f20e8594408303255f511b434f07a94e7037d6a64418ba1105d42")
                .unwrap();
        assert_eq!(fee_payer, expected_address);

        let radix_address = encode_module_address("account", &network.hrp_suffix, expected_address)
            .expect("Failed to encode radix address");
        assert_eq!(
            radix_address,
            "account_rdx16xuf7teqapv5gzpsxf2l2yd5xnc84988qd7k5ezp3ws3qh2z4c6rp4"
        );
    }

    #[test]
    fn test_decode_manifest_lock_fee() {
        let manifest = r#"
CALL_METHOD
    Address("account_rdx168nr5dwmll4k2x5apegw5dhrpejf3xac7khjhgjqyg4qddj9tg9v4d")
    "lock_fee"
    Decimal("0.58434484845")
;
CALL_METHOD
    Address("account_rdx168nr5dwmll4k2x5apegw5dhrpejf3xac7khjhgjqyg4qddj9tg9v4d")
    "create_proof_of_amount"
    Address("resource_rdx1th3yr5dlydnhw0lfp6r22x5l2fj9lv3t8f0enkp7j5ttnx3e09rhna")
    Decimal("1")
;
CALL_METHOD
    Address("component_rdx1cr3psyfptwkktqusfg8ngtupr4wwfg32kz2xvh9tqh4c7pwkvlk2kn")
    "set_price_batch"
    Map<Tuple, Decimal>(
        Tuple(
            Address("resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("191.67045094145536"),
        Tuple(
            Address("resource_rdx1th88qcj5syl9ghka2g9l7tw497vy5x6zaatyvgfkwcfe8n9jt2npww"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("887709.7375331281"),
        Tuple(
            Address("resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("191.66817958469463"),
        Tuple(
            Address("resource_rdx1t580qxc7upat7lww4l2c4jckacafjeudxj5wpjrrct0p3e82sq4y75"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("21385378.506144695"),
        Tuple(
            Address("resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("1.148292541506036065"),
        Tuple(
            Address("resource_rdx1t5kmyj54jt85malva7fxdrnpvgfgs623yt7ywdaval25vrdlmnwe97"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("0.000395318920575434"),
        Tuple(
            Address("resource_rdx1t5pyvlaas0ljxy0wytm5gvyamyv896m69njqdmm2stukr3xexc2up9"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("115824.78567336412"),
        Tuple(
            Address("resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq"),
            Address("resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")
        ) => Decimal("1.0692337686438784")
    )
;"#;
        let network = NetworkDefinition::mainnet();
        let blob_p = BlobProvider::new();
        let fee_payer =
            find_fee_payer_from_manifest(manifest, &network, blob_p).expect("Fee payer not found");

        let expected_address =
            H256::from_str("0000d1e63a35dbffeb651a9d0e50ea36e30e64989bb8f5af2ba240222a06b645")
                .unwrap();
        assert_eq!(fee_payer, expected_address);

        let radix_address = encode_module_address("account", &network.hrp_suffix, expected_address)
            .expect("Failed to encode radix address");
        assert_eq!(
            radix_address,
            "account_rdx168nr5dwmll4k2x5apegw5dhrpejf3xac7khjhgjqyg4qddj9tg9v4d"
        );
    }
}
