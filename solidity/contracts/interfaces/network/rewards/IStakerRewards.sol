// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

interface IStakerRewards {
    /**
     * @notice Emitted when a reward is distributed.
     * @param network network on behalf of which the reward is distributed
     * @param token address of the token
     * @param amount amount of tokens
     * @param data some used data
     */
    event DistributeRewards(
        address indexed network,
        address indexed token,
        uint256 amount,
        bytes data
    );

    /**
     * @notice Get a version of the staker rewards contract (different versions mean different interfaces).
     * @return version of the staker rewards contract
     * @dev Must return 1 for this one.
     */
    function version() external view returns (uint64);

    /**
     * @notice Get an amount of rewards claimable by a particular account of a given token.
     * @param token address of the token
     * @param account address of the claimer
     * @param data some data to use
     * @return amount of claimable tokens
     */
    function claimable(
        address token,
        address account,
        bytes calldata data
    ) external view returns (uint256);

    /**
     * @notice Distribute rewards on behalf of a particular network using a given token.
     * @param network network on behalf of which the reward to distribute
     * @param token address of the token
     * @param amount amount of tokens
     * @param data some data to use
     */
    function distributeRewards(
        address network,
        address token,
        uint256 amount,
        bytes calldata data
    ) external;

    /**
     * @notice Claim rewards using a given token.
     * @param recipient address of the tokens' recipient
     * @param token address of the token
     * @param data some data to use
     */
    function claimRewards(
        address recipient,
        address token,
        bytes calldata data
    ) external;
}
