// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IWETH} from "../interfaces/IWETH.sol";
import {HypNative} from "../HypNative.sol";
import {HypNativeWethWrapper} from "./HypNativeWethWrapper.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/**
 * @title HypNativeWethWrapperFactory
 * @notice Deploys CREATE2 `HypNativeWethWrapper` instances for a fixed WETH.
 * @dev The factory commits to a single WETH address (canonical per chain) and
 *      produces one deterministic wrapper per `HypNative` router. Wrappers are
 *      immutable and non-ownable; the factory itself holds no state.
 */
contract HypNativeWethWrapperFactory {
    IWETH public immutable weth;

    event WrapperDeployed(
        HypNative indexed hypNative,
        HypNativeWethWrapper wrapper
    );

    constructor(IWETH _weth) {
        weth = _weth;
    }

    /**
     * @notice Deploys a wrapper for `_hypNative` if one does not exist.
     * @param _hypNative The HypNative router to wrap.
     * @return wrapper The deployed (or pre-existing) wrapper.
     */
    function deploy(
        HypNative _hypNative
    ) external returns (HypNativeWethWrapper wrapper) {
        wrapper = getAddress(_hypNative);
        if (address(wrapper).code.length == 0) {
            Create2.deploy(0, bytes32(0), _initCode(_hypNative));
            emit WrapperDeployed(_hypNative, wrapper);
        }
    }

    /**
     * @notice Returns the deterministic wrapper address for `_hypNative`.
     */
    function getAddress(
        HypNative _hypNative
    ) public view returns (HypNativeWethWrapper) {
        return
            HypNativeWethWrapper(
                payable(
                    Create2.computeAddress(
                        bytes32(0),
                        keccak256(_initCode(_hypNative))
                    )
                )
            );
    }

    function _initCode(
        HypNative _hypNative
    ) private view returns (bytes memory) {
        return
            abi.encodePacked(
                type(HypNativeWethWrapper).creationCode,
                abi.encode(weth, _hypNative)
            );
    }
}
