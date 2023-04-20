// SPDX-License-Identifier: CC0-1.0
pragma solidity >=0.7.6;

/// @dev Adapted from https://eips.ethereum.org/EIPS/eip-3448
library MetaProxy {
    bytes32 private constant PREFIX =
        hex"600b380380600b3d393df3363d3d373d3d3d3d60368038038091363936013d73";
    bytes13 private constant SUFFIX = hex"5af43d3d93803e603457fd5bf3";

    function bytecode(address _implementation, bytes memory _metadata)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                PREFIX,
                bytes20(_implementation),
                SUFFIX,
                _metadata,
                _metadata.length
            );
    }

    function metadata() internal pure returns (bytes memory) {
        bytes memory data;
        assembly {
            let posOfMetadataSize := sub(calldatasize(), 32)
            let size := calldataload(posOfMetadataSize)
            let dataPtr := sub(posOfMetadataSize, size)
            data := mload(64)
            // increment free memory pointer by metadata size + 32 bytes (length)
            mstore(64, add(data, add(size, 32)))
            mstore(data, size)
            let memPtr := add(data, 32)
            calldatacopy(memPtr, dataPtr, size)
        }
        return data;
    }
}
