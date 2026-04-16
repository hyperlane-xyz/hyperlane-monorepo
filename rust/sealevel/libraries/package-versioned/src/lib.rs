use solana_program::program::set_return_data;

/// Single source of truth for all Hyperlane SVM program versions.
/// Compiled into each program's binary — atomic on upgrade, no migration step.
pub const PACKAGE_VERSION: &str = "1.0.0";

/// Trait for programs that expose their version.
/// Programs implement with empty impl block to get the default.
pub trait PackageVersioned {
    fn package_version() -> &'static str {
        PACKAGE_VERSION
    }
}

/// Shared handler for the `GetProgramVersion` instruction.
/// Writes the version string as return data.
pub fn process_get_program_version<T: PackageVersioned>() {
    let version = T::package_version();
    set_return_data(version.as_bytes());
}
