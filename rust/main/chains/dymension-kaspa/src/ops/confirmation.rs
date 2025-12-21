use crate::ops::payload::MessageID;
use bytes::Bytes;
use eyre::Error as EyreError;
use hex::ToHex;
use hyperlane_core::H256;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    ProgressIndication, TransactionOutpoint as ProtoTransactionOutpoint, WithdrawalId,
};
use hyperlane_cosmos_rs::dymensionxyz::hyperlane::kaspa::{
    ConfirmationFxg as ProtoConfirmationFXG, ConfirmationVersion::ConfirmationVersion1,
};
use hyperlane_cosmos_rs::prost::Message;
use kaspa_consensus_core::tx::TransactionOutpoint;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct ConfirmationFXG {
    pub progress_indication: ProgressIndication,
    /// a sequence of chronological outpoints where the first is the old outpoint on the progres indication
    /// and the last is the new one
    pub outpoints: Vec<TransactionOutpoint>,
}

impl ConfirmationFXG {
    pub fn new(
        progress_indication: ProgressIndication,
        outpoints: Vec<TransactionOutpoint>,
    ) -> Self {
        Self {
            progress_indication,
            outpoints,
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

        Self::new(progress_indication, outpoints)
    }

    pub fn msgs(&self) -> Vec<MessageID> {
        self.progress_indication
            .processed_withdrawals
            .iter()
            .map(|id| MessageID(H256::from_str(&id.message_id).unwrap()))
            .collect()
    }
}

impl From<&ConfirmationFXG> for Bytes {
    fn from(v: &ConfirmationFXG) -> Self {
        let p = ProtoConfirmationFXG::from(v);
        Bytes::from(p.encode_to_vec())
    }
}

impl TryFrom<Bytes> for ConfirmationFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let p = ProtoConfirmationFXG::decode(bytes)
            .map_err(|e| eyre::eyre!("ConfirmationFXG deserialize: {}", e))?;
        Ok(ConfirmationFXG::from(p))
    }
}

impl From<&ConfirmationFXG> for ProtoConfirmationFXG {
    fn from(v: &ConfirmationFXG) -> Self {
        ProtoConfirmationFXG {
            version: ConfirmationVersion1 as i32,
            outpoints: v
                .outpoints
                .iter()
                .map(|o| ProtoTransactionOutpoint {
                    transaction_id: o.transaction_id.as_bytes().to_vec(),
                    index: o.index,
                })
                .collect(),
            progress_indication: Some(v.progress_indication.clone()),
        }
    }
}

impl From<ProtoConfirmationFXG> for ConfirmationFXG {
    fn from(v: ProtoConfirmationFXG) -> Self {
        ConfirmationFXG {
            progress_indication: v.progress_indication.unwrap(),
            outpoints: v
                .outpoints
                .iter()
                .map(|o| TransactionOutpoint {
                    transaction_id: kaspa_hashes::Hash::from_slice(&o.transaction_id),
                    index: o.index,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
        ProgressIndication, TransactionOutpoint as ProtoTransactionOutpoint, WithdrawalId,
    };

    #[test]
    fn test_confirmationfxg_bytes_roundtrip() {
        let old_outpoint = TransactionOutpoint::new(kaspa_hashes::Hash::default(), 5);
        let new_outpoint = TransactionOutpoint::new(kaspa_hashes::Hash::default(), 15);

        let withdrawal_id = WithdrawalId {
            message_id: "abc123".to_string(),
        };

        let progress_indication = ProgressIndication {
            old_outpoint: Some(ProtoTransactionOutpoint {
                transaction_id: old_outpoint.transaction_id.as_bytes().to_vec(),
                index: old_outpoint.index,
            }),
            new_outpoint: Some(ProtoTransactionOutpoint {
                transaction_id: new_outpoint.transaction_id.as_bytes().to_vec(),
                index: new_outpoint.index,
            }),
            processed_withdrawals: vec![withdrawal_id],
        };

        let outpoints = vec![old_outpoint, new_outpoint];

        let confirmation = ConfirmationFXG::new(progress_indication.clone(), outpoints.clone());

        let bytes = Bytes::try_from(&confirmation).unwrap();
        let confirmation2 = ConfirmationFXG::try_from(bytes).unwrap();

        assert_eq!(confirmation.outpoints, confirmation2.outpoints);
        assert_eq!(
            confirmation.progress_indication.processed_withdrawals,
            confirmation2.progress_indication.processed_withdrawals
        );
    }
}
