// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {FungibleTokenRouter} from "./libs/FungibleTokenRouter.sol";
import {LpCollateralRouter} from "./libs/LpCollateralRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is LpCollateralRouter {
    string internal constant INSUFFICIENT_NATIVE_AMOUNT =
        "Native: amount exceeds msg.value";

    constructor(
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {}

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
    ) public virtual initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _LpCollateralRouter_initialize();
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        // include for legible error instead of underflow
        _transferFromSender(_amount);

        return
            super._transferRemote(
                _destination,
                _recipient,
                _amount,
                _value - _amount,
                _hookMetadata,
                _hook
            );
    }

    function _token() internal view override returns (address) {
        return address(0);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
        return bytes(""); // no metadata
    }

    /**
     * @dev Sends `_amount` of native token to `_recipient` balance.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    receive() external payable {
        donate(msg.value);
    }
}
