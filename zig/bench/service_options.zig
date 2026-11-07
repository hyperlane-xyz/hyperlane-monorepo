//! Direct-build options for separately named actual validator benchmark binaries.
pub const role = "validator";
// Direct manual builds have an honest unknown identity; build_validator.py
// generates and pins actual per-build options instead.
pub const git_sha = "VERGEN_IDEMPOTENT_OUTPUT";
