// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {MultisigIsm} from "../isms/MultisigIsm.sol";

contract TestMultisigIsm is MultisigIsm(msg.sender) {
    function getDomainHash(uint32 _origin, bytes32 _originMailbox)
        external
        pure
        returns (bytes32)
    {
        return _getDomainHash(_origin, _originMailbox);
    }

    function getCheckpointDigest(bytes calldata _metadata, uint32 _origin)
        external
        pure
        returns (bytes32)
    {
        return _getCheckpointDigest(_metadata, _origin);
    }
}
