//! External evidence is required in addition to ordinary metric assertions.
//! Missing/unsupported native chain verifiers fail closed; never emulate Rust logs.
use eyre::Result;
pub fn live(expected_messages: u32) -> Result<bool> {
    crate::external_agents::checker("live", expected_messages)
}
pub fn restart(expected_pending: u32) -> Result<bool> {
    crate::external_agents::checker("restart", expected_pending)
}
/// Every external scenario needs final native/SQL/stopped-store acceptance.
pub fn finish<'a>(
    expected_messages: u32,
    children: impl IntoIterator<Item = &'a mut crate::external_agents::TrackedChild>,
) {
    if crate::external_agents::enabled() {
        crate::external_agents::stop_and_wait_roles(children)
            .unwrap_or_else(|error| panic!("final parent-owned shutdown: {error:#}"));
        match crate::external_agents::checker("final", expected_messages) {
            Ok(true) => {}
            Ok(false) => panic!("final actual-node/store evidence did not pass"),
            Err(error) => panic!("final actual-node/store evidence: {error:#}"),
        }
    }
}
