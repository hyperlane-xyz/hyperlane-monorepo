use colored::*;
use eyre::Result;
use hyperlane_core::MatchingList;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

pub struct ReadMatchingList {
    pub file_name: Option<String>,
}

impl ReadMatchingList {
    pub async fn read(&self) -> Result<Option<MatchingList>> {
        match &self.file_name {
            None => Ok(None),
            Some(file_name_value) => {
                println!(
                    "{}",
                    format!(
                        "Reading {} as the matching list file",
                        file_name_value.cyan().bold()
                    )
                    .yellow()
                    .bold()
                );

                let mut file = match File::open(file_name_value).await {
                    Ok(result) => result,
                    Err(err) => return Err(err.into()),
                };

                let mut contents = Vec::new();
                match file.read_to_end(&mut contents).await {
                    Ok(_) => {}
                    Err(err) => return Err(err.into()),
                }

                let data: MatchingList = match serde_json::from_slice(&contents) {
                    Ok(result) => result,
                    Err(err) => return Err(err.into()),
                };
                return Ok(Some(data));
            }
        }
    }
}
