use bytes::Bytes;
use eyre::Error as EyreError;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use prost::Message;

pub struct ConfirmationFXG {
    pub progress_indication: ProgressIndication,
}

impl ConfirmationFXG {
    pub fn new(progress_indication: ProgressIndication) -> Self {
        Self { progress_indication }
    }
}

impl TryFrom<Bytes> for ConfirmationFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let progress_indication = ProgressIndication::decode(bytes.as_ref())?;
        Ok(ConfirmationFXG { progress_indication })
    }
}

impl From<&ConfirmationFXG> for Bytes {
    fn from(x: &ConfirmationFXG) -> Self {
        let encoded = x.progress_indication.encode_to_vec();
        Bytes::from(encoded)
    }
}
