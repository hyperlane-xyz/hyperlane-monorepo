// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.0;

/* this is bullish /ˈbʊlɪʃ/ : `optimism` toward the future */

import {IInterchainSecurityModule} from "./interfaces/IInterchainSecurityModule.sol";
import {StaticMOfNAddressSetFactory} from "./libs/StaticMOfNAddressSetFactory.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool);

    function markFraudulent(address _submodule) external;

    function getSubmodule(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule);

    function modulesAndThreshold(bytes calldata _message)
        external
        view
        returns (address[] memory, uint8);
}

abstract contract BullishISM is IOptimisticIsm, StaticMOfNAddressSetFactory {
    IInterchainSecurityModule private submodule;
    address private owner;
    uint256 private fraudWindowEnd;
    mapping(address => bool) private compromisedSubmodules;
    address[] private flaggedSubmodules;
    uint8 private m;
    uint8 private n;
    StaticMOfNAddressSetFactory private factory;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function");
        _;
    }

    constructor(
        address _submodule,
        uint256 _fraudWindowDuration,
        uint8 _m,
        uint8 _n
    ) {
        submodule = IInterchainSecurityModule(_submodule);
        owner = msg.sender;
        fraudWindowEnd = block.timestamp + _fraudWindowDuration;
        m = _m;
        n = _n;
    }

    /**
     * @notice Perform pre-verification of a message
     * @param _metadata Metadata related to the message
     * @param _message The message to verify
     * @return True if the pre-verification is successful, false otherwise
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        override
        returns (bool)
    {
        require(block.timestamp < fraudWindowEnd, "Fraud window has elapsed");
        return submodule.verify(_metadata, _message);
    }

    /**
     * @notice Mark a submodule as fraudulent
     * @param _submodule The address of the submodule to mark as fraudulent
     * @dev This function allows the contract owner to flag a submodule as fraudulent by deploying a StaticMOfNAddressSetFactory, which generates a static address set. The submodule's address is added to the set of compromised submodules and stored for future reference. This ensures that the submodule is recognized as fraudulent and its messages are rejected during the message delivery verification process.
     */
    function markFraudulent(address _submodule) external override onlyOwner {
        address[] memory addresses = new address[](1);
        addresses[0] = _submodule;
        address set = factory.deploy(addresses, m);
        compromisedSubmodules[set] = true;
        flaggedSubmodules.push(set);
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        override
        returns (bool)
    {
        require(
            block.timestamp >= fraudWindowEnd,
            "Fraud window has not elapsed"
        );

        // Check if submodule is compromised
        if (compromisedSubmodules[address(submodule)]) {
            return false;
        }

        // Check if submodule is compromised by m-of-n watchers
        uint256 flaggedCount = 0;
        for (uint256 i = 0; i < flaggedSubmodules.length; i++) {
            if (compromisedSubmodules[flaggedSubmodules[i]]) {
                flaggedCount++;
                if (flaggedCount >= m) {
                    return false;
                }
            }
        }

        return submodule.verify(_metadata, _message);
    }

    /**
     * @notice Get the submodule associated with a message
     * @return The submodule associated with the message
     */
    function getSubmodule(
        bytes calldata /* _message */
    ) external view override returns (IInterchainSecurityModule) {
        return submodule;
    }

    /**
     * @notice Get the list of modules and the threshold value associated with a message
     * @return The list of modules and the threshold value
     */
    function modulesAndThreshold(
        bytes calldata /* _message */
    ) external view override returns (address[] memory, uint8) {
        address[] memory modules = new address[](1);
        modules[0] = address(submodule);
        return (modules, n);
    }
}
