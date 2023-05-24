// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {CheckpointLib} from "./CheckpointLib.sol";

library LegacyCheckpointLib {
    /**
     * @notice Returns the digest validators are expected to sign when signing legacy checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @return The digest of the legacy checkpoint.
     */
    function digest(
        uint32 _origin,
        bytes32 _originMailbox,
        bytes32 _checkpointRoot,
        uint32 _checkpointIndex
    ) internal pure returns (bytes32) {
        bytes32 _domainHash = domainHash(_origin, _originMailbox);
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        _checkpointRoot,
                        _checkpointIndex
                    )
                )
            );
    }

    /**
     * @notice Returns the domain hash that validators are expected to use
     * when signing checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @return The domain hash.
     */
    function domainHash(uint32 _origin, bytes32 _originMailbox)
        internal
        pure
        returns (bytes32)
    {
        return CheckpointLib.domainHash(_origin, _originMailbox);
    }
}
