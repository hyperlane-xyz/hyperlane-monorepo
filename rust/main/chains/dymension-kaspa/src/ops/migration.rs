use bytes::Bytes;
use eyre::Error as EyreError;
use hyperlane_cosmos_rs::dymensionxyz::hyperlane::kaspa::MigrationFxg as ProtoMigrationFxg;
use hyperlane_cosmos_rs::prost::Message;
use kaspa_wallet_pskt::prelude::Bundle;

/// MigrationFXG represents a PSKT bundle for migrating funds from old escrow to new escrow.
/// The validator derives expected anchor and target address from local config.
#[derive(Debug)]
pub struct MigrationFXG {
    pub bundle: Bundle,
}

impl MigrationFXG {
    pub fn new(bundle: Bundle) -> Self {
        Self { bundle }
    }
}

impl TryFrom<Bytes> for MigrationFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let p = ProtoMigrationFxg::decode(bytes)
            .map_err(|e| eyre::eyre!("MigrationFXG deserialize: {}", e))?;
        MigrationFXG::try_from(p)
    }
}

impl TryFrom<&MigrationFXG> for Bytes {
    type Error = EyreError;

    fn try_from(x: &MigrationFXG) -> Result<Self, Self::Error> {
        let p = ProtoMigrationFxg::try_from(x)
            .map_err(|e| eyre::eyre!("MigrationFXG serialize: {}", e))?;
        Ok(Bytes::from(p.encode_to_vec()))
    }
}

impl TryFrom<ProtoMigrationFxg> for MigrationFXG {
    type Error = EyreError;

    fn try_from(pb: ProtoMigrationFxg) -> Result<Self, Self::Error> {
        Ok(MigrationFXG {
            bundle: Bundle::try_from(pb.pskt_bundle)
                .map_err(|e| eyre::eyre!("pskt deserialize: {}", e))?,
        })
    }
}

impl TryFrom<&MigrationFXG> for ProtoMigrationFxg {
    type Error = EyreError;

    fn try_from(v: &MigrationFXG) -> Result<Self, Self::Error> {
        Ok(ProtoMigrationFxg {
            pskt_bundle: v
                .bundle
                .serialize()
                .map_err(|e| eyre::eyre!("bundle serialize: {}", e))?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaspa_wallet_pskt::prelude::{Version, PSKT};

    #[test]
    fn test_migrationfxg_bytes_roundtrip() {
        let pskt = PSKT::<kaspa_wallet_pskt::prelude::Creator>::default()
            .set_version(Version::One)
            .constructor()
            .no_more_outputs()
            .no_more_inputs()
            .signer();

        let bundle = Bundle::from(pskt);
        let fxg = MigrationFXG::new(bundle);

        let bytes = Bytes::try_from(&fxg).unwrap();
        let fxg2 = MigrationFXG::try_from(bytes).unwrap();

        assert_eq!(fxg.bundle.0.len(), fxg2.bundle.0.len());
    }
}
