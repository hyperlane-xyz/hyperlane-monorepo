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
    function watchersAndThreshold(bytes calldata)
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
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    // ============ Public Storage ============
    // Storage for the constant Opt-ISM Watcher role's identifier
    bytes32 public constant OPTIMISTIC_ISM_WATCHER_ROLE =
        keccak256("OPTIMISTIC_ISM_WATCHER_ROLE");

    // The address of the static Interchain Security Module
    address public staticModule;

    // The length of the static fraud window
    uint96 public staticFraudWindow;

    // ============ Events ============
    event SubmoduleSet(address ism);
    event FraudWindowSet(uint256 fraudWindow);

    // ============ Initializer ============

    /**
     * @notice Initializes the contract with a specified owner and ISM module.
     * @param _owner The address of the owner of this contract.
     * @param _module The address of the Interchain Security Module to be used.
     * @param _fraudWindowDuration The length of the fraud window in seconds.
     */
    function initialize(
        address _owner,
        address _module,
        uint256 _fraudWindowDuration
    ) public initializer {
        __Ownable_init();
        transferOwnership(_owner);
        _setSubmodule(_module);
        _setFraudWindowDuration(_fraudWindowDuration);

        // Set up access control
        (address[] memory watchers, ) = this.watchersAndThreshold("");
        for (uint256 i = 0; i < watchers.length; i++) {
            _setupRole(OPTIMISTIC_ISM_WATCHER_ROLE, watchers[i]);
        }
    }

    // ============= Modifiers =============
    modifier onlyWatcher() {
        require(hasRole(OPTIMISTIC_ISM_WATCHER_ROLE, msg.sender), "!watcher");
        _;
    }

    // ============ External Functions ============

    /**
     * @notice Sets a new static Interchain Security Module
     * @param _ism The address of the new Interchain Security Module
     */
    function setSubmodule(address _ism) external onlyOwner {
        _setSubmodule(_ism);
    }

    /**
     * @notice Marks an ISM as fraudulent
     * @dev This function can only be called by a watcher
     * @param ism The address of ISM to mark as fraudulent
     */
    function markFraudulent(address ism) external override onlyWatcher {
        require(ism != address(0), "address(0)");
        require(!fraudulent[ism][msg.sender], "already fraudulent");
        fraudulent[ism][msg.sender] = true;
        fraudulentCounter[ism]++;
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the currently active ISM
     * @return module The ISM to use to verify _message
     */
    function submodule(bytes calldata)
        public
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(staticModule);
    }

    /**
     * @notice Returns the length of the fraud window
     * @return The length of the fraud window
     */
    function fraudWindow(bytes calldata)
        public
        view
        override
        returns (uint256)
    {
        return staticFraudWindow;
    }

    // ============ Internal Functions ============
    function _setSubmodule(address ism) internal {
        require(ism != address(0), "address(0)");
        staticModule = ism;
        emit SubmoduleSet(ism);
    }

    function _setFraudWindowDuration(uint256 _fraudWindowDuration) internal {
        require(_fraudWindowDuration > 0, "window==0");
        staticFraudWindow = uint96(_fraudWindowDuration);
        emit FraudWindowSet(_fraudWindowDuration);
    }
}
