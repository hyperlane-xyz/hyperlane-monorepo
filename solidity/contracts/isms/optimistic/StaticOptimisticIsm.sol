// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {AbstractOptimisticIsm} from "./AbstractOptimisticIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

abstract contract AbstractMetaProxyOptimisticIsm is AbstractOptimisticIsm {
    /**
     * @inheritdoc AbstractOptimisticIsm
     */
    function watchersAndThreshold()
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}

contract StaticOptimisticIsm is
    AbstractMetaProxyOptimisticIsm,
    OwnableUpgradeable
{
    using Message for bytes;

    address internal module;
    mapping(address => bool) internal watchers;
    uint24 internal fraudWindow;

    // ============ Initializer ============

    function initialize(
        address _owner,
        address _module,
        uint24 _fraudWindow
    ) public initializer {
        __Ownable_init();
        transferOwnership(_owner);
        module = _module;
        fraudWindow = _fraudWindow;

        (address[] memory _watchers, ) = this.watchersAndThreshold();
        for (uint256 i = 0; i < _watchers.length; i++) {
            watchers[_watchers[i]] = true;
        }
    }

    // ============ Modifiers ============

    modifier onlyWatcher() {
        require(_isWatcher(msg.sender), "!watcher");
        _;
    }

    // ============ Internal Functions ============

    function _isWatcher(address _watcher) internal view returns (bool) {
        return watchers[_watcher];
    }

    function _fraudWindowCheck(bytes calldata _message) internal view override {
        bytes32 id = _message.id();

        require(preVerifiedTimestamps[id] != 0, "!pre-verified");

        uint256 preVerifiedTimestamp = preVerifiedTimestamps[id];

        require(
            block.timestamp > preVerifiedTimestamp + fraudWindow,
            "fraud window not elapsed"
        );
    }

    // ============ External Functions ============

    function markFraudulent(address _submodule) external override onlyWatcher {
        require(!fraudulentReport[_submodule][msg.sender], "already marked");
        fraudulentReport[_submodule][msg.sender] = true;
        fraudulentCount[_submodule]++;
    }

    function setSubmodule(address _module) external onlyOwner {
        module = _module;
    }

    // ============ Public Functions ============

    function submodule(
        bytes calldata
    ) public view override returns (IInterchainSecurityModule) {
        return IInterchainSecurityModule(module);
    }
}
