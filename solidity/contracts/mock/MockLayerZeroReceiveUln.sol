// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {MockLayerZeroEndpointV2} from "./MockLayerZeroEndpointV2.sol";

contract MockLayerZeroReceiveUln {
    uint8 internal constant NIL_DVN_COUNT = type(uint8).max;
    uint64 internal constant NIL_CONFIRMATIONS = type(uint64).max;

    MockLayerZeroEndpointV2 public immutable endpoint;
    bool public ready = true;

    constructor(address endpoint_) {
        endpoint = MockLayerZeroEndpointV2(endpoint_);
    }

    function setReady(bool ready_) external {
        ready = ready_;
    }

    function executorConfigs(
        address oapp,
        uint32 remoteEid
    ) external view returns (ExecutorConfig memory config) {
        bytes memory encoded = endpoint.configs(
            oapp,
            address(this),
            remoteEid,
            1
        );
        if (encoded.length != 0) config = abi.decode(encoded, (ExecutorConfig));
    }

    function getAppUlnConfig(
        address oapp,
        uint32 remoteEid
    ) external view returns (UlnConfig memory config) {
        bytes memory encoded = endpoint.configs(
            oapp,
            address(this),
            remoteEid,
            2
        );
        if (encoded.length != 0) config = abi.decode(encoded, (UlnConfig));
    }

    function getDefaultConfig(
        uint32 configType
    ) external view returns (bytes memory) {
        if (configType == 1) {
            return
                abi.encode(
                    ExecutorConfig({
                        maxMessageSize: 10_000,
                        executor: address(this)
                    })
                );
        }
        require(configType == 2, "config type");
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
        uint32 remoteEid,
        uint32 configType
    ) external view returns (bytes memory) {
        if (configType == 1) {
            ExecutorConfig memory executorDefaults = abi.decode(
                this.getDefaultConfig(configType),
                (ExecutorConfig)
            );
            ExecutorConfig memory appExecutor = this.executorConfigs(
                oapp,
                remoteEid
            );
            if (appExecutor.maxMessageSize != 0) {
                executorDefaults.maxMessageSize = appExecutor.maxMessageSize;
            }
            if (appExecutor.executor != address(0)) {
                executorDefaults.executor = appExecutor.executor;
            }
            return abi.encode(executorDefaults);
        }
        require(configType == 2, "config type");
        UlnConfig memory ulnDefaults = abi.decode(
            this.getDefaultConfig(configType),
            (UlnConfig)
        );
        UlnConfig memory appUln = this.getAppUlnConfig(oapp, remoteEid);
        if (appUln.confirmations != 0) {
            ulnDefaults.confirmations = appUln.confirmations ==
                NIL_CONFIRMATIONS
                ? 0
                : appUln.confirmations;
        }
        if (appUln.requiredDVNCount != 0) {
            if (appUln.requiredDVNCount == NIL_DVN_COUNT) {
                ulnDefaults.requiredDVNCount = 0;
                ulnDefaults.requiredDVNs = new address[](0);
            } else {
                ulnDefaults.requiredDVNCount = appUln.requiredDVNCount;
                ulnDefaults.requiredDVNs = appUln.requiredDVNs;
            }
        }
        if (appUln.optionalDVNCount != 0) {
            if (appUln.optionalDVNCount == NIL_DVN_COUNT) {
                ulnDefaults.optionalDVNCount = 0;
                ulnDefaults.optionalDVNThreshold = 0;
                ulnDefaults.optionalDVNs = new address[](0);
            } else {
                ulnDefaults.optionalDVNCount = appUln.optionalDVNCount;
                ulnDefaults.optionalDVNThreshold = appUln.optionalDVNThreshold;
                ulnDefaults.optionalDVNs = appUln.optionalDVNs;
            }
        }
        return abi.encode(ulnDefaults);
    }

    function commitVerification(
        bytes calldata packetHeader,
        bytes32 payloadHash
    ) external {
        require(ready, "DVNs pending");
        require(packetHeader.length == 81, "header");
        uint64 nonce;
        uint32 srcEid;
        bytes32 sender;
        address receiver;
        assembly ("memory-safe") {
            nonce := shr(192, calldataload(add(packetHeader.offset, 1)))
            srcEid := shr(224, calldataload(add(packetHeader.offset, 9)))
            sender := calldataload(add(packetHeader.offset, 13))
            receiver := calldataload(add(packetHeader.offset, 49))
        }
        endpoint.mockVerify(receiver, srcEid, sender, nonce, payloadHash);
    }
}
