use crate::ops::payload::MessageID;
use bytes::Bytes;
use eyre::Error as EyreError;
use hex::ToHex;
use hyperlane_core::Encode;
use hyperlane_core::HyperlaneMessage;
use hyperlane_cosmos::native::ModuleQueryClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    TransactionOutpoint as ProtoTransactionOutpoint, WithdrawalId, WithdrawalStatus,
};
use hyperlane_cosmos_rs::dymensionxyz::hyperlane::kaspa::{
    HyperlaneMessages as ProtoHyperlaneMessages, WithdrawFxg as ProtoWithdrawFXG, WithdrawalVersion,
};
use hyperlane_cosmos_rs::prost::Message;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_wallet_pskt::prelude::Bundle;

/// WithdrawFXG represents a sequence of PSKT transactions for batch processing and transport as
/// a single serialized payload. A Bundle contains multiple PSKTs, where each PSKT is associated with
/// some Hyperlane messages.
///
/// The structure maintains a strict correspondence between PSKTs and their messages: each PSKT at
/// index N in the bundle corresponds to the messages at index N in the messages array. For example,
/// if Bundle[0] contains PSKT1 and messages[0] contains {M1, M2}, then PSKT1 covers messages M1 and M2.
///
#[derive(Debug)]
pub struct WithdrawFXG {
    pub bundle: Bundle,
    pub messages: Vec<Vec<HyperlaneMessage>>,

    // used by relayer only
    // the first element – the very first anchor (old hub)
    // the last eleemnt – the very new anchor (new hub)
    pub anchors: Vec<TransactionOutpoint>,
}

impl WithdrawFXG {
    pub fn new(
        bundle: Bundle,
        messages: Vec<Vec<HyperlaneMessage>>,
        anchors: Vec<TransactionOutpoint>,
    ) -> Self {
        Self {
            bundle,
            messages,
            anchors,
        }
    }

    pub fn ids(&self) -> Vec<MessageID> {
        self.messages
            .iter()
            .flat_map(|m| m.iter().map(|m| MessageID(m.id())))
            .collect()
    }
}

impl Default for WithdrawFXG {
    fn default() -> Self {
        Self {
            bundle: Bundle::new(),
            messages: vec![],
            anchors: vec![],
        }
    }
}

impl TryFrom<Bytes> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let p = ProtoWithdrawFXG::decode(bytes)
            .map_err(|e| eyre::eyre!("WithdrawFXG deserialize: {}", e))?;
        WithdrawFXG::try_from(p)
    }
}

impl TryFrom<&WithdrawFXG> for Bytes {
    type Error = EyreError;

    fn try_from(x: &WithdrawFXG) -> Result<Self, Self::Error> {
        let p = ProtoWithdrawFXG::try_from(x)
            .map_err(|e| eyre::eyre!("WithdrawFXG serialize: {}", e))?;
        Ok(Bytes::from(p.encode_to_vec()))
    }
}

impl TryFrom<ProtoWithdrawFXG> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(pb: ProtoWithdrawFXG) -> Result<Self, Self::Error> {
        Ok(WithdrawFXG {
            bundle: Bundle::try_from(pb.pskt_bundle)
                .map_err(|e| eyre::eyre!("pskt deserialize: {}", e))?,
            messages: pb
                .messages
                .into_iter()
                .map(|inner_vec| {
                    inner_vec
                        .messages
                        .into_iter()
                        .map(HyperlaneMessage::from)
                        .collect()
                })
                .collect(),
            anchors: pb
                .anchors
                .into_iter()
                .map(|a| TransactionOutpoint {
                    transaction_id: kaspa_hashes::Hash::from_slice(&a.transaction_id),
                    index: a.index,
                })
                .collect(),
        })
    }
}

impl TryFrom<&WithdrawFXG> for ProtoWithdrawFXG {
    type Error = EyreError;

    fn try_from(v: &WithdrawFXG) -> Result<Self, Self::Error> {
        Ok(ProtoWithdrawFXG {
            version: WithdrawalVersion::WithdrawalVersion1 as i32,
            pskt_bundle: v
                .bundle
                .serialize()
                .map_err(|e| eyre::eyre!("bundle serialize: {}", e))?,
            messages: v
                .messages
                .iter()
                .map(|inner_vec| ProtoHyperlaneMessages {
                    messages: inner_vec.iter().map(HyperlaneMessage::to_vec).collect(),
                })
                .collect(),
            anchors: v
                .anchors
                .iter()
                .map(|a| ProtoTransactionOutpoint {
                    transaction_id: a.transaction_id.as_bytes().to_vec(),
                    index: a.index,
                })
                .collect(),
        })
    }
}

pub async fn filter_pending_withdrawals(
    withdrawals: Vec<HyperlaneMessage>,
    cosmos: &ModuleQueryClient,
) -> eyre::Result<(TransactionOutpoint, Vec<HyperlaneMessage>)> {
    // A list of withdrawal IDs to request their statuses from the Hub
    let withdrawal_ids: Vec<_> = withdrawals
        .iter()
        .map(|m| WithdrawalId {
            message_id: m.id().encode_hex(),
        })
        .collect();

    // Request withdrawal statuses from the Hub
    let resp = cosmos
        .withdrawal_status(withdrawal_ids, None)
        .await
        .map_err(|e| eyre::eyre!("Query outpoint from x/kas: {}", e))?;

    let outpoint_data = resp
        .outpoint
        .ok_or_else(|| eyre::eyre!("No outpoint data in response"))?;

    if outpoint_data.transaction_id.len() != 32 {
        return Err(eyre::eyre!(
            "Invalid transaction ID length: expected 32 bytes, got {}",
            outpoint_data.transaction_id.len()
        ));
    }

    // Convert the transaction ID to kaspa transaction ID
    let kaspa_tx_id = kaspa_hashes::Hash::from_bytes(
        outpoint_data
            .transaction_id
            .as_slice()
            .try_into()
            .map_err(|e| eyre::eyre!("Convert tx ID to Kaspa tx ID: {:}", e))?,
    );

    // resp.status is a list of the same length as withdrawals. If status == WithdrawalStatus::Unprocessed,
    // then the respective element of withdrawals is Unprocessed.
    let pending_withdrawals: Vec<_> = resp
        .status
        .into_iter()
        .enumerate()
        .filter_map(|(idx, status)| match status.try_into() {
            Ok(WithdrawalStatus::Unprocessed) => Some(withdrawals[idx].clone()),
            _ => None, // Ignore other statuses
        })
        .collect();

    Ok((
        TransactionOutpoint {
            transaction_id: kaspa_tx_id,
            index: outpoint_data.index,
        },
        pending_withdrawals,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use kaspa_wallet_pskt::prelude::{Version, PSKT};

    #[test]
    fn test_withdrawfxg_bytes_roundtrip() {
        let msg = HyperlaneMessage::default();
        let messages = vec![
            vec![msg.clone()],
            vec![msg.clone(), msg.clone()],
            vec![msg.clone(), msg.clone(), msg.clone()],
        ];

        let pskt = PSKT::<kaspa_wallet_pskt::prelude::Creator>::default()
            .set_version(Version::One)
            .constructor()
            .no_more_outputs()
            .no_more_inputs()
            .payload(Some(msg.clone().to_vec()))
            .unwrap()
            .signer();

        let bundle = Bundle::from(pskt);

        let old = TransactionOutpoint::new(kaspa_hashes::Hash::default(), 10);
        let new = TransactionOutpoint::new(kaspa_hashes::Hash::default(), 20);

        let fxg = WithdrawFXG::new(bundle, messages, vec![old, new]);

        let bytes = Bytes::try_from(&fxg).unwrap();
        let fxg2 = WithdrawFXG::try_from(bytes).unwrap();

        assert_eq!(fxg.messages, fxg2.messages);
        assert_eq!(fxg.anchors, fxg2.anchors);
    }
}
