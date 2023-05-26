// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";
import {AbstractOptimisticIsm} from "./AbtractOptimisticIsm.sol";
import {Message} from "../../libs/Message.sol";
import {WatcherConfigFactory} from "../isms/optimistic/WatcherConfigFactory.sol";




// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title OptimisticIsm
 */

 contract OptimisticIsm is AbstractOptimisticIsm, Initializable, WatcherConfigFactory, OwnableUpgradeable {


    address public submodule;
    uint256 public fraudWindowDuration;
    bool public isConfigured;


        // ============ Public Storage ============

    mapping(address => bool) public compromisedSubmodules;
    mapping(uint32 => IInterchainSecurityModule) public modules;
    mapping(bytes32 => bool) public messageVerification;
    mapping(address => bool) public authorizedWatchers;

    modifier onlyAuthorizedWatcher() {
        require(authorizedWatchers[msg.sender], "OptimisticISM: Not authorized watcher");
        _;
    }

    modifier isConfigured() {
        require(submodule != address(0), "Submodule not configured");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner(), "OptimisticISM: Not owner");
        _;
    }

    // Initialization function to add initial authorized watchers
    function initialize(address[] memory initialWatchers) public initializer {
        __Ownable_init();

        // Add the contract owner as an authorized watcher
        authorizedWatchers[msg.sender] = true;

        // Add initial watchers provided in the function argument
        for (uint256 i = 0; i < initialWatchers.length; i++) {
            authorizedWatchers[initialWatchers[i]] = true;
        }
    }

    // Function to add an address to the list of authorized watchers
    function addWatcher(address watcher) external onlyOwner {
        authorizedWatchers[watcher] = true;
    }

    // Function to remove an address from the list of authorized watchers
    function removeWatcher(address watcher) external onlyOwner {
        authorizedWatchers[watcher] = false;
    }

function setFraudWindowDuration(uint256 _duration) external onlyOwner {
    fraudWindowDuration = _duration;
}    

function configureSubmodule(address _submodule, uint256 _fraudWindowDuration) external onlyOwner {
    submodule = _submodule;
    fraudWindowDuration = _fraudWindowDuration;
    isConfigured = true;

}

// watchers can call this function to mark a message as fraudulent
function markFraudulent(address ism) external returns isConfigured (bool) {
    require(ism != address(0), "OptimisticISM: Invalid ISM address");
    compromisedSubmodules[ism] = true;
    return true;
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
    require(block.timestamp >= block.timestamp + fraudWindowDuration, "Fraud window not elapsed");

    return true;
}
 }
