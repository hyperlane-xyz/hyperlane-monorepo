// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title CrossChainVaultMessage
 * @notice Binary codec library for cross-chain vault messages over Hyperlane.
 */
library CrossChainVaultMessage {
    uint8 internal constant TYPE_DEPOSIT = 1;
    uint8 internal constant TYPE_WITHDRAW = 2;
    uint8 internal constant TYPE_NAV_REPORT = 3;
    uint8 internal constant TYPE_REBALANCE_EXECUTE = 4;
    uint8 internal constant TYPE_EMERGENCY_UNWIND = 5;

    struct Message {
        uint8 msgType;
        bytes32 recipientOrSender;
        uint256 amount;
        uint256 minAmountOut;
        uint256 deadline;
        bytes extraData;
    }

    /**
     * @notice Formats a Message struct into an encoded binary byte payload.
     * @param _msg The message struct to serialize.
     * @return Formatted byte payload.
     */
    function format(Message memory _msg) internal pure returns (bytes memory) {
        validate(_msg);
        return abi.encode(
            _msg.msgType,
            _msg.recipientOrSender,
            _msg.amount,
            _msg.minAmountOut,
            _msg.deadline,
            _msg.extraData
        );
    }

    /**
     * @notice Parses a calldata payload into a Message struct with strict validation.
     * @param _data Raw calldata payload.
     * @return _msg Deserialized Message struct.
     */
    function parse(bytes calldata _data) internal pure returns (Message memory _msg) {
        require(_data.length >= 192, "Invalid message length: payload too short");
        (
            _msg.msgType,
            _msg.recipientOrSender,
            _msg.amount,
            _msg.minAmountOut,
            _msg.deadline,
            _msg.extraData
        ) = abi.decode(_data, (uint8, bytes32, uint256, uint256, uint256, bytes));
        validate(_msg);
    }

    /**
     * @notice Parses a memory payload into a Message struct with strict validation.
     * @param _data Raw memory byte payload.
     * @return _msg Deserialized Message struct.
     */
    function parseMemory(bytes memory _data) internal pure returns (Message memory _msg) {
        require(_data.length >= 192, "Invalid message length: payload too short");
        (
            _msg.msgType,
            _msg.recipientOrSender,
            _msg.amount,
            _msg.minAmountOut,
            _msg.deadline,
            _msg.extraData
        ) = abi.decode(_data, (uint8, bytes32, uint256, uint256, uint256, bytes));
        validate(_msg);
    }

    /**
     * @notice Validates that a message has a valid type and fields.
     */
    function validate(Message memory _msg) internal pure {
        require(
            _msg.msgType >= TYPE_DEPOSIT && _msg.msgType <= TYPE_EMERGENCY_UNWIND,
            "Invalid message type: unknown type identifier"
        );
        require(_msg.recipientOrSender != bytes32(0), "Invalid message: zero recipient or sender");
    }

    /**
     * @notice Helper to construct and encode a deposit message.
     */
    function encodeDeposit(
        bytes32 _recipient,
        uint256 _amount,
        uint256 _minSharesOut,
        uint256 _deadline,
        bytes memory _extraData
    ) internal pure returns (bytes memory) {
        return format(
            Message({
                msgType: TYPE_DEPOSIT,
                recipientOrSender: _recipient,
                amount: _amount,
                minAmountOut: _minSharesOut,
                deadline: _deadline,
                extraData: _extraData
            })
        );
    }

    /**
     * @notice Helper to construct and encode a withdrawal message.
     */
    function encodeWithdraw(
        bytes32 _recipient,
        uint256 _amount,
        uint256 _minAssetsOut,
        uint256 _deadline,
        bytes memory _extraData
    ) internal pure returns (bytes memory) {
        return format(
            Message({
                msgType: TYPE_WITHDRAW,
                recipientOrSender: _recipient,
                amount: _amount,
                minAmountOut: _minAssetsOut,
                deadline: _deadline,
                extraData: _extraData
            })
        );
    }

    /**
     * @notice Helper to construct and encode a NAV report message.
     */
    function encodeNavReport(
        bytes32 _sender,
        uint256 _currentNav,
        uint256 _timestamp,
        bytes memory _extraData
    ) internal pure returns (bytes memory) {
        return format(
            Message({
                msgType: TYPE_NAV_REPORT,
                recipientOrSender: _sender,
                amount: _currentNav,
                minAmountOut: 0,
                deadline: _timestamp,
                extraData: _extraData
            })
        );
    }

    /**
     * @notice Helper to construct and encode a rebalance execution message.
     */
    function encodeRebalanceExecute(
        bytes32 _targetAdapter,
        uint256 _amount,
        uint256 _minAmountOut,
        uint256 _deadline,
        bytes memory _extraData
    ) internal pure returns (bytes memory) {
        return format(
            Message({
                msgType: TYPE_REBALANCE_EXECUTE,
                recipientOrSender: _targetAdapter,
                amount: _amount,
                minAmountOut: _minAmountOut,
                deadline: _deadline,
                extraData: _extraData
            })
        );
    }

    /**
     * @notice Helper to construct and encode an emergency unwind message.
     */
    function encodeEmergencyUnwind(
        bytes32 _targetAdapter,
        uint256 _minAmountOut,
        uint256 _deadline,
        bytes memory _extraData
    ) internal pure returns (bytes memory) {
        return format(
            Message({
                msgType: TYPE_EMERGENCY_UNWIND,
                recipientOrSender: _targetAdapter,
                amount: 0,
                minAmountOut: _minAmountOut,
                deadline: _deadline,
                extraData: _extraData
            })
        );
    }
}
