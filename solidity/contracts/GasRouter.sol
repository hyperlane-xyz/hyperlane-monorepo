// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "./Router.sol";

abstract contract GasRouter is Router {
    // ============ Mutable Storage ============
    mapping(uint32 => uint256) handleGasOverhead;

    // ============ Events ============

    /**
     * @notice Emitted when a remote router's handle gas overhead is set.
     * @param domain The domain of the new router
     * @param gas The gas amount used by the  of the new router
     */
    event HandleGasOverheadSet(uint32 indexed domain, uint256 gas);

    struct GasRouterConfig {
        uint32 domain;
        bytes32 router;
        uint256 handleGasOverhead;
    }

    /**
     * @notice Batch version of `enrollRemoteRouter`
     * @param gasConfigs The array of GasRouterConfig structs
     */
    function enrollRemoteRoutersWithGas(GasRouterConfig[] calldata gasConfigs)
        external
        virtual
        onlyOwner
    {
        for (uint256 i = 0; i < gasConfigs.length; i += 1) {
            enrollRemoteRouterWithGas(gasConfigs[i]);
        }
    }

    function enrollRemoteRouterWithGas(GasRouterConfig calldata gasConfig)
        public
        onlyOwner
    {
        _enrollRemoteRouter(gasConfig.domain, gasConfig.router);
        _setGasOverhead(gasConfig.domain, gasConfig.handleGasOverhead);
    }

    function setGasOverhead(uint32 domain, uint256 gas) external onlyOwner {
        _setGasOverhead(domain, gas);
    }

    function _setGasOverhead(uint32 domain, uint256 gas) internal {
        handleGasOverhead[domain] = gas;
        emit HandleGasOverheadSet(domain, gas);
    }
}
