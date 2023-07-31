// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

library OPStackHookMetadata {
    function msgValue(bytes calldata _metadata)
        internal
        pure
        returns (uint256)
    {
        return abi.decode(_metadata, (uint256));
    }
}
