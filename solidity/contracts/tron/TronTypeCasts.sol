// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title TronTypeCasts
 * @notice Type conversion utilities for Tron
 * @dev Handles Tron-specific address conversions
 */
library TronTypeCasts {
    /**
     * @notice Converts a Tron address to bytes32
     * @dev Tron addresses in smart contracts are standard 20-byte addresses
     * @param _addr Tron address
     * @return bytes32 representation
     */
    function tronAddressToBytes32(address _addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_addr)));
    }

    /**
     * @notice Converts bytes32 to a Tron address
     * @param _buf bytes32 representation
     * @return Tron address
     */
    function bytes32ToTronAddress(bytes32 _buf) internal pure returns (address) {
        return address(uint160(uint256(_buf)));
    }

    /**
     * @notice Converts a Tron address string (base58) to address
     * @dev This would require an external call or off-chain conversion
     * For on-chain, we assume the address is already in 20-byte format
     * @param _addr Tron address in 20-byte format
     * @return address
     */
    function stringToTronAddress(address _addr) internal pure returns (address) {
        return _addr;
    }

    /**
     * @notice Converts address to Tron string (base58)
     * @dev This is a placeholder - actual base58 encoding should be done off-chain
     * @param _addr Tron address
     * @return string representation (placeholder)
     */
    function tronAddressToString(address _addr) internal pure returns (string memory) {
        // Base58 encoding should be done off-chain due to complexity
        // Return hex string as placeholder
        bytes memory b = new bytes(20);
        for (uint256 i = 0; i < 20; i++) {
            b[i] = bytes1(uint8(uint256(uint160(_addr)) / (2 ** (8 * (19 - i)))));
        }
        return string(abi.encodePacked("0x", _toHexString(b)));
    }

    /**
     * @notice Internal helper to convert bytes to hex string
     */
    function _toHexString(bytes memory data) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(2 + data.length * 2);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            str[2 + i * 2] = alphabet[uint256(uint8(data[i] >> 4))];
            str[3 + i * 2] = alphabet[uint256(uint8(data[i] & 0x0f))];
        }
        return string(str);
    }
}
