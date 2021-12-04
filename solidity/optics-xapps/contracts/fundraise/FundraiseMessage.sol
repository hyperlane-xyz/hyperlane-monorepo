// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";

library FundraiseMessage {
    // ============ Libraries ============

    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // ============ Enums ============

    // WARNING: do NOT re-write the numbers / order
    // of message types in an upgrade;
    // will cause in-flight messages to be mis-interpreted
    enum Types {
        Invalid, // 0
        TokenId, // 1
        Message, // 2
        Transfer, // 3
        Deposit // 4
    }

    // ============ Constants ============

    uint256 private constant TOKEN_ID_LEN = 36; // 4 bytes domain + 32 bytes id
    uint256 private constant IDENTIFIER_LEN = 1;
    uint256 private constant TRANSFER_LEN = 65; // 1 byte identifier + 32 bytes recipient + 32 bytes amount
    uint256 private constant DEPOSIT_LEN = 65; // 1 byte identifier + 32 bytes recipient + 32 bytes amount

    // ============ Modifiers ============

    /**
     * @notice Asserts a message is of type `_t`
     * @param _view The message
     * @param _t The expected type
     */
    modifier typeAssert(bytes29 _view, Types _t) {
        _view.assertType(uint40(_t));
        _;
    }

    // ============ Internal Functions ============

    /**
     * @notice Checks that Action is valid type
     * @param _action The action
     * @return TRUE if action is valid
     */
    function isValidAction(bytes29 _action) internal pure returns (bool) {
        return isDeposit(_action) || isTransfer(_action);
    }

    /**
     * @notice Checks that view is a valid message length
     * @param _view The bytes string
     * @return TRUE if message is valid
     */
    function isValidMessageLength(bytes29 _view) internal pure returns (bool) {
        uint256 _len = _view.len();
        return
            _len == TOKEN_ID_LEN + TRANSFER_LEN ||
            _len == TOKEN_ID_LEN + DEPOSIT_LEN;
    }

    /**
     * @notice Formats an action message
     * @param _tokenId The token ID
     * @param _action The action
     * @return The formatted message
     */
    function formatMessage(bytes29 _tokenId, bytes29 _action)
        internal
        view
        typeAssert(_tokenId, Types.TokenId)
        returns (bytes memory)
    {
        require(isValidAction(_action), "!action");
        bytes29[] memory _views = new bytes29[](2);
        _views[0] = _tokenId;
        _views[1] = _action;
        return TypedMemView.join(_views);
    }

    /**
     * @notice Returns the type of the message
     * @param _view The message
     * @return The type of the message
     */
    function messageType(bytes29 _view) internal pure returns (Types) {
        return Types(uint8(_view.typeOf()));
    }

    /**
     * @notice Checks that the message is of type Transfer
     * @param _action The message
     * @return True if the message is of type Transfer
     */
    function isTransfer(bytes29 _action) internal pure returns (bool) {
        return
            actionType(_action) == uint8(Types.Transfer) &&
            messageType(_action) == Types.Transfer;
    }

    /**
     * @notice Checks that the message is of type Details
     * @param _action The message
     * @return True if the message is of type Details
     */
    function isDeposit(bytes29 _action) internal pure returns (bool) {
        return
            actionType(_action) == uint8(Types.Deposit) &&
            messageType(_action) == Types.Deposit;
    }

    /**
     * @notice Formats Transfer
     * @param _to The recipient address as bytes32
     * @param _amnt The transfer amount
     * @return
     */
    function formatTransfer(bytes32 _to, uint256 _amnt)
        internal
        pure
        returns (bytes29)
    {
        return
            mustBeTransfer(abi.encodePacked(Types.Transfer, _to, _amnt).ref(0));
    }

    /**
     * @notice Formats Deposit
     * @param _to The recipient address as bytes32
     * @param _amnt The Deposit amount
     * @return
     */
    function formatDeposit(bytes32 _to, uint256 _amnt)
        internal
        pure
        returns (bytes29)
    {
        return
            mustBeDeposit(abi.encodePacked(Types.Deposit, _to, _amnt).ref(0));
    }

    /**
     * @notice Formats the Token ID
     * @param _domain The domain
     * @param _id The ID
     * @return The formatted Token ID
     */
    function formatTokenId(uint32 _domain, bytes32 _id)
        internal
        pure
        returns (bytes29)
    {
        return mustBeTokenId(abi.encodePacked(_domain, _id).ref(0));
    }

    /**
     * @notice Retrieves the domain from a TokenID
     * @param _tokenId The message
     * @return The domain
     */
    function domain(bytes29 _tokenId)
        internal
        pure
        typeAssert(_tokenId, Types.TokenId)
        returns (uint32)
    {
        return uint32(_tokenId.indexUint(0, 4));
    }

    /**
     * @notice Retrieves the ID from a TokenID
     * @param _tokenId The message
     * @return The ID
     */
    function id(bytes29 _tokenId)
        internal
        pure
        typeAssert(_tokenId, Types.TokenId)
        returns (bytes32)
    {
        // before = 4 bytes domain
        return _tokenId.index(4, 32);
    }

    /**
     * @notice Retrieves the EVM ID
     * @param _tokenId The message
     * @return The EVM ID
     */
    function evmId(bytes29 _tokenId)
        internal
        pure
        typeAssert(_tokenId, Types.TokenId)
        returns (address)
    {
        // before = 4 bytes domain + 12 bytes empty to trim for address
        return _tokenId.indexAddress(16);
    }

    /**-
     * @notice Retrieves the action identifier from message
     * @param _message The action
     * @return The message type
     */
    function msgType(bytes29 _message) internal pure returns (uint8) {
        return uint8(_message.indexUint(TOKEN_ID_LEN, 1));
    }

    /**
     * @notice Retrieves the identifier from action
     * @param _action The action
     * @return The action type
     */
    function actionType(bytes29 _action) internal pure returns (uint8) {
        return uint8(_action.indexUint(0, 1));
    }

    /**
     * @notice Retrieves the recipient from a Deposit
     * @param _depositAction The message
     * @return The recipient address as bytes32
     */
    function recipient(bytes29 _depositAction) internal pure returns (bytes32) {
        // before = 1 byte identifier
        return _depositAction.index(1, 32);
    }

    /**
     * @notice Retrieves the EVM Recipient from a Deposit
     * @param _depositAction The message
     * @return The EVM Recipient
     */
    function evmRecipient(bytes29 _depositAction)
        internal
        pure
        returns (address)
    {
        // before = 1 byte identifier + 12 bytes empty to trim for address
        return _depositAction.indexAddress(13);
    }

    /**
     * @notice Retrieves the amount from a Deposit
     * @param _depositAction The message
     * @return The amount
     */
    function amnt(bytes29 _depositAction) internal pure returns (uint256) {
        // before = 1 byte identifier + 32 bytes ID
        return _depositAction.indexUint(33, 32);
    }

    /**
     * @notice Retrieves the token ID from a Message
     * @param _message The message
     * @return The ID
     */
    function tokenId(bytes29 _message)
        internal
        pure
        typeAssert(_message, Types.Message)
        returns (bytes29)
    {
        return _message.slice(0, TOKEN_ID_LEN, uint40(Types.TokenId));
    }

    /**
     * @notice Retrieves the action data from a Message
     * @param _message The message
     * @return The action
     */
    function action(bytes29 _message)
        internal
        pure
        typeAssert(_message, Types.Message)
        returns (bytes29)
    {
        uint256 _actionLen = _message.len() - TOKEN_ID_LEN;
        uint40 _type = uint40(msgType(_message));
        return _message.slice(TOKEN_ID_LEN, _actionLen, _type);
    }

    /**
     * @notice Converts to a Transfer
     * @param _action The message
     * @return The newly typed message
     */
    function tryAsTransfer(bytes29 _action) internal pure returns (bytes29) {
        if (_action.len() == TRANSFER_LEN) {
            return _action.castTo(uint40(Types.Transfer));
        }
        return TypedMemView.nullView();
    }

    /**
     * @notice Converts to a Deposit
     * @param _action The message
     * @return The newly typed message
     */
    function tryAsDeposit(bytes29 _action) internal pure returns (bytes29) {
        if (_action.len() == DEPOSIT_LEN) {
            return _action.castTo(uint40(Types.Deposit));
        }
        return TypedMemView.nullView();
    }

    /**
     * @notice Converts to a TokenID
     * @param _tokenId The message
     * @return The newly typed message
     */
    function tryAsTokenId(bytes29 _tokenId) internal pure returns (bytes29) {
        if (_tokenId.len() == TOKEN_ID_LEN) {
            return _tokenId.castTo(uint40(Types.TokenId));
        }
        return TypedMemView.nullView();
    }

    /**
     * @notice Converts to a Message
     * @param _message The message
     * @return The newly typed message
     */
    function tryAsMessage(bytes29 _message) internal pure returns (bytes29) {
        if (isValidMessageLength(_message)) {
            return _message.castTo(uint40(Types.Message));
        }
        return TypedMemView.nullView();
    }

    /**
     * @notice Asserts that the message is of type Transfer
     * @param _view The message
     * @return The message
     */
    function mustBeTransfer(bytes29 _view) internal pure returns (bytes29) {
        return tryAsTransfer(_view).assertValid();
    }

    /**
     * @notice Asserts that the message is of type Deposit
     * @param _view The message
     * @return The message
     */
    function mustBeDeposit(bytes29 _view) internal pure returns (bytes29) {
        return tryAsDeposit(_view).assertValid();
    }

    /**
     * @notice Asserts that the message is of type TokenID
     * @param _view The message
     * @return The message
     */
    function mustBeTokenId(bytes29 _view) internal pure returns (bytes29) {
        return tryAsTokenId(_view).assertValid();
    }

    /**
     * @notice Asserts that the message is of type Message
     * @param _view The message
     * @return The message
     */
    function mustBeMessage(bytes29 _view) internal pure returns (bytes29) {
        return tryAsMessage(_view).assertValid();
    }
}
