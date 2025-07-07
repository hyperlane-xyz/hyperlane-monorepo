use super::payload::MessageID;
use bytes::Bytes;
use eyre::Error as EyreError;
use hex::ToHex;
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::H256;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_wallet_pskt::prelude::Bundle;
use serde::{Deserialize, Serialize};

/// WithdrawFXG resrents is sequence of PSKT transactions for batch processing and transport as
/// a single serialized payload. Bundle has mulpible PSKT. Each PSKT is associated with
/// some HL messages.
///
/// PSKT inside the bundle and its HL messages should live on respective indices, i.e.,
/// Bundle[0] = PSKT1, messages[0] = {M1, M2} <=> PSKT1 covers M1 and M2.
///
///      Bundle
///        /\
///       /  \
///      /    \
///  PSKT1    PSKT2
///    /\       /\
///   /  \     /  \
///  /    \   /    \
/// M1    M2 M3    M4
#[derive(Debug, Serialize, Deserialize)]
pub struct WithdrawFXG {
    pub bundle: Bundle,
    pub messages: Vec<Vec<HyperlaneMessage>>, // used in validation
                                              // TODO: add new/old anchors?
}

impl WithdrawFXG {
    pub fn new(bundle: Bundle, messages: Vec<Vec<HyperlaneMessage>>) -> Self {
        Self { bundle, messages }
    }

    pub fn default() -> Self {
        Self {
            bundle: Bundle::new(),
            messages: vec![],
        }
    }

    pub fn ids(&self) -> Vec<MessageID> {
        self.messages
            .iter()
            .flat_map(|m| m.iter().map(|m| MessageID(m.id())))
            .collect()
    }
}

impl TryFrom<Bytes> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let wire = WireWithdrawFXG::try_from(bytes)?;
        WithdrawFXG::try_from(wire)
    }
}

impl TryFrom<&WithdrawFXG> for Bytes {
    type Error = EyreError;

    fn try_from(x: &WithdrawFXG) -> Result<Self, Self::Error> {
        let wire: WireWithdrawFXG = WireWithdrawFXG::try_from(x)?;
        Bytes::try_from(&wire)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct WireWithdrawFXG {
    pub bundle: String,
    pub messages: Vec<Vec<HyperlaneMessage>>,
}

impl TryFrom<WireWithdrawFXG> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(wire: WireWithdrawFXG) -> Result<Self, Self::Error> {
        let bundle = Bundle::deserialize(&wire.bundle)
            .map_err(|e| eyre::eyre!("bundle deserialize: {e}"))?;
        Ok(WithdrawFXG {
            bundle,
            messages: wire.messages,
        })
    }
}

impl TryFrom<&WithdrawFXG> for WireWithdrawFXG {
    type Error = EyreError;

    fn try_from(fxg: &WithdrawFXG) -> Result<Self, Self::Error> {
        let bundle = fxg
            .bundle
            .serialize()
            .map_err(|e| eyre::eyre!("bundle serialize: {e}"))?;
        Ok(WireWithdrawFXG {
            bundle,
            messages: fxg.messages.clone(),
        })
    }
}

impl TryFrom<Bytes> for WireWithdrawFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        postcard::from_bytes(&bytes).map_err(|e| eyre::eyre!("wirewithdrawfxg deserialize: {e}"))
    }
}

impl TryFrom<&WireWithdrawFXG> for Bytes {
    type Error = EyreError;

    fn try_from(x: &WireWithdrawFXG) -> Result<Self, Self::Error> {
        let bytes_vec =
            postcard::to_allocvec(x).map_err(|e| eyre::eyre!("wirewithdrawfxg serialize: {e}"))?;
        Ok(Bytes::from(bytes_vec))
    }
}

pub async fn filter_pending_withdrawals(
    withdrawals: Vec<HyperlaneMessage>,
    cosmos: &CosmosGrpcClient,
    height: Option<u32>,
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
        .withdrawal_status(withdrawal_ids, height)
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

    #[test]
    fn test_withdrawfxg_bytes_roundtrip() {
        let msg = HyperlaneMessage::default();
        let messages = vec![vec![msg]];
        let bundle = Bundle::new();
        let fxg = WithdrawFXG::new(bundle, messages);

        let bytes = Bytes::try_from(&fxg).unwrap();
        let fxg2 = WithdrawFXG::try_from(bytes).unwrap();
    }
}
