// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {SimpleOptimisticIsm} from "./SimpleOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";

/**
 * @title SimpleOptimisticIsmFactory
 */
contract SimpleOptimisticIsmFactory {
    // ============ Immutables ============
    address private immutable _implementation;

    /**
     * @notice Emitted when a routing module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(SimpleOptimisticIsm module);

    // ============ Constructor ============

    constructor() {
        _implementation = address(new SimpleOptimisticIsm());
    }

    // ============ External Functions ============

    /**
     * @notice Deploys and initializes a SimpleOptimisticIsm using a minimal proxy
     * @param _module The ISM to use to verify messages
     * @param _fraudWindow The amount of blcks in the fraud window
     * @param _fraudCountTreshold The count of marks fr fraud for the _module
     */
    function deploy(
        IInterchainSecurityModule _module,
        uint _fraudWindow,
        uint8 _fraudCountTreshold,
        address[] calldata _watchers
    ) external returns (SimpleOptimisticIsm) {
        SimpleOptimisticIsm _ism = SimpleOptimisticIsm(
            MinimalProxy.create(_implementation)
        );
        emit ModuleDeployed(_ism);
        _ism.initialize(
            msg.sender,
            _module,
            _fraudWindow,
            _fraudCountTreshold,
            _watchers
        );
        return _ism;
    }
}
