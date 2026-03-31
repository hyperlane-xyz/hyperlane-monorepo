// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ITokenMessenger {
    function messageBodyVersion() external returns (uint32);
}

interface ITokenMessengerV1 is ITokenMessenger {
    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller
    );

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 _nonce);
}
