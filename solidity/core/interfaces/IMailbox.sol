// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IMailbox {
    function localDomain() external view returns (uint32);

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (uint256);

    function process(
        bytes32 _originMailbox,
        bytes32 _root,
        uint256 _index,
        bytes calldata _sovereignData,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external;

    function count() external view returns (uint256);

    function root() external view returns (bytes32);

    function latestCheckpoint() external view returns (bytes32, uint256);
}
