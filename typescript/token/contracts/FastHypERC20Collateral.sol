// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {Message} from "./libs//Message.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract FastHypERC20Collateral is HypERC20Collateral {
    using SafeERC20 for IERC20;

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

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(address erc20) HypERC20Collateral(erc20) {}

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`/`fastFiller` who provided liquidity.
     * @inheritdoc HypERC20Collateral
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

        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev `_fastTransferTo` allows the `_transferTo` function to send the token to the LP.
     * @param _recipient The ricipiant of the `wrappedToken`.
     * @param _amount The amount of `wrappedToken` tokens that is bridged.
     * @param _metadata Metadata is `wrappedToken` a byte array ofg (uint256, uint256).
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
            wrappedToken.safeTransfer(m_filledMetadata.filler, _amount);

            return true;
        }

        return false;
    }

    /**
     * @dev `fillFastTransfer` allows an external user to provide liquidity to a warp route transfer.
     * @param _recipient The recepient of the hyp token on secondary chain.
     * @param _amount The amount of tokens that is being bridged.
     * @param _fastFee The fee the bridging entity will pay.
     * @param _fastTransferId Id assigned on the base chain to uniquely identify the transfer.
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

        wrappedToken.safeTransferFrom(
            msg.sender,
            address(this),
            _amount - _fastFee
        );
        wrappedToken.safeTransfer(_recipient, _amount - _fastFee);

        fastTransfers[_fastTransferId] = FastTranferMetadata(
            msg.sender,
            _recipient,
            _amount,
            _fastFee
        );
    }

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_fastTransferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @param _fastFee The amount of tokens the sender is ready to pay as fees.
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
     * @dev Locks `_amount` of token from `msg.sender` into this contract.
     * @dev Pays `_fastFee` of tokens to LP on source chain.
     * @dev Returns abi.encode(`fastFee`, `_fastTransferId`) as bytes in the form of metadata.
     */
    function _fastTransferFromSender(
        uint256 _amount,
        uint256 _fastFee,
        uint256 _fastTransferId
    ) internal returns (bytes memory) {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
        return abi.encode(_fastFee, _fastTransferId);
    }
}
