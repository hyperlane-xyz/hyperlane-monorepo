// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "./Message.sol";
import {TokenRouter} from "./TokenRouter.sol";

/**
 * @title Common FastTransfer functionality for ERC20 Tokens with remote transfer support.
 * @author Abacus Works
 */
abstract contract FastTransfer is TokenRouter {
    /**
     * @notice `FastTransferMetadata` is the LP data stored against `fastTransferIdMap`.
     */
    struct FastTranferMetadata {
        address filler;
        address recipient;
        uint256 amount;
        uint256 fastFee;
    }

    mapping(uint32 => uint256) public fastTransferIdMap;
    // maps `fastTransferIdMap` to `FastTranferMetadata`.
    mapping(uint256 => FastTranferMetadata) filledFastTransfers;

    /**
     * @dev Transfers `_amount` of token to `_recipient`/`fastFiller` who provided LP.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal virtual override {
        if (_metadata.length > 0) {
            (uint256 _fastFee, uint256 _fastTransferId) = abi.decode(
                _metadata,
                (uint256, uint256)
            );

            FastTranferMetadata memory m_filledMetadata = filledFastTransfers[
                _fastTransferId
            ];

            m_filledMetadata.fastFee <= _fastFee &&
                _recipient == m_filledMetadata.recipient &&
                _amount == m_filledMetadata.amount
                ? _fastTransferTo(m_filledMetadata.filler, _amount)
                : _fastTransferTo(_recipient, _amount);
        } else {
            _fastTransferTo(_recipient, _amount);
        }
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
        uint256 _fastTransferId
    ) external virtual {
        require(
            filledFastTransfers[_fastTransferId].filler == address(0),
            "request already filled"
        );

        _fastRecieveFrom(msg.sender, _amount - _fastFee);
        _fastTransferTo(_recipient, _amount - _fastFee);

        filledFastTransfers[_fastTransferId] = FastTranferMetadata(
            msg.sender,
            _recipient,
            _amount,
            _fastFee
        );
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
        bytes memory metadata;
        if (_fastFee > 0) {
            uint256 _fastTransferId = fastTransferIdMap[_destination];
            fastTransferIdMap[_destination] = _fastTransferId + 1;
            metadata = _fastTransferFromSender(
                _amountOrId,
                _fastFee,
                _fastTransferId + 1
            );
        } else {
            metadata = _fastTransferFromSender(_amountOrId, 0, 0);
        }

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
