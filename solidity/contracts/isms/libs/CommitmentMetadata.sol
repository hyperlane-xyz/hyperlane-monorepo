// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {OwnableMulticall} from "contracts/middleware/libs/OwnableMulticall.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";

/**
 * Format of metadata for commitments:
 *
 * [0:20] Ica address
 * [20:52] Salt
 * [52: ???] Abi encoded calls
 */
library CommitmentMetadata {
    uint internal constant SALT_OFFSET = 20;
    uint internal constant CALLS_OFFSET = SALT_OFFSET + 32;

    function cmIca(
        bytes calldata _metadata
    ) internal pure returns (OwnableMulticall) {
        address _ica = address(bytes20(_metadata[:SALT_OFFSET]));
        OwnableMulticall ica = OwnableMulticall(payable(_ica));
        return ica;
    }

    function cmSalt(bytes calldata _metadata) internal pure returns (bytes32) {
        return bytes32(_metadata[SALT_OFFSET:CALLS_OFFSET]);
    }

    function cmCalls(
        bytes calldata _metadata
    ) internal pure returns (CallLib.Call[] memory) {
        CallLib.Call[] memory _calls = abi.decode(
            _metadata[CALLS_OFFSET:],
            (CallLib.Call[])
        );
        return _calls;
    }

    function cmCommitment(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        return keccak256(_metadata[SALT_OFFSET:]);
    }
}
