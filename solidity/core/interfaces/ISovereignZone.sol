// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface ISovereignZone {
    enum ZoneType {
        MULTISIG
    }

    // Used by relayers to determine how to structure sovereign data.
    function zoneType() external view returns (ZoneType);

    // Called by the Mailbox to determine whether the provided root
    // is valid to verify proofs against.
    function accept(
        bytes32 _root,
        uint256 _index,
        bytes calldata _sovereignData,
        bytes calldata _message
    ) external view returns (bool);
}
