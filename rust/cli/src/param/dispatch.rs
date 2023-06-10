use std::path::PathBuf;

use crate::arg::*;
use crate::convert::hex_str_to_bytes;
use color_eyre::eyre::eyre;
use color_eyre::{eyre::Context, Report, Result};
use hyperlane_core::H160;

#[derive(Debug, PartialEq)]
pub struct DispatchParams {
    pub dest_id: u32,
    pub recipient_address: H160,
    pub payload: Vec<u8>,
}

impl TryFrom<DispatchArgs> for DispatchParams {
    type Error = Report;

    fn try_from(args: DispatchArgs) -> Result<Self> {
        Ok(Self {
            dest_id: args.dest,
            recipient_address: args.recipient,
            payload: read_payload(&args.payload, &args.file)?,
        })
    }
}

fn read_payload(hex_str: &Option<String>, file: &Option<PathBuf>) -> Result<Vec<u8>, Report> {
    if file.is_some() == hex_str.is_some() {
        return Err(eyre!("Specify exactly one of --payload and --file"));
    }

    let payload = if let Some(file) = file {
        std::fs::read(file)
            .with_context(|| format!("Failed to read payload from '{}'", file.to_string_lossy()))?
    } else if let Some(hex_str) = hex_str {
        hex_str_to_bytes(hex_str)
            .with_context(|| format!("Invalid hex string for payload {}", hex_str))?
    } else {
        // Should not get here due to earlier check.
        return Err(eyre!("Specify exactly one of --payload and --file"));
    };
    Ok(payload)
}
