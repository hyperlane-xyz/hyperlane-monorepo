// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "./Message.sol";
import {TokenRouter} from "./TokenRouter.sol";

import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";

/**
 * @title Common FastTokenRouter functionality for ERC20 Tokens with remote transfer support.
 * @author Abacus Works
 */
abstract contract FastTokenRouter is TokenRouter {
    using TypeCasts for bytes32;
    using Message for bytes;
    /**
     * @notice `FastTransferMetadata` is the LP data stored against `fastTransferId`.
     */
    struct FastTranferMetadata {
        address filler;
        address recipient;
        uint256 amount;
        uint256 fastFee;
    }

    uint256 public fastTransferId;
    // maps `fastTransferId` to `FastTranferMetadata`.
    mapping(bytes32 => FastTranferMetadata) filledFastTransfers;

    /**
     * @dev delegates transfer logic to `_transferTo`.
     * @inheritdoc TokenRouter
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();
        bytes calldata metadata = _message.metadata();
        _transferTo(recipient.bytes32ToAddress(), amount, _origin, metadata);
        emit ReceivedTransferRemote(_origin, recipient, amount);
    }

    /**
     * @dev Transfers `_amount` of token to `_recipient`/`fastFiller` who provided LP.
     * @dev Called by `handle` after message decoding.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        uint32 _origin,
        bytes calldata _metadata
    ) internal virtual {
        address _tokenRecipient = _getTokenRecipient(
            _recipient,
            _amount,
            _origin,
            _metadata
        );

        _fastTransferTo(_tokenRecipient, _amount);
    }

    /**
     * @dev allows an external user to full an unfilled fast transfer order.
     * @param _recipient The recepient of the wrapped token on base chain.
     * @param _amount The amount of wrapped tokens that is being bridged.
     * @param _fastFee The fee the bridging entity will pay.
     * @param _fastTransferId Id assigned on the remote chain to uniquely identify the transfer.
     */
    function fillFastTransfer(
        address _recipient,
        uint256 _amount,
        uint256 _fastFee,
        uint32 _origin,
        uint256 _fastTransferId
    ) external virtual {
        bytes32 filledFastTransfersKey = keccak256(
            abi.encodePacked(_origin, _fastTransferId)
        );
        require(
            filledFastTransfers[filledFastTransfersKey].filler == address(0),
            "request already filled"
        );

        filledFastTransfers[filledFastTransfersKey] = FastTranferMetadata(
            msg.sender,
            _recipient,
            _amount,
            _fastFee
        );

        _fastRecieveFrom(msg.sender, _amount - _fastFee);
        _fastTransferTo(_recipient, _amount - _fastFee);
    }

    /**
     * @dev Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_fastTransferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @return messageId The identifier of the dispatched message.
     */
    function fastTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _fastFee
    ) public payable virtual returns (bytes32 messageId) {
        uint256 _fastTransferId = fastTransferId;
        fastTransferId = _fastTransferId + 1;
        bytes memory metadata = _fastTransferFromSender(
            _amountOrId,
            _fastFee,
            _fastTransferId + 1
        );

        messageId = _dispatchWithGas(
            _destination,
            Message.format(_recipient, _amountOrId, metadata),
            msg.value, // interchain gas payment
            msg.sender // refund address
        );
        emit SentTransferRemote(_destination, _recipient, _amountOrId);
    }

    /**
     * @dev Burns `_amount` of token from `msg.sender` balance.
     * @dev Pays `_fastFee` of tokens to LP on source chain.
     * @dev Returns `fastFee` as bytes in the form of metadata.
     */
    function _fastTransferFromSender(
        uint256 _amount,
        uint256 _fastFee,
        uint256 _fastTransferId
    ) internal virtual returns (bytes memory) {
        _fastRecieveFrom(msg.sender, _amount);
        return abi.encode(_fastFee, _fastTransferId);
    }

    /**
     * @dev returns an address that indicates who should recieve the bridged tokens.
     * @dev if _fastFees was inlcuded and someone filled the order before the mailbox made the contract call, the filler gets the funds.
     */
    function _getTokenRecipient(
        address _recipient,
        uint256 _amount,
        uint32 _origin,
        bytes calldata _metadata
    ) internal view returns (address) {
        if (_metadata.length == 0) {
            return _recipient;
        }

        // decode metadata to extract `_fastFee` and `_fastTransferId`.
        (uint256 _fastFee, uint256 _fastTransferId) = abi.decode(
            _metadata,
            (uint256, uint256)
        );

        FastTranferMetadata memory m_filledMetadata = filledFastTransfers[
            keccak256(abi.encodePacked(_origin, _fastTransferId))
        ];

        if (
            m_filledMetadata.fastFee <= _fastFee &&
            _recipient == m_filledMetadata.recipient &&
            _amount == m_filledMetadata.amount
        ) {
            return m_filledMetadata.filler;
        }

        return _recipient;
    }

    /**
     * @dev Should transfer `_amount` of tokens to `_recipient`.
     * @dev The implementation is delegated.
     */
    function _fastTransferTo(address _recipient, uint256 _amount)
        internal
        virtual;

    /**
     * @dev Should collect `amount` of tokens from `_sender`.
     * @dev The implementation is delegated.
     */
    function _fastRecieveFrom(address _sender, uint256 _amount)
        internal
        virtual;
}
