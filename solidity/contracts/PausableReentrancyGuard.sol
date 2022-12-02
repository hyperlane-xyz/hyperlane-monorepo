// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// adapted from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
abstract contract PausableReentrancyGuardUpgradeable is Initializable {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private constant _PAUSED = 3;

    uint256 private _status;

    function __PausableReentrancyGuard_init() internal onlyInitializing {
        _status = _NOT_ENTERED;
    }

    function _pause() internal {
        _status = _PAUSED;
    }

    function _unpause() internal {
        _status = _NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from being called when paused.
     */
    modifier notPaused() {
        require(_status != _PAUSED, "!paused");
        _;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        // status must have been initialized
        require(_status == _NOT_ENTERED, "ReentrancyGuard: reentrant call");

        // Any calls to nonReentrant after this point will fail
        _status = _ENTERED;

        _;

        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = _NOT_ENTERED;
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[49] private __gap;
}
