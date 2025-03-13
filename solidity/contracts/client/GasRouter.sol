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

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destinationDomain The domain of the router.
     * @return _gasPayment Payment computed by the registered InterchainGasPaymaster.
     */
    function quoteGasPayment(
        uint32 _destinationDomain
    ) external view virtual returns (uint256) {
        return _GasRouter_quoteDispatch(_destinationDomain, "", address(hook));
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

    function _GasRouter_dispatch(
        uint32 _destination,
        uint256 _value,
        bytes memory _messageBody,
        address _hook
    ) internal returns (bytes32) {
        return
            _Router_dispatch(
                _destination,
                _value,
                _messageBody,
                _GasRouter_hookMetadata(_destination),
                _hook
            );
    }

    function _GasRouter_quoteDispatch(
        uint32 _destination,
        bytes memory _messageBody,
        address _hook
    ) internal view returns (uint256) {
        return
            _Router_quoteDispatch(
                _destination,
                _messageBody,
                _GasRouter_hookMetadata(_destination),
                _hook
            );
    }
}
