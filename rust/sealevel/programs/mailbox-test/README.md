# mailbox-test

These are functional tests that ordinarily would live in `programs/mailbox/tests`, however
due to some funky dependency resolution, the building the SBF .so files included some dev dependencies
that would result in errors when trying to deploy the programs.

As a (slightly hacky) fix, these tests are pulled into an entirely separate crate.
