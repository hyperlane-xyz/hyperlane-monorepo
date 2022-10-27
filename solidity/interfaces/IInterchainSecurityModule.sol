// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IInterchainSecurityModule {
    // Called by the Mailbox to determine whether or not the message should be accepted.
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool);
}

interface IUsesInterchainSecurityModule {
    function interchainSecurityModule()
        external
        view
        returns (IInterchainSecurityModule);
}
