// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IBridgeRouter {
    function send(
        address _token,
        uint256 _amount,
        uint32 _destination,
        bytes32 _recipient
    ) external;
}
