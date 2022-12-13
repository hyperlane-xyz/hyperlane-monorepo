// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// https://eips.ethereum.org/EIPS/eip-1167

library MinimalProxy {
    function bytecode(address implementation)
        internal
        pure
        returns (bytes memory)
    {
        bytes10 creation = 0x3d602d80600a3d3981f3;
        bytes10 runtimePrefix = 0x363d3d373d3d3d363d73;
        bytes20 targetBytes = bytes20(implementation);
        bytes15 runtimeSuffix = 0x5af43d82803e903d91602b57fd5bf3;
        return
            abi.encodePacked(
                creation,
                runtimePrefix,
                targetBytes,
                runtimeSuffix
            );
    }
}
