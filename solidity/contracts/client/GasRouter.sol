// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "./Router.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

abstract contract GasRouter is Router {
    // ============ Mutable Storage ============
    mapping(uint32 => uint256) public destinationGas;

    struct GasRouterConfig {
        uint32 domain;
        uint256 gas;
    }

    constructor(address _mailbox) Router(_mailbox) {}

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
     * @notice Sets the gas amount dispatched for each configured domain.
     * @param domain The destination domain ID
     * @param gas The gas limit
     */
    function setDestinationGas(uint32 domain, uint256 gas) external onlyOwner {
        _setDestinationGas(domain, gas);
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
        return _quoteDispatch(_destinationDomain, "");
    }

    function _refundAddress(uint32) internal view virtual returns (address) {
        return msg.sender;
    }

    function _metadata(uint32 _destination)
        internal
        view
        virtual
        override
        returns (bytes memory)
    {
        return
            StandardHookMetadata.formatMetadata(
                destinationGas[_destination],
                _refundAddress(_destination)
            );
    }

    function _setDestinationGas(uint32 domain, uint256 gas) internal {
        destinationGas[domain] = gas;
    }
}
