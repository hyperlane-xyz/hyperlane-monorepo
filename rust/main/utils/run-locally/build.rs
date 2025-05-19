#[cfg(feature = "fuel")]
use {
    reqwest::blocking::get,
    std::path::Path,
    std::{
        fs::{create_dir_all, File},
        io::Write,
    },
    zip::ZipArchive,
};

use anyhow::Result;
use vergen::EmitBuilder;

fn main() -> Result<()> {
    EmitBuilder::builder().git_sha(false).emit()?;

    #[cfg(feature = "fuel")]
    {
        download_fuel_artifacts()?;
    }

    Ok(())
}

#[cfg(feature = "fuel")]
fn download_fuel_artifacts() -> Result<()> {
    let expected_contracts_dir = Path::new("./src/fuel/fuel-contracts");

    // check if the contracts are already downloaded
    if expected_contracts_dir.read_dir().is_ok() {
        return Ok(());
    };

    let response = get("https://github.com/FuelLabs/fuel-hyperlane-integration/releases/download/v0.0.1/fuel-contracts.zip")?;
    let bytes = match response.status().is_success() {
        true => response.bytes()?,
        false => panic!("Download failed: HTTP {}", response.status()),
    };

    // Write the downloaded bytes to a file
    let out_zip_path = Path::new("./src/fuel/fuel-artifacts.zip");
    let mut file = File::create(out_zip_path)?;
    file.write_all(&bytes)?;

    // Open the ZIP file and extract its contents
    let zip_file = File::open(out_zip_path)?;
    let mut archive = ZipArchive::new(zip_file)?;

    let extract_dir = Path::new("./src/fuel/fuel-contracts");
    create_dir_all(extract_dir)?;
    archive.extract(extract_dir)?;

    // Delete the ZIP file
    std::fs::remove_file(out_zip_path)?;

    Ok(())
}
