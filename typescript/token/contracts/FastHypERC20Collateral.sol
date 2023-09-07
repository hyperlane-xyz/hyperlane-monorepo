// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {Message} from "./libs/Message.sol";

import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract FastHypERC20Collateral is TokenRouter {
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;
    using Message for bytes;

    /**
     * @notice `FastTransferMetadata` is the LP data stored against `fastTransferId`.
     */
    struct FastTranferMetadata {
        address filler;
        address recipient;
        uint256 amount;
        uint256 fastFee;
        bool reimbursed;
    }

    IERC20 public immutable wrappedToken;

    // maps `fastTransferId` to metadata about the user who made the transfer.
    mapping(uint256 => FastTranferMetadata) fastTransfers;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(address erc20) {
        wrappedToken = IERC20(erc20);
    }

    /**
     * @notice Initializes the Hyperlane router.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     */
    function initialize(address _mailbox, address _interchainGasPaymaster)
        external
        initializer
    {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster
        );
    }

    function balanceOf(address _account) external view returns (uint256) {
        return wrappedToken.balanceOf(_account);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount)
        internal
        override
        returns (bytes memory)
    {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
        return bytes(""); // no metadata
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal override {
        (uint256 _fastFee, uint256 _fastTransferId) = abi.decode(
            _metadata,
            (uint256, uint256)
        );
        FastTranferMetadata memory m_filledMetadata = fastTransfers[
            _fastTransferId
        ];
        if (
            m_filledMetadata.filler != address(0) &&
            m_filledMetadata.fastFee <= _fastFee &&
            !m_filledMetadata.reimbursed &&
            _recipient == m_filledMetadata.recipient
        ) {
            // update the metadata and store in storage
            // TODO: come up with a smarter way to split amount between LP and receiver? But gas increases. Eg. The LP Might have paid an amount less than total amount.
            m_filledMetadata.reimbursed = true;
            fastTransfers[_fastTransferId] = m_filledMetadata;

            wrappedToken.safeTransfer(m_filledMetadata.filler, _amount);
        } else {
            wrappedToken.safeTransfer(_recipient, _amount);
        }
    }

    /**
     * @dev allows an external user to full an unfilled fast transfer order.
     * @param _recipient The recepient of the wrapped token on base chain.
     * @param _amount The amount of wrapped tokens that is being bridged.
     * @param _fastFee The fee the bridging entity will pay.
     * @param _fastTransferId Id assigned on the remote chain representing the fast transfer.
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
            _fastFee,
            false
        );
    }
}
