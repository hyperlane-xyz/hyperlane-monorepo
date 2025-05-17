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

// ============ Internal Imports ============
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {FungibleTokenRouter} from "./libs/FungibleTokenRouter.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {ValueTransferBridge} from "./libs/ValueTransferBridge.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {Quote} from "../interfaces/ITokenBridge.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC20Collateral is FungibleTokenRouter, MovableCollateralRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable wrappedToken;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {
        require(Address.isContract(erc20), "HypERC20Collateral: invalid token");
        wrappedToken = IERC20(erc20);
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public virtual reinitializer(2) {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _MovableCollateralRouter_initialize(_owner);
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return wrappedToken.balanceOf(_account);
    }

    function quoteTransferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        quotes = new Quote[](2);
        quotes[0] = _quoteTransferRemote(
            _destinationDomain,
            _recipient,
            _amount
        )[0];
        quotes[1] = Quote({token: address(wrappedToken), amount: _amount});
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
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
        bytes calldata // no metadata
    ) internal virtual override {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    function _rebalance(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) internal override {
        wrappedToken.safeApprove({spender: address(bridge), value: amount});
        MovableCollateralRouter._rebalance({
            domain: domain,
            recipient: recipient,
            amount: amount,
            bridge: bridge
        });
    }
}
