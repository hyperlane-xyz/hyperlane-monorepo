// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {LegacyMultisigIsm} from "../isms/multisig/LegacyMultisigIsm.sol";
import {LegacyCheckpointLib} from "../libs/LegacyCheckpointLib.sol";

contract TestLegacyMultisigIsm is LegacyMultisigIsm {
    function getDomainHash(uint32 _origin, bytes32 _originMailbox)
        external
        pure
        returns (bytes32)
    {
        return LegacyCheckpointLib.domainHash(_origin, _originMailbox);
    }
}
