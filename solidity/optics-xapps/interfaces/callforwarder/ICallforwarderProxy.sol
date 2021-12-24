// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface ICallforwarderProxy {
    function callFromRouter(
        address _from,
        uint32 _origin,
        bytes calldata _data
    ) external returns (bytes memory _ret);
}
