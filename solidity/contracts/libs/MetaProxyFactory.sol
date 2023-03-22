// SPDX-License-Identifier: CC0-1.0
pragma solidity >=0.7.6;

/// @dev Adapted from https://eips.ethereum.org/EIPS/eip-3448
library MetaProxyFactory {
    bytes32 constant PREFIX =
        hex"600b380380600b3d393df3363d3d373d3d3d3d60368038038091363936013d73";
    bytes13 constant SUFFIX = hex"5af43d3d93803e603457fd5bf3";

    function bytecode(address targetContract, bytes memory metadata)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                PREFIX,
                bytes20(targetContract),
                SUFFIX,
                metadata,
                metadata.length
            );
    }
}
