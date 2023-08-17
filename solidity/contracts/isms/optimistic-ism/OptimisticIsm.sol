// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

// ============ CONTRACT ============
abstract contract OptimisticIsm is IOptimisticIsm, OwnableUpgradeable {
    // ============ Events ============
    event RelayerCalledMessagePreVerify(address indexed _relayer);
    event MessageDelivered(bytes indexed _message);
    event SubmoduleChanged(IInterchainSecurityModule _module);
    event FraudWindowOpened(IInterchainSecurityModule _module);
    event SubmoduleMarkedFraudulent(IInterchainSecurityModule _module);
