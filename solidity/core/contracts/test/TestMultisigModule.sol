// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {MultisigModule} from "../modules/MultisigModule.sol";

contract TestMultisigModule is MultisigModule {
    function verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) external pure returns (bool) {
        return _verifyMerkleProof(_metadata, _message);
    }

    function verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view returns (bool) {
        return _verifyValidatorSignatures(_metadata, _message);
    }

    function signedDigest(bytes calldata _metadata, uint32 _origin)
        external
        pure
        returns (bytes32)
    {
        return _signedDigest(_metadata, _origin);
    }
}
