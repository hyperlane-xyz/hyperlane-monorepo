// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is TokenRouter {
    /**
     * @dev Emitted when native tokens are donated to the contract.
     * @param sender The address of the sender.
     * @param amount The amount of native tokens donated.
     */
    event Donation(address indexed sender, uint256 amount);

    constructor(address _mailbox) TokenRouter(_mailbox) {}

    /**
     * @notice Initializes the Hyperlane router
     * @param _hook The post-dispatch hook contract.
       @param _interchainSecurityModule The interchain security module contract.
       @param _owner The this contract.
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev uses (`msg.value` - `_amount`) as interchain gas payment and `msg.sender` as refund address.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual override returns (bytes32 messageId) {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
        uint256 gasPayment = msg.value - _amount;
        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                gasPayment,
                bytes(""),
                address(0)
            );
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return _account.balance;
    }

    /**
     * @inheritdoc TokenRouter
     * @dev No-op because native amount is transferred in `msg.value`
     * @dev Compiler will not include this in the bytecode.
     */
    function _transferFromSender(
        uint256
    ) internal pure override returns (bytes memory) {
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
        emit Donation(msg.sender, msg.value);
    }
}
