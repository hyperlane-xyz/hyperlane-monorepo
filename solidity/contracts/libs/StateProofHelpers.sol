// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {RLPReader} from "./rlp/RLPReader.sol";
import {RLPWriter} from "./rlp/RLPWriter.sol";
import {MerkleTrie} from "./MerkleTrie.sol";

/// @notice Storage Proof library from Succinct (https://github.com/succinctlabs)
library StorageProof {
    using RLPReader for RLPReader.RLPItem;
    using RLPReader for bytes;

    function getStorageValue(
        bytes32 slotHash,
        bytes[] memory _stateProof,
        bytes32 storageRoot
    ) internal pure returns (uint256) {
        bytes memory valueRlpBytes = MerkleTrie.get(
            abi.encodePacked(slotHash),
            _stateProof,
            storageRoot
        );
        require(valueRlpBytes.length > 0, "Storage value does not exist");
        return valueRlpBytes.toRLPItem().readUint256();
    }

    function getStorageRoot(
        address contractAddress,
        bytes[] memory proof,
        bytes32 stateRoot
    ) internal pure returns (bytes32) {
        bytes32 addressHash = keccak256(abi.encodePacked(contractAddress));
        bytes memory acctRlpBytes = MerkleTrie.get(
            abi.encodePacked(addressHash),
            proof,
            stateRoot
        );
        require(acctRlpBytes.length > 0, "Account does not exist");
        RLPReader.RLPItem[] memory acctFields = acctRlpBytes
            .toRLPItem()
            .readList();
        require(acctFields.length == 4);
        return bytes32(acctFields[2].readUint256());
    }
}
