// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "./Router.sol";

abstract contract GasRouter is Router {
    // ============ Mutable Storage ============
    mapping(uint32 => uint256) public handleGasOverhead;

    // ============ Events ============

    /**
     * @notice Emitted when a remote router's handle gas overhead is set.
     * @param domain The domain of the new router
     * @param gas The gas amount used by the  of the new router
     */
    event HandleGasOverheadSet(uint32 indexed domain, uint256 gas);

    struct GasRouterConfig {
        uint32 domain;
        uint256 handleGasOverhead;
    }

    /**
     * @notice Batch version of `enrollRemoteRouterWithGas`
     * @param gasConfigs The array of GasRouterConfig structs
     */
    function setGasOverheadConfigs(GasRouterConfig[] calldata gasConfigs)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < gasConfigs.length; i += 1) {
            setGasOverheadConfig(gasConfigs[i]);
        }
    }

    /**
     * @notice Enroll a remote router with a handle gas overhead
     * @param gasConfig The GasRouterConfig struct
     */
    function setGasOverheadConfig(GasRouterConfig calldata gasConfig)
        public
        onlyOwner
    {
        _setGasOverhead(gasConfig.domain, gasConfig.handleGasOverhead);
    }

    function setGasOverhead(uint32 domain, uint256 gas) external onlyOwner {
        _setGasOverhead(domain, gas);
    }

    function quoteGasPayment(uint32 _destinationDomain)
        external
        view
        returns (uint256 _gasPayment)
    {
        return
            interchainGasPaymaster.quoteGasPayment(
                _destinationDomain,
                handleGasOverhead[_destinationDomain]
            );
    }

    function _setGasOverhead(uint32 domain, uint256 gas) internal {
        handleGasOverhead[domain] = gas;
        emit HandleGasOverheadSet(domain, gas);
    }

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
                handleGasOverhead[_destinationDomain],
                _gasPayment,
                _gasPaymentRefundAddress
            );
    }

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
