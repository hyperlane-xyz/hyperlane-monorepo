// SPDX-License-Identifier: CC0-1.0
pragma solidity >=0.7.6;

library MetaProxyFactory {
    /// @dev Creates a proxy for `targetContract` with metadata from `metadata`.
    /// @return A non-zero address if successful.
    function fromBytes(address targetContract, bytes memory metadata)
        internal
        returns (address)
    {
        uint256 ptr;
        assembly {
            ptr := add(metadata, 32)
        }
        return _fromMemory(targetContract, ptr, metadata.length);
    }

    /// @dev Creates a new proxy for `targetContract` with metadata from memory starting at `offset` and `length` bytes.
    /// @return addr A non-zero address if successful.
    function _fromMemory(
        address targetContract,
        uint256 offset,
        uint256 length
    ) private returns (address addr) {
        // the following assembly code (init code + contract code) constructs a metaproxy.
        assembly {
            // load free memory pointer as per solidity convention
            let start := mload(64)
            // keep a copy
            let ptr := start
            // deploy code (11 bytes) + first part of the proxy (21 bytes)
            mstore(
                ptr,
                0x600b380380600b3d393df3363d3d373d3d3d3d60368038038091363936013d73
            )
            ptr := add(ptr, 32)

            // store the address of the contract to be called
            mstore(ptr, shl(96, targetContract))
            // 20 bytes
            ptr := add(ptr, 20)

            // the remaining proxy code...
            mstore(
                ptr,
                0x5af43d3d93803e603457fd5bf300000000000000000000000000000000000000
            )
            // ...13 bytes
            ptr := add(ptr, 13)

            // copy the metadata
            {
                for {
                    let i := 0
                } lt(i, length) {
                    i := add(i, 32)
                } {
                    mstore(add(ptr, i), mload(add(offset, i)))
                }
            }
            ptr := add(ptr, length)
            // store the size of the metadata at the end of the bytecode
            mstore(ptr, length)
            ptr := add(ptr, 32)

            // The size is deploy code + contract code + calldatasize - 4 + 32.
            addr := create(0, start, sub(ptr, start))
        }
    }
}
