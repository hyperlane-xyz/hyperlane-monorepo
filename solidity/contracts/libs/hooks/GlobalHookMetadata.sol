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
 * [0:1] version
 * [1:33] msg.value
 * [34:65] Gas limit for message (IGP)
 * [66:85] Refund address for message (IGP)
 * [86:] Custom metadata
 */
library GlobalHookMetadata {
    uint8 private constant VERSION_OFFSET = 0;
    uint8 private constant MSG_VALUE_OFFSET = 1;
    uint8 private constant GAS_LIMIT_OFFSET = 33;
    uint8 private constant REFUND_ADDRESS_OFFSET = 65;
    uint256 private constant MIN_METADATA_LENGTH = 85;

    /**
     * @notice Returns the version of the metadata.
     * @param _metadata ABI encoded global hook metadata.
     * @return Version of the metadata as uint8.
     */
    function version(bytes calldata _metadata) internal pure returns (uint8) {
        if (_metadata.length < VERSION_OFFSET + 1) return 0;
        return uint8(_metadata[VERSION_OFFSET]);
    }

    /**
     * @notice Returns the specified value for the message.
     * @param _metadata ABI encoded global hook metadata.
     * @return Value for the message as uint256.
     */
    function msgValue(bytes calldata _metadata, uint256 _default)
        internal
        pure
        returns (uint256)
    {
        if (_metadata.length < MSG_VALUE_OFFSET + 32) return _default;
        return
            uint256(bytes32(_metadata[MSG_VALUE_OFFSET:MSG_VALUE_OFFSET + 32]));
    }

    /**
     * @notice Returns the specified gas limit for the message.
     * @param _metadata ABI encoded global hook metadata.
     * @return Gas limit for the message as uint256.
     */
    function gasLimit(bytes calldata _metadata, uint256 _default)
        internal
        pure
        returns (uint256)
    {
        if (_metadata.length < GAS_LIMIT_OFFSET + 32) return _default;
        return
            uint256(bytes32(_metadata[GAS_LIMIT_OFFSET:GAS_LIMIT_OFFSET + 32]));
    }

    /**
     * @notice Returns the specified refund address for the message.
     * @param _metadata ABI encoded global hook metadata.
     * @return Refund address for the message as address.
     */
    function refundAddress(bytes calldata _metadata, address _default)
        internal
        pure
        returns (address)
    {
        if (_metadata.length < REFUND_ADDRESS_OFFSET + 20) return _default;
        return
            address(
                bytes20(
                    _metadata[REFUND_ADDRESS_OFFSET:REFUND_ADDRESS_OFFSET + 20]
                )
            );
    }

    /**
     * @notice Returns the specified refund address for the message.
     * @param _metadata ABI encoded global hook metadata.
     * @return Refund address for the message as address.
     */
    function getCustomMetadata(bytes calldata _metadata)
        internal
        pure
        returns (bytes memory)
    {
        if (_metadata.length < MIN_METADATA_LENGTH) return "";
        return _metadata[MIN_METADATA_LENGTH:];
    }

    /**
     * @notice Formats the specified gas limit and refund address into global hook metadata.
     * @param _version Version of the metadata.
     * @param _msgValue msg.value for the message.
     * @param _gasLimit Gas limit for the message.
     * @param _refundAddress Refund address for the message.
     * @param _customMetadata Additional metadata to include in the global hook metadata.
     * @return ABI encoded global hook metadata.
     */
    function formatMetadata(
        uint8 _version,
        uint256 _msgValue,
        uint256 _gasLimit,
        address _refundAddress,
        bytes memory _customMetadata
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _version,
                _msgValue,
                _gasLimit,
                _refundAddress,
                _customMetadata
            );
    }
}
