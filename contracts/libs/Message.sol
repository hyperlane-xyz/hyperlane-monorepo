// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

library Message {
    function format(bytes32 _recipient, uint256 _amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(_recipient, _amount);
    }

    function recipient(bytes calldata message) internal pure returns (bytes32) {
        return bytes32(message[0:32]);
    }

    function amount(bytes calldata message) internal pure returns (uint256) {
        return uint256(bytes32(message[32:64]));
    }

    // alias for ERC721
    function tokenId(bytes calldata message) internal pure returns (uint256) {
        return amount(message);
    }
}
