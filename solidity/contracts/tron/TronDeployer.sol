// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TronMailbox} from "./TronMailbox.sol";
import {TronMerkleTreeHook} from "./TronMerkleTreeHook.sol";
import {ProxyAdmin} from "../upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../upgrade/TransparentUpgradeableProxy.sol";

/**
 * @title TronDeployer
 * @notice Helper contract to deploy Tron-specific Hyperlane contracts
 * @dev This contract helps deploy the necessary contracts for Tron integration
 */
contract TronDeployer {
    /**
     * @notice Deploys a TronMailbox contract
     * @param _localDomain The local domain ID
     * @param _owner The owner address
     * @param _defaultIsm The default ISM address
     * @param _defaultHook The default hook address
     * @param _requiredHook The required hook address
     * @return The deployed TronMailbox address
     */
    function deployTronMailbox(
        uint32 _localDomain,
        address _owner,
        address _defaultIsm,
        address _defaultHook,
        address _requiredHook
    ) external returns (address) {
        TronMailbox mailbox = new TronMailbox(_localDomain);
        
        // Create proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(mailbox),
            address(this),
            abi.encodeWithSelector(
                mailbox.initialize.selector,
                _owner,
                _defaultIsm,
                _defaultHook,
                _requiredHook
            )
        );
        
        return address(proxy);
    }

    /**
     * @notice Deploys a TronMerkleTreeHook contract
     * @param _mailbox The mailbox address
     * @param _ism The ISM address
     * @return The deployed TronMerkleTreeHook address
     */
    function deployTronMerkleTreeHook(
        address _mailbox,
        address _ism
    ) external returns (address) {
        TronMerkleTreeHook hook = new TronMerkleTreeHook(_mailbox, _ism);
        return address(hook);
    }
}
