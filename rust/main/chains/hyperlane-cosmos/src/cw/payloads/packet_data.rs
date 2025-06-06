use cosmrs::proto::prost::Message;
use cosmrs::Any;
use ibc_proto::ibc::core::channel::v1::MsgRecvPacket;
use serde::{Deserialize, Serialize};

use crate::HyperlaneCosmosError;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PacketData {
    pub amount: String,
    pub denom: String,
    pub memo: String,
    pub receiver: String,
    pub sender: String,
}

impl TryFrom<&Any> for PacketData {
    type Error = HyperlaneCosmosError;

    fn try_from(any: &Any) -> Result<Self, Self::Error> {
        let vec = any.value.as_slice();
        let msg = MsgRecvPacket::decode(vec).map_err(Into::<HyperlaneCosmosError>::into)?;
        let packet = msg
            .packet
            .ok_or(HyperlaneCosmosError::UnparsableEmptyField(
                "MsgRecvPacket packet is empty".to_owned(),
            ))?;
        let data = serde_json::from_slice::<PacketData>(&packet.data)?;
        Ok(data)
    }
}

impl TryFrom<Any> for PacketData {
    type Error = HyperlaneCosmosError;

    fn try_from(any: Any) -> Result<Self, Self::Error> {
        Self::try_from(&any)
    }
}

#[cfg(test)]
mod tests {
    use cosmrs::proto::prost::Message;
    use cosmrs::Any;
    use ibc_proto::ibc::core::channel::v1::{MsgRecvPacket, Packet};

    use crate::{cw::payloads::packet_data::PacketData, HyperlaneCosmosError};

    #[test]
    fn success() {
        // given
        let json = r#"{"amount":"59743800","denom":"utia","memo":"{\"wasm\":{\"contract\":\"neutron1jyyjd3x0jhgswgm6nnctxvzla8ypx50tew3ayxxwkrjfxhvje6kqzvzudq\",\"msg\":{\"transfer_remote\":{\"dest_domain\":42161,\"recipient\":\"0000000000000000000000008784aca75a95696fec93184b1c7b2d3bf5838df9\",\"amount\":\"59473800\"}},\"funds\":[{\"amount\":\"59743800\",\"denom\":\"ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7\"}]}}","receiver":"neutron1jyyjd3x0jhgswgm6nnctxvzla8ypx50tew3ayxxwkrjfxhvje6kqzvzudq","sender":"celestia19ns7dd07g5vvrueyqlkvn4dmxt957zcdzemvj6"}"#;
        let any = any(json);

        // when
        let data = PacketData::try_from(&any);

        // then
        assert!(data.is_ok());
    }

    #[test]
    fn fail_json() {
        // given
        let json = r#"{"amount":"27000000","denom":"utia","receiver":"neutron13uuq6vgenxan43ngscjlew8lc2z32znx9qfk0n","sender":"celestia1rh4gplea4gzvaaejew8jfvp9r0qkdmfgkf55qy"}"#;
        let any = any(json);

        // when
        let data = PacketData::try_from(&any);

        // then
        assert!(data.is_err());
        assert!(matches!(
            data.err().unwrap(),
            HyperlaneCosmosError::SerdeError(_),
        ));
    }

    #[test]
    fn fail_empty() {
        // given
        let any = empty();

        // when
        let data = PacketData::try_from(&any);

        // then
        assert!(data.is_err());
        assert!(matches!(
            data.err().unwrap(),
            HyperlaneCosmosError::UnparsableEmptyField(_),
        ));
    }

    #[test]
    fn fail_decode() {
        // given
        let any = wrong_encoding();

        // when
        let data = PacketData::try_from(&any);

        // then
        assert!(data.is_err());
        assert!(matches!(
            data.err().unwrap(),
            HyperlaneCosmosError::Prost(_),
        ));
    }

    fn any(json: &str) -> Any {
        let packet = Packet {
            sequence: 0,
            source_port: "".to_string(),
            source_channel: "".to_string(),
            destination_port: "".to_string(),
            destination_channel: "".to_string(),
            data: json.as_bytes().to_vec(),
            timeout_height: None,
            timeout_timestamp: 0,
        };

        let msg = MsgRecvPacket {
            packet: Option::from(packet),
            proof_commitment: vec![],
            proof_height: None,
            signer: "".to_string(),
        };

        encode_proto(&msg)
    }

    fn empty() -> Any {
        let msg = MsgRecvPacket {
            packet: None,
            proof_commitment: vec![],
            proof_height: None,
            signer: "".to_string(),
        };

        encode_proto(&msg)
    }

    fn wrong_encoding() -> Any {
        let buf = vec![1, 2, 3];
        Any {
            type_url: "".to_string(),
            value: buf,
        }
    }

    fn encode_proto(msg: &MsgRecvPacket) -> Any {
        let mut buf = Vec::with_capacity(msg.encoded_len());
        MsgRecvPacket::encode(msg, &mut buf).unwrap();

        Any {
            type_url: "".to_string(),
            value: buf,
        }
    }
}
