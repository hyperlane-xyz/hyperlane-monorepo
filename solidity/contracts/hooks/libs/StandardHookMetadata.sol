// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

/**
 * Format of metadata:
 *
 * Variant 1 (native gas payment):
 * [0:2]   variant (uint16) = 1
 * [2:34]  msg.value (uint256)
 * [34:66] Gas limit for message (uint256)
 * [66:86] Refund address (address)
 *
 * Variant 2 (ERC20 token gas payment):
 * [0:2]   variant (uint16) = 2
 * [2:34]  msg.value (uint256)
 * [34:66] Gas limit for message (uint256)
 * [66:86] Refund address (address)
 * [86:106] Fee token address (address)
 */

library StandardHookMetadata {
    struct Metadata {
        uint16 variant;
        uint256 msgValue;
        uint256 gasLimit;
        address refundAddress;
    }

    uint8 private constant VARIANT_OFFSET = 0;
    uint8 private constant MSG_VALUE_OFFSET = 2;
    uint8 private constant GAS_LIMIT_OFFSET = 34;
    uint8 private constant REFUND_ADDRESS_OFFSET = 66;
    uint8 private constant FEE_TOKEN_OFFSET = 86;

    uint16 public constant VARIANT = 1;
    uint16 public constant VARIANT_TOKEN = 2;

    /**
     * @notice Returns the variant of the metadata.
     * @param _metadata ABI encoded standard hook metadata.
     * @return variant of the metadata as uint16.
     */
    function variant(bytes calldata _metadata) internal pure returns (uint16) {
        if (_metadata.length < VARIANT_OFFSET + 2) return 0;
        return uint16(bytes2(_metadata[VARIANT_OFFSET:VARIANT_OFFSET + 2]));
    }

    /**
     * @notice Returns the variant of the metadata (memory version).
     * @param _metadata ABI encoded standard hook metadata.
     * @return _variant variant of the metadata as uint16.
     */
    function variantMem(
        bytes memory _metadata
    ) internal pure returns (uint16 _variant) {
        if (_metadata.length < VARIANT_OFFSET + 2) return 0;
        assembly {
            _variant := mload(add(_metadata, add(32, VARIANT_OFFSET)))
        }
    }

    /**
     * @notice Returns the specified value for the message.
     * @param _metadata ABI encoded standard hook metadata.
     * @param _default Default fallback value.
     * @return Value for the message as uint256.
     */
    function msgValue(
        bytes calldata _metadata,
        uint256 _default
    ) internal pure returns (uint256) {
        if (_metadata.length < MSG_VALUE_OFFSET + 32) return _default;
        return
            uint256(bytes32(_metadata[MSG_VALUE_OFFSET:MSG_VALUE_OFFSET + 32]));
    }

    /**
     * @notice Returns the specified gas limit for the message.
     * @param _metadata ABI encoded standard hook metadata.
     * @param _default Default fallback gas limit.
     * @return Gas limit for the message as uint256.
     */
    function gasLimit(
        bytes calldata _metadata,
        uint256 _default
    ) internal pure returns (uint256) {
        if (_metadata.length < GAS_LIMIT_OFFSET + 32) return _default;
        return
            uint256(bytes32(_metadata[GAS_LIMIT_OFFSET:GAS_LIMIT_OFFSET + 32]));
    }

    function gasLimit(
        bytes memory _metadata
    ) internal pure returns (uint256 _gasLimit) {
        if (_metadata.length < GAS_LIMIT_OFFSET + 32) return 50_000;
        assembly {
            _gasLimit := mload(add(_metadata, add(0x20, GAS_LIMIT_OFFSET)))
        }
    }

    /**
     * @notice Returns the specified refund address for the message.
     * @param _metadata ABI encoded standard hook metadata.
     * @param _default Default fallback refund address.
     * @return Refund address for the message as address.
     */
    function refundAddress(
        bytes calldata _metadata,
        address _default
    ) internal pure returns (address) {
        if (_metadata.length < REFUND_ADDRESS_OFFSET + 20) return _default;
        return
            address(
                bytes20(
                    _metadata[REFUND_ADDRESS_OFFSET:REFUND_ADDRESS_OFFSET + 20]
                )
            );
    }

    /**
     * @notice Returns the fee token address for token-based gas payments.
     * @param _metadata ABI encoded standard hook metadata.
     * @param _default Default fallback fee token (typically address(0) for native).
     * @return Fee token address, or _default if not specified or variant 1.
     */
    function feeToken(
        bytes calldata _metadata,
        address _default
    ) internal pure returns (address) {
        if (_metadata.length < FEE_TOKEN_OFFSET + 20) return _default;
        if (variant(_metadata) != VARIANT_TOKEN) return _default;
        return
            address(bytes20(_metadata[FEE_TOKEN_OFFSET:FEE_TOKEN_OFFSET + 20]));
    }

    /**
     * @notice Formats the specified gas limit and refund address into standard hook metadata.
     * @param _msgValue msg.value for the message.
     * @param _gasLimit Gas limit for the message.
     * @param _refundAddress Refund address for the message.
     * @return ABI encoded standard hook metadata.
     */
    function format(
        uint256 _msgValue,
        uint256 _gasLimit,
        address _refundAddress
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(VARIANT, _msgValue, _gasLimit, _refundAddress);
    }

    /**

    /**
     * @notice Formats the specified gas limit and refund address into standard hook metadata.
     * @param _msgValue msg.value for the message.
     * @param _gasLimit Gas limit for the message.
     * @param _refundAddress Refund address for the message.
     * @param _customMetadata Additional metadata to include in the standard hook metadata.
     * @return ABI encoded standard hook metadata.
     */
    function formatMetadata(
        uint256 _msgValue,
        uint256 _gasLimit,
        address _refundAddress,
        bytes memory _customMetadata
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                VARIANT,
                _msgValue,
                _gasLimit,
                _refundAddress,
                _customMetadata
            );
    }

    /**
     * @notice Formats the specified gas limit and refund address into standard hook metadata.
     * @param _msgValue msg.value for the message.
     * @return ABI encoded standard hook metadata.
     */
    function overrideMsgValue(
        uint256 _msgValue
    ) internal view returns (bytes memory) {
        return formatMetadata(_msgValue, uint256(0), msg.sender, "");
    }

    /**
     * @notice Formats the specified gas limit and refund address into standard hook metadata.
     * @param _gasLimit Gas limit for the message.
     * @return ABI encoded standard hook metadata.
     */
    function overrideGasLimit(
        uint256 _gasLimit
    ) internal view returns (bytes memory) {
        return formatMetadata(uint256(0), _gasLimit, msg.sender, "");
    }

    /**
     * @notice Formats the specified refund address into standard hook metadata.
     * @param _refundAddress Refund address for the message.
     * @return ABI encoded standard hook metadata.
     */
    function overrideRefundAddress(
        address _refundAddress
    ) internal pure returns (bytes memory) {
        return formatMetadata(uint256(0), uint256(0), _refundAddress, "");
    }

    /**
     * @notice Formats variant 2 metadata with fee token for token-based gas payments.
     * @param _msgValue msg.value for the message.
     * @param _gasLimit Gas limit for the message.
     * @param _refundAddress Refund address for the message (unused for token payments, reserved for future use).
     * @param _feeToken Fee token address for gas payment.
     * @return ABI encoded variant 2 hook metadata.
     */
    function formatWithFeeToken(
        uint256 _msgValue,
        uint256 _gasLimit,
        address _refundAddress,
        address _feeToken
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                VARIANT_TOKEN,
                _msgValue,
                _gasLimit,
                _refundAddress,
                _feeToken
            );
    }

    /**
     * @notice Formats variant 2 metadata with gas limit and fee token.
     * @param _gasLimit Gas limit for the message.
     * @param _feeToken Fee token address for gas payment.
     * @return ABI encoded variant 2 hook metadata.
     */
    function overrideGasLimitAndFeeToken(
        uint256 _gasLimit,
        address _feeToken
    ) internal view returns (bytes memory) {
        return formatWithFeeToken(uint256(0), _gasLimit, msg.sender, _feeToken);
    }

    function getRefundAddress(
        bytes memory _metadata,
        address _default
    ) internal pure returns (address) {
        if (_metadata.length < REFUND_ADDRESS_OFFSET + 20) return _default;
        address result;
        assembly {
            let data_start_ptr := add(_metadata, 32) // Skip length prefix of _metadata
            let mload_ptr := add(data_start_ptr, sub(REFUND_ADDRESS_OFFSET, 12))
            result := mload(mload_ptr) // Loads 32 bytes; address takes lower 20 bytes.
        }
        return result;
    }
}
