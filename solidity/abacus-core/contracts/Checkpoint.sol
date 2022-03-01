// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";

abstract contract CheckpointVerifier {
    /**
     * @notice Checks that signature was signed by Validator
     * @param _domain Domain of Home contract
     * @param _root Merkle root
     * @param _index Corresponding leaf index
     * @param _signature Signature on `_root` and `_index`
     * @return TRUE iff signature is valid signed by validator
     **/
    function checkpointSigner(
        uint32 _domain,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) public pure returns (address) {
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash(_domain), _root, _index)
        );
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return ECDSA.recover(_digest, _signature);
    }

    /**
     * @notice Hash of domain concatenated with "OPTICS"
     * @param _domain the domain to hash
     */
    function domainHash(uint32 _domain) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "OPTICS"));
    }
}
