// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20} from "./HypERC20.sol";
import {Message} from "./libs//Message.sol";

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract FastHypERC20 is HypERC20 {
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
    // maps `fastTransferId` to metadata about the user who made the transfer.
    mapping(uint256 => FastTranferMetadata) fastTransfers;

    constructor(uint8 __decimals) HypERC20(__decimals) {}

    /**
     * @dev Mints `_amount` of token to `_recipient`/`fastFiller` who provided LP.
     * @inheritdoc HypERC20
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal override {
        if (
            _metadata.length > 0 &&
            _fastTransferTo(_recipient, _amount, _metadata)
        ) {
            return; // Fast transfer succeeded, exit early
        }

        _mint(_recipient, _amount);
    }

    /**
     * @dev `_fastTransferTo` allows the `_transferTo` function to send the token to the LP.
     * @param _recipient The ricipiant of the token.
     * @param _amount The amount of tokens that is bridged.
     * @param _metadata Metadata is a byte array ofg (uint256, uint256).
     */
    function _fastTransferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal returns (bool) {
        (uint256 _fastFee, uint256 _fastTransferId) = abi.decode(
            _metadata,
            (uint256, uint256)
        );

        FastTranferMetadata memory m_filledMetadata = fastTransfers[
            _fastTransferId
        ];

        if (
            m_filledMetadata.fastFee <= _fastFee &&
            _recipient == m_filledMetadata.recipient
        ) {
            _mint(m_filledMetadata.filler, _amount);

            return true;
        }

        return false;
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
    ) external {
        require(
            fastTransfers[_fastTransferId].filler == address(0),
            "request already filled"
        );

        _burn(msg.sender, _amount - _fastFee);
        _mint(_recipient, _amount - _fastFee);

        fastTransfers[_fastTransferId] = FastTranferMetadata(
            msg.sender,
            _recipient,
            _amount,
            _fastFee
        );
    }

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
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
    ) public payable returns (bytes32 messageId) {
        bytes memory metadata;
        if (_fastFee > 0) {
            uint256 _fastTransferId = fastTransferId;
            fastTransferId = _fastTransferId + 1;
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
    ) internal returns (bytes memory) {
        _burn(msg.sender, _amount);
        return abi.encode(_fastFee, _fastTransferId);
    }
}
