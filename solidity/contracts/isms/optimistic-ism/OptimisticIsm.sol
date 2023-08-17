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

  // ============ Core Variables ============
    mapping(address => bool) public watchers; //watchers added by owner
    mapping(address => bool) public relayers; //relayers who have sent messages pending between preVerify() and deliver()
    mapping(uint32 => IInterchainSecurityModule) public module; //domain to submodule mapping
    mapping(address => bytes) private _relayerToMessages; //relayer to message mapping

  // ============ Fraud Variables ============
    uint256 public fraudWindow; //fraud window duration as defined by owner in deployment OR after via changeFraudWindow()
    mapping(bytes => uint256) public fraudWindows; //message to uint (time duration) to be initiated by initiateFraudWindow()
    mapping(IInterchainSecurityModule => bool) public subModuleFlags; //markFraudulent() manipulates this
