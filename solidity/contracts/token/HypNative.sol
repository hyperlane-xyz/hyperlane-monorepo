// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {LpCollateralRouter} from "./libs/LpCollateralRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {NativeCollateral} from "./libs/TokenCollateral.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is LpCollateralRouter {
    using NativeCollateral for address;

    constructor(
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {}

    /**
     * @notice Initializes the Hyperlane router
     * @param _hook The post-dispatch hook contract.
     * @param _interchainSecurityModule The interchain security module contract.
     * @param _owner The this contract.
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _LpCollateralRouter_initialize();
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public pure override returns (address) {
        return address(0);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        NativeCollateral._transferFromSender(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        NativeCollateral._transferTo(_recipient, _amount);
    }

    receive() external payable {
        donate(msg.value);
    }
}
