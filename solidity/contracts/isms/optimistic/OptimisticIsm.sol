// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";
import {AbstractOptimisticIsm} from "./AbtractOptimisticIsm.sol";
import {Message} from "../../libs/Message.sol";



// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title OptimisticIsm
 */

 contract OptimisticIsm is AbstractOptimisticIsm, OwnableUpgradeable {


    address public submodule;
    uint256 public fraudWindowDuration;

        // ============ Public Storage ============

    mapping(address => bool) public compromisedSubmodules;
    mapping(uint32 => IInterchainSecurityModule) public modules;
    mapping(bytes32 => bool) public messageVerification;

function configureSubmodule(address _submodule, uint256 _fraudWindowDuration) public onlyOwner {
    submodule = _submodule;
    fraudWindowDuration = _fraudWindowDuration;
}

// watchers can call this function to mark a message as fraudulent
function markFraudulent(address ism) external {
    compromisedSubmodules[ism] = true;
}

function preVerify(bytes calldata message, bytes calldata metadata) external returns (bool) {
    // Ensure that submodule is configured
    require(submodule != address(0), "Submodule not configured");

    // Call the preVerify() function of the submodule
    (bool success, bytes memory result) = submodule.delegatecall(
        abi.encodeWithSignature("preVerify(bytes,bytes)", message, metadata)
    );
    require(success, "Submodule pre-verification failed");

    // Parse the result returned by the submodule
    bool preVerified = abi.decode(result, (bool));

    // Store the pre-verified status of the message
    messageVerification[keccak256(abi.encodePacked(message, metadata))] = preVerified;

    return preVerified;
}

function verify(bytes memory message, bytes memory metadata) external returns (bool) {
    // Ensure that the message has been pre-verified
    require(preVerify(message, metadata), "Message not pre-verified");

    // Ensure that the submodule has not been flagged as compromised
    require(!compromisedSubmodules[submodule], "Submodule is compromised");

    // Ensure that the fraud window has elapsed
    require(block.timestamp >= fraudWindowStart(message, metadata) + fraudWindowDuration, "Fraud window not elapsed");

    return true;
}













 }
