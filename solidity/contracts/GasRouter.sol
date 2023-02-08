// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "./Router.sol";

abstract contract GasRouter is Router {
    // ============ Mutable Storage ============
    mapping(uint32 => uint256) public destinationGas;

    // ============ Events ============

    /**
     * @notice Emitted when a domain's destination gas is set.
     * @param domain The domain of the router.
     * @param gas The gas amount used by the handle function of the domain's router.
     */
    event DestinationGasSet(uint32 indexed domain, uint256 gas);

    struct GasRouterConfig {
        uint32 domain;
        uint256 gas;
    }

    /**
     * @notice Sets the gas amount dispatched for each configured domain.
     * @param gasConfigs The array of GasRouterConfig structs
     */
    function setDestinationGas(GasRouterConfig[] calldata gasConfigs)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < gasConfigs.length; i += 1) {
            _setDestinationGas(gasConfigs[i].domain, gasConfigs[i].gas);
        }
    }

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destinationDomain The domain of the router.
     * @return _gasPayment Payment computed by the registered InterchainGasPaymaster.
     */
    function quoteGasPayment(uint32 _destinationDomain)
        external
        view
        returns (uint256 _gasPayment)
    {
        return
            interchainGasPaymaster.quoteGasPayment(
                _destinationDomain,
                destinationGas[_destinationDomain]
            );
    }

    function _setDestinationGas(uint32 domain, uint256 gas) internal {
        destinationGas[domain] = gas;
        emit DestinationGasSet(domain, gas);
    }

    /**
     * @dev Uses the destinationGas mapping to populate the gas amount for the message.
     * @notice Dispatches a message to an enrolled router via the local router's Mailbox
     * and pays for it to be relayed to the destination.
     * @dev Reverts if there is no enrolled router for _destinationDomain.
     * @param _destinationDomain The domain of the chain to which to send the message.
     * @param _messageBody Raw bytes content of message.
     * @param _gasPayment The amount of native tokens to pay for the message to be relayed.
     * @param _gasPaymentRefundAddress The address to refund any gas overpayment to.
     */
    function _dispatchWithGas(
        uint32 _destinationDomain,
        bytes memory _messageBody,
        uint256 _gasPayment,
        address _gasPaymentRefundAddress
    ) internal returns (bytes32 _messageId) {
        return
            _dispatchWithGas(
                _destinationDomain,
                _messageBody,
                destinationGas[_destinationDomain],
                _gasPayment,
                _gasPaymentRefundAddress
            );
    }

    /**
     * @dev Passes `msg.value` as gas payment and `msg.sender` as gas payment refund address.
     * @dev Uses the destinationGas mapping to populate the gas amount for the message.
     * @param _destinationDomain The domain of the chain to send the message.
     * @param _messageBody Raw bytes content of message.
     */
    function _dispatchWithGas(
        uint32 _destinationDomain,
        bytes memory _messageBody
    ) internal returns (bytes32 _messageId) {
        return
            _dispatchWithGas(
                _destinationDomain,
                _messageBody,
                msg.value,
                msg.sender
            );
    }
}
