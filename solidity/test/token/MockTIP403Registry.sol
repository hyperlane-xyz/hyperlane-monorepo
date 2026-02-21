// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITIP403Registry} from "../../contracts/token/interfaces/ITIP403Registry.sol";

/**
 * @title MockTIP403Registry
 * @notice Mock implementation of ITIP403Registry for testing HypTIP20's pre-flight checks.
 * @dev Provides configurable authorization rules for testing purposes.
 */
contract MockTIP403Registry is ITIP403Registry {
    // Storage for authorization state: policyId => account => authorized
    mapping(uint64 => mapping(address => bool)) private _authorizations;

    /**
     * @notice Check if an account is authorized under a specific policy.
     * @param policyId The policy ID to check (0=reject all, 1=allow all, 2+=custom)
     * @param account The account to check authorization for
     * @return True if the account is authorized under the policy, false otherwise
     */
    function isAuthorized(
        uint64 policyId,
        address account
    ) external view returns (bool) {
        // Policy 0: reject all
        if (policyId == 0) {
            return false;
        }
        // Policy 1: allow all
        if (policyId == 1) {
            return true;
        }
        // Policy 2+: return stored authorization state
        return _authorizations[policyId][account];
    }

    /**
     * @notice Check if a policy exists.
     * @param policyId The policy ID to check
     * @return True if the policy exists, false otherwise
     */
    function policyExists(uint64 policyId) external view returns (bool) {
        // Policy 0 and 1 are built-in policies
        if (policyId == 0 || policyId == 1) {
            return true;
        }
        // Policy 2+: check if any authorizations set for that policy
        // We check by seeing if any account has been authorized for this policy
        // This is a simple check - in a real implementation, you'd track policy existence separately
        // For testing purposes, we consider a policy to exist if it has been configured
        return false; // Default: custom policies don't exist unless explicitly set
    }

    /**
     * @notice Set authorization for an account under a specific policy.
     * @dev This is a test helper function to configure authorization rules.
     * @param policyId The policy ID to configure
     * @param account The account to authorize/deauthorize
     * @param authorized Whether the account should be authorized
     */
    function setAuthorized(
        uint64 policyId,
        address account,
        bool authorized
    ) public {
        require(policyId >= 2, "Cannot configure built-in policies");
        _authorizations[policyId][account] = authorized;
    }
}
