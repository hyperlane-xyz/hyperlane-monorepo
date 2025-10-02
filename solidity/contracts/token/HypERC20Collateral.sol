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
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {LpCollateralRouter} from "./libs/LpCollateralRouter.sol";
import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {ERC20Collateral} from "./libs/TokenCollateral.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC20Collateral is LpCollateralRouter {
    using SafeERC20 for IERC20;
    using ERC20Collateral for IERC20;

    IERC20 public immutable wrappedToken;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        require(Address.isContract(erc20), "HypERC20Collateral: invalid token");
        wrappedToken = IERC20(erc20);
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _LpCollateralRouter_initialize();
    }

    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    function _addBridge(uint32 domain, ITokenBridge bridge) internal override {
        MovableCollateralRouter._addBridge(domain, bridge);
        IERC20(wrappedToken).safeApprove(address(bridge), type(uint256).max);
    }

    function _removeBridge(
        uint32 domain,
        ITokenBridge bridge
    ) internal override {
        MovableCollateralRouter._removeBridge(domain, bridge);
        IERC20(wrappedToken).safeApprove(address(bridge), 0);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken._transferFromSender(_amount);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken._transferTo(_recipient, _amount);
    }
}
