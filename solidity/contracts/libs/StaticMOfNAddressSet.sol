// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

abstract contract StaticMOfNAddressSet {
    /**
     * @notice Returns the current set and threshold.
     * @return The current set and threshold.
     */
    function _valuesAndThreshold()
        internal
        pure
        returns (address[] memory, uint8)
    {
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
        return abi.decode(data, (address[], uint8));
    }
}
