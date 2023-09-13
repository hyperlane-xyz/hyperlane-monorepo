use serde::{de::DeserializeOwned, Deserialize, Serialize};

use solana_program::pubkey::Pubkey;

use std::{fs::File, io::Write, path::Path};

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
