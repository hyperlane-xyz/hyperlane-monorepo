// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {MockLayerZeroReceiveUln} from "./MockLayerZeroReceiveUln.sol";

/**
 * @notice Mock ULN302 library that also exposes app and default-resolved
 * (effective) configs, so offchain readers can be tested against both.
 */
contract MockLayerZeroUln302 is MockLayerZeroReceiveUln {
    uint32 internal constant EXECUTOR_CONFIG_TYPE = 1;
    uint32 internal constant ULN_CONFIG_TYPE = 2;
    uint8 internal constant NIL_DVN_COUNT = type(uint8).max;
    uint64 internal constant NIL_CONFIRMATIONS = type(uint64).max;

    constructor(
        address _endpointAddress
    ) MockLayerZeroReceiveUln(_endpointAddress) {}

    function executorConfigs(
        address oapp,
        uint32 remoteEndpointId
    ) public view returns (ExecutorConfig memory config) {
        bytes memory encoded = endpoint.configs(
            oapp,
            address(this),
            remoteEndpointId,
            EXECUTOR_CONFIG_TYPE
        );
        if (encoded.length != 0) config = abi.decode(encoded, (ExecutorConfig));
    }

    function getAppUlnConfig(
        address oapp,
        uint32 remoteEndpointId
    ) public view returns (UlnConfig memory config) {
        bytes memory encoded = endpoint.configs(
            oapp,
            address(this),
            remoteEndpointId,
            ULN_CONFIG_TYPE
        );
        if (encoded.length != 0) config = abi.decode(encoded, (UlnConfig));
    }

    function getDefaultConfig(
        uint32 configType
    ) public view returns (bytes memory) {
        if (configType == EXECUTOR_CONFIG_TYPE) {
            return
                abi.encode(
                    ExecutorConfig({
                        maxMessageSize: 10_000,
                        executor: address(this)
                    })
                );
        }
        require(configType == ULN_CONFIG_TYPE, "config type");
        address[] memory requiredDVNs = new address[](1);
        requiredDVNs[0] = address(this);
        return
            abi.encode(
                UlnConfig({
                    confirmations: 12,
                    requiredDVNCount: 1,
                    optionalDVNCount: 0,
                    optionalDVNThreshold: 0,
                    requiredDVNs: requiredDVNs,
                    optionalDVNs: new address[](0)
                })
            );
    }

    function getEffectiveConfig(
        address oapp,
        uint32 remoteEndpointId,
        uint32 configType
    ) external view returns (bytes memory) {
        if (configType == EXECUTOR_CONFIG_TYPE) {
            ExecutorConfig memory effectiveExecutor = abi.decode(
                getDefaultConfig(configType),
                (ExecutorConfig)
            );
            ExecutorConfig memory appExecutor = executorConfigs(
                oapp,
                remoteEndpointId
            );
            if (appExecutor.maxMessageSize != 0) {
                effectiveExecutor.maxMessageSize = appExecutor.maxMessageSize;
            }
            if (appExecutor.executor != address(0)) {
                effectiveExecutor.executor = appExecutor.executor;
            }
            return abi.encode(effectiveExecutor);
        }
        require(configType == ULN_CONFIG_TYPE, "config type");
        UlnConfig memory effectiveUln = abi.decode(
            getDefaultConfig(configType),
            (UlnConfig)
        );
        UlnConfig memory appUln = getAppUlnConfig(oapp, remoteEndpointId);
        if (appUln.confirmations != 0) {
            effectiveUln.confirmations = appUln.confirmations ==
                NIL_CONFIRMATIONS
                ? 0
                : appUln.confirmations;
        }
        if (appUln.requiredDVNCount != 0) {
            if (appUln.requiredDVNCount == NIL_DVN_COUNT) {
                effectiveUln.requiredDVNCount = 0;
                effectiveUln.requiredDVNs = new address[](0);
            } else {
                effectiveUln.requiredDVNCount = appUln.requiredDVNCount;
                effectiveUln.requiredDVNs = appUln.requiredDVNs;
            }
        }
        if (appUln.optionalDVNCount != 0) {
            if (appUln.optionalDVNCount == NIL_DVN_COUNT) {
                effectiveUln.optionalDVNCount = 0;
                effectiveUln.optionalDVNThreshold = 0;
                effectiveUln.optionalDVNs = new address[](0);
            } else {
                effectiveUln.optionalDVNCount = appUln.optionalDVNCount;
                effectiveUln.optionalDVNThreshold = appUln.optionalDVNThreshold;
                effectiveUln.optionalDVNs = appUln.optionalDVNs;
            }
        }
        return abi.encode(effectiveUln);
    }
}
