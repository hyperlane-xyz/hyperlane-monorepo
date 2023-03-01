// SPDX-License-Identifier: MIT
// Copied from https://github.com/axelarnetwork/axelar-utils-solidity/commits/main/contracts/ConstAddressDeployer.sol

pragma solidity ^0.8.0;

contract Create2Factory {
    error EmptyBytecode();
    error FailedDeploy();
    error FailedInit();

    event Deployed(
        bytes32 indexed bytecodeHash,
        bytes32 indexed salt,
        address indexed deployedAddress
    );

    /**
     * @dev Deploys a contract using `CREATE2`. The address where the contract
     * will be deployed can be known in advance via {deployedAddress}.
     *
     * The bytecode for a contract can be obtained from Solidity with
     * `type(contractName).creationCode`.
     *
     * Requirements:
     *
     * - `bytecode` must not be empty.
     * - `salt` must have not been used for `bytecode` already by the same `msg.sender`.
     */
    function deploy(
        bytes memory bytecode,
        bytes32 salt
    ) external returns (address deployedAddress_) {
        deployedAddress_ = _deploy(
            bytecode,
            keccak256(abi.encode(msg.sender, salt))
        );
    }

    /**
     * @dev Deploys a contract using `CREATE2` and initialize it. The address where the contract
     * will be deployed can be known in advance via {deployedAddress}.
     *
     * The bytecode for a contract can be obtained from Solidity with
     * `type(contractName).creationCode`.
     *
     * Requirements:
     *
     * - `bytecode` must not be empty.
     * - `salt` must have not been used for `bytecode` already by the same `msg.sender`.
     * - `init` is used to initialize the deployed contract
     *    as an option to not have the constructor args affect the address derived by `CREATE2`.
     */
    function deployAndInit(
        bytes memory bytecode,
        bytes32 salt,
        bytes calldata init
    ) external returns (address deployedAddress_) {
        deployedAddress_ = _deploy(
            bytecode,
            keccak256(abi.encode(msg.sender, salt))
        );

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = deployedAddress_.call(init);
        if (!success) revert FailedInit();
    }

    /**
     * @dev Returns the address where a contract will be stored if deployed via {deploy} or {deployAndInit} by `sender`.
     * Any change in the `bytecode`, `sender`, or `salt` will result in a new destination address.
     */
    function deployedAddress(
        bytes calldata bytecode,
        address sender,
        bytes32 salt
    ) external view returns (address deployedAddress_) {
        bytes32 newSalt = keccak256(abi.encode(sender, salt));
        bytes32 bytecodeHash = bytes32(keccak256(bytecode));
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40) //Get free memory pointer
            mstore(add(ptr, 0x40), bytecodeHash)
            mstore(add(ptr, 0x20), salt)
            mstore(ptr, sender) // Right-aligned with 12 preceding garbage bytes
            let start := add(ptr, 0x0b) // The hashed data starts at the final garbage byte which we will set to 0xff
            mstore8(start, 0xff)
            deployedAddress_ := keccak256(start, 85)
        }
    }

    function _deploy(
        bytes memory bytecode,
        bytes32 salt
    ) internal returns (address deployedAddress_) {
        if (bytecode.length == 0) revert EmptyBytecode();

        // solhint-disable-next-line no-inline-assembly
        assembly {
            deployedAddress_ := create2(
                0,
                add(bytecode, 32),
                mload(bytecode),
                salt
            )
        }

        if (deployedAddress_ == address(0)) revert FailedDeploy();

        emit Deployed(keccak256(bytecode), salt, deployedAddress_);
    }
}
