// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {Message} from "./libs/Message.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC20CollateralSaving is TokenRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable wrappedToken;
    ERC4626 public immutable savingToken;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(address erc20, address erc4626) {
        uint256 amount = type(uint256).max; // Maximum value of uint256
        wrappedToken = IERC20(erc20);
        savingToken = ERC4626(erc4626);
        savingToken.approve(erc4626, amount);
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
        // deposit to vault contract
        savingToken.deposit(_amount, address(this));
        return bytes(""); // no metadata
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal override {
        // redeem token from vault
        uint256 amount = savingToken.redeem(_amount, address(this));
        // send it back to user
        wrappedToken.safeTransfer(_recipient, _amount);
    }
}
