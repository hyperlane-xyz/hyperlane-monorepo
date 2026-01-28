// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title ITIP403Registry
 * @notice Interface for TIP-403 policy registry for compliance controls.
 * @dev Provides pre-flight checks for transfer authorization via policy IDs.
 */
interface ITIP403Registry {
    /**
     * @notice Check if an account is authorized under a specific policy.
     * @param policyId The policy ID to check (0=reject all, 1=allow all, 2+=custom)
     * @param account The account to check authorization for
     * @return True if the account is authorized under the policy, false otherwise
     */
    function isAuthorized(
        uint64 policyId,
        address account
    ) external view returns (bool);

    /**
     * @notice Check if a policy exists.
     * @param policyId The policy ID to check
     * @return True if the policy exists, false otherwise
     */
    function policyExists(uint64 policyId) external view returns (bool);
}
