// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

library TokenMessage {
    uint8 internal constant RECIPIENT_OFFSET = 0;
    uint8 internal constant AMOUNT_OFFSET = 32;
    uint8 internal constant METADATA_OFFSET = 64;

    function format(
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _metadata
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_recipient, _amount, _metadata);
    }

    function format(
        bytes32 _recipient,
        uint256 _amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_recipient, _amount);
    }

    function recipient(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[RECIPIENT_OFFSET:RECIPIENT_OFFSET + 32]);
    }

    function amount(bytes calldata message) internal pure returns (uint256) {
        return uint256(bytes32(message[AMOUNT_OFFSET:AMOUNT_OFFSET + 32]));
    }

    // alias for ERC721
    function tokenId(bytes calldata message) internal pure returns (uint256) {
        return amount(message);
    }

    function metadata(
        bytes calldata message
    ) internal pure returns (bytes calldata) {
        return message[METADATA_OFFSET:];
    }
}
