use bytes::Bytes;
use eyre::Error as EyreError;

// NOTE: it should be possible to get a ProgressIndication from it
pub struct ConfirmationFXG;

impl TryFrom<Bytes> for ConfirmationFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        unimplemented!()
    }
}

impl From<&ConfirmationFXG> for Bytes {
    fn from(x: &ConfirmationFXG) -> Self {
        unimplemented!()
    }
}
