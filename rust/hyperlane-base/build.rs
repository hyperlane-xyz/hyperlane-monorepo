use anyhow::Result;
use vergen::EmitBuilder;

fn main() -> Result<()> {
    EmitBuilder::builder().git_sha(false).emit()?;

    Ok(())
}
