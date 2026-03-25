// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";

/**
 * @title TronInterchainSecurityModule
 * @notice Tron-specific ISM that handles Tron address verification
 * @dev This ISM can be used as a base for Tron-specific security modules
 */
abstract contract TronInterchainSecurityModule is IInterchainSecurityModule {
    using Message for bytes;

    /**
     * @notice Returns the ISM type
     * @return Type of ISM
     */
    function moduleType() external pure virtual returns (uint8);

    /**
     * @notice Verifies a message
     * @param _metadata Metadata needed for verification
     * @param _message The message to verify
     * @return True if the message is verified
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view virtual returns (bool);

    /**
     * @notice Helper function to convert Tron address to bytes32
     * @dev Tron addresses are base58 encoded, but in smart contracts they're 20-byte addresses
     * @param _addr Tron address
     * @return bytes32 representation
     */
    function tronAddressToBytes32(address _addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_addr)));
    }

    /**
     * @notice Helper function to convert bytes32 to Tron address
     * @param _buf bytes32 representation
     * @return Tron address
     */
    function bytes32ToTronAddress(bytes32 _buf) internal pure returns (address) {
        return address(uint160(uint256(_buf)));
    }
}
