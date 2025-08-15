pub const SOMPI_PER_KAS: u64 = 100_000_000;
pub fn som_to_kas(sompi: u64) -> String {
    format!("{} KAS", sompi as f64 / SOMPI_PER_KAS as f64)
}
