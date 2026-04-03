// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {RLPReader} from "./RLPReader.sol";

/**
 * @title MerklePatriciaTrie
 * @notice Verifies Merkle Patricia Trie proofs for Ethereum state/receipt verification
 * @dev Implements verification against receiptsRoot for receipt proofs
 */
library MerklePatriciaTrie {
    // Node types in MPT
    uint8 private constant BRANCH_NODE_LENGTH = 17;
    uint8 private constant LEAF_OR_EXTENSION_MIN_LENGTH = 2;

    /**
     * @notice Verifies an MPT proof and returns the value
     * @param _root The expected root hash
     * @param _key The key (RLP encoded transaction index for receipts)
     * @param _proof Array of RLP encoded proof nodes
     * @return value The verified value (RLP encoded receipt)
     */
    function verifyProof(
        bytes32 _root,
        bytes memory _key,
        bytes[] memory _proof
    ) internal pure returns (bytes memory value) {
        require(_proof.length > 0, "MPT: empty proof");

        bytes32 expectedHash = _root;
        bytes memory keyNibbles = _toNibbles(_key);
        uint256 keyIndex = 0;

        for (uint256 i = 0; i < _proof.length; i++) {
            bytes memory node = _proof[i];

            // Verify node hash matches expected
            require(
                keccak256(node) == expectedHash,
                "MPT: invalid proof node hash"
            );

            bytes[] memory nodeItems = RLPReader.decodeList(node);

            if (nodeItems.length == BRANCH_NODE_LENGTH) {
                if (keyIndex >= keyNibbles.length) {
                    return RLPReader.toBytes(nodeItems[16]);
                }

                uint8 nibble = uint8(keyNibbles[keyIndex]);
                require(nibble < 16, "MPT: invalid nibble");

                bytes memory nextNode = nodeItems[nibble];
                if (nextNode.length == 0) {
                    revert("MPT: empty branch child");
                }

                if (nextNode.length < 32) {
                    expectedHash = keccak256(nextNode);
                } else {
                    expectedHash = bytes32(RLPReader.toBytes(nextNode));
                }
                keyIndex++;
            } else if (nodeItems.length >= LEAF_OR_EXTENSION_MIN_LENGTH) {
                bytes memory encodedPath = RLPReader.toBytes(nodeItems[0]);
                (uint8 prefix, bytes memory path) = _parsePath(encodedPath);

                bool isLeaf = (prefix == 2 || prefix == 3);
                uint256 pathLen = path.length;
                require(
                    keyIndex + pathLen <= keyNibbles.length,
                    "MPT: key too short"
                );

                for (uint256 j = 0; j < pathLen; j++) {
                    require(
                        keyNibbles[keyIndex + j] == path[j],
                        "MPT: path mismatch"
                    );
                }
                keyIndex += pathLen;

                if (isLeaf) {
                    require(
                        keyIndex == keyNibbles.length,
                        "MPT: key not exhausted at leaf"
                    );
                    return RLPReader.toBytes(nodeItems[1]);
                } else {
                    bytes memory nextNode = nodeItems[1];
                    if (nextNode.length < 32) {
                        expectedHash = keccak256(nextNode);
                    } else {
                        expectedHash = bytes32(RLPReader.toBytes(nextNode));
                    }
                }
            } else {
                revert("MPT: invalid node length");
            }
        }

        revert("MPT: proof incomplete");
    }

    /**
     * @notice Converts bytes to nibbles (4-bit units)
     * @param _data Input bytes
     * @return nibbles Array of nibbles
     */
    function _toNibbles(
        bytes memory _data
    ) private pure returns (bytes memory nibbles) {
        nibbles = new bytes(_data.length * 2);
        for (uint256 i = 0; i < _data.length; i++) {
            nibbles[i * 2] = bytes1(uint8(_data[i]) >> 4);
            nibbles[i * 2 + 1] = bytes1(uint8(_data[i]) & 0x0f);
        }
    }

    /**
     * @notice Parses HP-encoded path from node
     * @param _encodedPath The HP-encoded path
     * @return prefix The prefix (0=ext-even, 1=ext-odd, 2=leaf-even, 3=leaf-odd)
     * @return path The decoded nibble path
     */
    function _parsePath(
        bytes memory _encodedPath
    ) private pure returns (uint8 prefix, bytes memory path) {
        require(_encodedPath.length > 0, "MPT: empty path");

        uint8 firstByte = uint8(_encodedPath[0]);
        prefix = firstByte >> 4;

        bool isOdd = (prefix == 1 || prefix == 3);

        if (isOdd) {
            path = new bytes(_encodedPath.length * 2 - 1);
            path[0] = bytes1(firstByte & 0x0f);
            for (uint256 i = 1; i < _encodedPath.length; i++) {
                path[i * 2 - 1] = bytes1(uint8(_encodedPath[i]) >> 4);
                path[i * 2] = bytes1(uint8(_encodedPath[i]) & 0x0f);
            }
        } else {
            path = new bytes((_encodedPath.length - 1) * 2);
            for (uint256 i = 1; i < _encodedPath.length; i++) {
                path[(i - 1) * 2] = bytes1(uint8(_encodedPath[i]) >> 4);
                path[(i - 1) * 2 + 1] = bytes1(uint8(_encodedPath[i]) & 0x0f);
            }
        }
    }
}
