// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITIP20} from "../../contracts/token/interfaces/ITIP20.sol";

/**
 * @title MockTIP20
 * @notice Mock TIP-20 token for testing HypTIP20 contract.
 * @dev Implements ITIP20 interface with basic ERC-20 functionality plus memo support and pause controls.
 */
contract MockTIP20 is ERC20, AccessControl, ITIP20 {
    /// @notice Role identifier for issuers
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice Owner of the contract (for backward compatibility)
    address public owner;

    /// @notice Transfer policy ID (default 1 = allow all)
    uint64 public _transferPolicyId;

    /// @notice Pause state
    bool private _paused;

    /// @notice Event emitted when tokens are minted with a memo
    event MintWithMemo(
        address indexed to,
        uint256 amount,
        bytes32 indexed memo
    );

    /// @notice Event emitted when tokens are burned with a memo
    event BurnWithMemo(
        address indexed from,
        uint256 amount,
        bytes32 indexed memo
    );

    /// @notice Event emitted when tokens are transferred with a memo
    event TransferWithMemo(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 indexed memo
    );

    /// @notice Event emitted when the token is paused
    event Paused(address indexed account);

    /// @notice Event emitted when the token is unpaused
    event Unpaused(address indexed account);

    /// @notice Modifier to check if caller is owner
    modifier onlyOwner() {
        require(msg.sender == owner, "MockTIP20: only owner");
        _;
    }

    /// @notice Modifier to check if token is not paused
    modifier whenNotPaused() {
        require(!_paused, "MockTIP20: token is paused");
        _;
    }

    /**
     * @notice Initialize the mock TIP-20 token
     * @param name Token name
     * @param symbol Token symbol
     */
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        owner = msg.sender;
        _transferPolicyId = 1; // Default: allow all
        _paused = false;

        // Grant DEFAULT_ADMIN_ROLE to owner for AccessControl compatibility
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Returns the number of decimals used by the token (always 6 for TIP-20)
     * @return The number of decimals
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Mints tokens to an address
     * @dev Only owner or ISSUER_ROLE can mint. Reverts on failure.
     * @param to The address that will receive the minted tokens
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) external whenNotPaused {
        require(
            msg.sender == owner || hasRole(ISSUER_ROLE, msg.sender),
            "MockTIP20: caller is not owner or issuer"
        );
        _mint(to, amount);
    }

    /**
     * @notice Mints tokens to an address with a memo
     * @dev Only owner or ISSUER_ROLE can mint. Reverts on failure.
     * @param to The address that will receive the minted tokens
     * @param amount The amount of tokens to mint
     * @param memo A bytes32 memo associated with the mint operation
     */
    function mintWithMemo(
        address to,
        uint256 amount,
        bytes32 memo
    ) external whenNotPaused {
        require(
            msg.sender == owner || hasRole(ISSUER_ROLE, msg.sender),
            "MockTIP20: caller is not owner or issuer"
        );
        _mint(to, amount);
        emit MintWithMemo(to, amount, memo);
    }

    /**
     * @notice Burns tokens from the caller's balance
     * @dev Reverts on failure.
     * @param amount The amount of tokens to burn
     */
    function burn(uint256 amount) external whenNotPaused {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Burns tokens from the caller's balance with a memo
     * @dev Reverts on failure.
     * @param amount The amount of tokens to burn
     * @param memo A bytes32 memo associated with the burn operation
     */
    function burnWithMemo(uint256 amount, bytes32 memo) external whenNotPaused {
        _burn(msg.sender, amount);
        emit BurnWithMemo(msg.sender, amount, memo);
    }

    /**
     * @notice Transfers tokens to a recipient with a memo
     * @dev Reverts on failure.
     * @param to The address to transfer tokens to
     * @param amount The amount of tokens to transfer
     * @param memo A bytes32 memo associated with the transfer
     */
    function transferWithMemo(
        address to,
        uint256 amount,
        bytes32 memo
    ) external whenNotPaused {
        _transfer(msg.sender, to, amount);
        emit TransferWithMemo(msg.sender, to, amount, memo);
    }

    /**
     * @notice Transfers tokens from one address to another with a memo
     * @dev Reverts on failure.
     * @param from The address to transfer tokens from
     * @param to The address to transfer tokens to
     * @param amount The amount of tokens to transfer
     * @param memo A bytes32 memo associated with the transfer
     * @return True if the operation was successful
     */
    function transferFromWithMemo(
        address from,
        address to,
        uint256 amount,
        bytes32 memo
    ) external whenNotPaused returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        emit TransferWithMemo(from, to, amount, memo);
        return true;
    }

    /**
     * @notice Gets the transfer policy ID for this token
     * @return The policy ID as a uint64
     */
    function transferPolicyId() external view returns (uint64) {
        return _transferPolicyId;
    }

    /**
     * @notice Checks if the token is paused
     * @return True if the token is paused, false otherwise
     */
    function paused() external view returns (bool) {
        return _paused;
    }

    /**
     * @notice Pauses the token (only owner)
     */
    function pause() external onlyOwner {
        _paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpauses the token (only owner)
     */
    function unpause() external onlyOwner {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Sets the transfer policy ID (only owner)
     * @param policyId The new policy ID
     */
    function setTransferPolicyId(uint64 policyId) external onlyOwner {
        _transferPolicyId = policyId;
    }

    /**
     * @notice Transfers ownership to a new address (only owner)
     * @param newOwner The address of the new owner
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MockTIP20: new owner is zero address");
        owner = newOwner;
    }
}
