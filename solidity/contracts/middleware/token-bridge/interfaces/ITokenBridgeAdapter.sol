pragma solidity ^0.8.13;

interface ITokenBridgeAdapter {
    function bridgeToken(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        address _token,
        uint256 _amount
    ) external returns (bytes memory _adapterData);

    function sendBridgedTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipientAddress,
        bytes calldata _adapterData, // The adapter data from the message
        uint256 _amount
    ) external returns (address, uint256);
}
