use serde::{de::DeserializeOwned, Deserialize, Serialize};

use hyperlane_core::H256;
use solana_program::pubkey::Pubkey;

use std::{fs::File, io::Write, path::Path, str::FromStr};

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct SingularProgramIdArtifact {
    #[serde(with = "crate::serde::serde_pubkey")]
    pub program_id: Pubkey,
}

impl From<Pubkey> for SingularProgramIdArtifact {
    fn from(val: Pubkey) -> Self {
        SingularProgramIdArtifact { program_id: val }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct HexAndBase58ProgramIdArtifact {
    hex: String,
    base58: String,
}

impl From<H256> for HexAndBase58ProgramIdArtifact {
    fn from(val: H256) -> Self {
        HexAndBase58ProgramIdArtifact {
            hex: format!("0x{}", hex::encode(val)),
            base58: Pubkey::new_from_array(val.to_fixed_bytes()).to_string(),
        }
    }
}

impl From<&HexAndBase58ProgramIdArtifact> for Pubkey {
    fn from(val: &HexAndBase58ProgramIdArtifact) -> Self {
        Pubkey::from_str(&val.base58).unwrap()
    }
}

pub(crate) fn write_json<T>(path: &Path, program_id: T)
where
    T: Serialize,
{
    let json = serde_json::to_string_pretty(&program_id).unwrap();
    println!("Writing to file {} contents:\n{}", path.display(), json);

    let mut file = File::create(path).expect("Failed to create file");
    file.write_all(json.as_bytes())
        .expect("Failed write JSON to file");
}

pub(crate) fn read_json<T>(path: &Path) -> T
where
    T: DeserializeOwned,
{
    let file = File::open(path).expect("Failed to open JSON file");
    serde_json::from_reader(file).expect("Failed to read JSON file")
}
