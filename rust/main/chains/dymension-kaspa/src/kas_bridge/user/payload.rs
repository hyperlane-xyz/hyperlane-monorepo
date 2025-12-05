use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use hyperlane_cosmos::signers::Signer;
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use hyperlane_cosmos_rs::prost::Message as _;
use hyperlane_warp_route::TokenMessage;

/*
Need to make a hub priv key and address pair
Derive the HL user addr, which is just raw address bytes
https://github.com/dymensionxyz/dymension/blob/df472aefe2d022a075560160db678dddd4011f28/x/forward/cli/util.go#L685-L693
 */
pub fn make_deposit_payload_easy(
    domain_kas: u32,
    token_kas_placeholder: H256,
    domain_hub: u32,
    token_hub: H256,
    amt: u64,
    signer: &Signer,
) -> Vec<u8> {
    make_deposit_payload(
        domain_kas,
        token_kas_placeholder,
        domain_hub,
        token_hub,
        amt,
        signer.address_h256(),
    )
}

pub fn make_deposit_payload(
    domain_kas: u32,
    token_kas_placeholder: H256,
    domain_hub: u32,
    token_hub: H256,
    amt: u64,
    hub_user_addr_hub: H256,
) -> Vec<u8> {
    let meta = make_deposit_payload_meta();
    let token_message = TokenMessage::new(hub_user_addr_hub, U256::from(amt), meta);
    let mut buf = vec![];
    token_message.write_to(&mut buf).unwrap();

    let m = HyperlaneMessage {
        origin: domain_kas,
        sender: token_kas_placeholder,
        destination: domain_hub,
        recipient: token_hub,
        body: buf,
        ..Default::default()
    };

    let mut buf = vec![];
    m.write_to(&mut buf).unwrap();

    buf
}

fn make_deposit_payload_meta() -> Vec<u8> {
    // Create an empty HlMetadata struct with all required fields
    // The kaspa field will be populated later in the message flow
    let metadata = HlMetadata {
        kaspa: vec![],
        hook_forward_to_hl: vec![],
        hook_forward_to_ibc: vec![],
    };

    // Encode the metadata to protobuf bytes
    metadata.encode_to_vec()
}
