use super::payload::MessageID;
use borsh::{
    from_slice as borsh_from_slice, to_vec as borsh_to_vec, BorshDeserialize, BorshSerialize,
};
use bytes::Bytes;
use eyre::Error as EyreError;
use hex::ToHex;
use hyperlane_core::H256;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::WithdrawalId;
use hyperlane_cosmos_rs::prost::Message;
use kaspa_consensus_core::tx::TransactionOutpoint;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct ConfirmationFXGCache {
    /// a sequence of chronological outpoints where the first is the old outpoint on the progres indication
    /// and the last is the new one
    pub outpoints: Vec<TransactionOutpoint>,
}

#[derive(Debug, Clone)]
pub struct ConfirmationFXG {
    pub progress_indication: ProgressIndication,
    pub cache: ConfirmationFXGCache,
}

impl ConfirmationFXG {
    pub fn new(progress_indication: ProgressIndication, cache: ConfirmationFXGCache) -> Self {
        Self {
            progress_indication,
            cache,
        }
    }

    pub fn from_msgs_outpoints(msgs: Vec<MessageID>, outpoints: Vec<TransactionOutpoint>) -> Self {
        let withdrawal_ids: Vec<WithdrawalId> = msgs
            .into_iter()
            .map(|id| WithdrawalId {
                message_id: id.0.encode_hex(),
            })
            .collect();

        // TODO: or is the list the other way around?
        let old = outpoints[0];
        let new = outpoints[outpoints.len() - 1];

        let new_outpoint_indication =
            hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
                transaction_id: new.transaction_id.as_bytes().to_vec(),
                index: new.index,
            };

        let anchor_outpoint_indication =
            hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
                transaction_id: old.transaction_id.as_bytes().to_vec(),
                index: old.index,
            };

        let progress_indication = ProgressIndication {
            old_outpoint: Some(anchor_outpoint_indication),
            new_outpoint: Some(new_outpoint_indication),
            processed_withdrawals: withdrawal_ids,
        };

        Self::new(progress_indication, ConfirmationFXGCache { outpoints })
    }

    pub fn msgs(&self) -> Vec<MessageID> {
        self.progress_indication
            .processed_withdrawals
            .iter()
            .map(|id| MessageID(H256::from_str(&id.message_id).unwrap()))
            .collect()
    }
}

impl TryFrom<Bytes> for ConfirmationFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let progress_indication = ProgressIndication::decode(bytes.as_ref())?;
        let cache: ConfirmationFXGCache = ConfirmationFXGCache::try_from(bytes)?;
        Ok(ConfirmationFXG {
            progress_indication,
            cache,
        })
    }
}

impl From<&ConfirmationFXG> for Bytes {
    fn from(x: &ConfirmationFXG) -> Self {
        let encoded = x.progress_indication.encode_to_vec();
        let cache: Bytes = Bytes::from(&x.cache);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&encoded);
        bytes.extend_from_slice(&cache);
        Bytes::from(bytes)
    }
}

impl TryFrom<Bytes> for ConfirmationFXGCache {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let outpoints = borsh_from_slice(&bytes)?;
        let cache = ConfirmationFXGCache { outpoints };
        Ok(cache)
    }
}

impl From<&ConfirmationFXGCache> for Bytes {
    fn from(x: &ConfirmationFXGCache) -> Self {
        let vec = borsh_to_vec(&x.outpoints).unwrap();
        Bytes::from(vec)
    }
}
