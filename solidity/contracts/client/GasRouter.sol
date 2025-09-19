// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

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
import {Router} from "./Router.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

abstract contract GasRouter is Router {
    event GasSet(uint32 domain, uint256 gas);

    // ============ Mutable Storage ============
    mapping(uint32 destinationDomain => uint256 gasLimit) public destinationGas;

    struct GasRouterConfig {
        uint32 domain;
        uint256 gas;
    }

    constructor(address _mailbox) Router(_mailbox) {}

    /**
     * @notice Sets the gas amount dispatched for each configured domain.
     * @param gasConfigs The array of GasRouterConfig structs
     */
    function setDestinationGas(
        GasRouterConfig[] calldata gasConfigs
    ) external onlyOwner {
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

    function _GasRouter_hookMetadata(
        uint32 _destination
    ) internal view returns (bytes memory) {
        return
            StandardHookMetadata.overrideGasLimit(destinationGas[_destination]);
    }

    function _setDestinationGas(uint32 domain, uint256 gas) internal {
        destinationGas[domain] = gas;
        emit GasSet(domain, gas);
    }
}
