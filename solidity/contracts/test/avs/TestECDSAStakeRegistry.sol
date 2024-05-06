// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ISignatureUtils} from "../../interfaces/avs/ISignatureUtils.sol";
import {Quorum, IECDSAStakeRegistry} from "../../interfaces/avs/IECDSAStakeRegistry.sol";
import {IServiceManager} from "../../interfaces/avs/IServiceManager.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract TestECDSAStakeRegistry is IECDSAStakeRegistry {
    Quorum internal _quorum;
    address internal _serviceManager;

    function initialize(
        address serviceManager,
        uint256,
        Quorum memory
    ) external {
        _serviceManager = serviceManager;
    }

    function quorum() external view returns (Quorum memory) {}

    function registerOperatorWithSignature(
        address _operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory _operatorSignature
    ) external {
        IServiceManager(_serviceManager).registerOperatorToAVS(
            _operator,
            _operatorSignature
        );
    }

    function deregisterOperator() external {
        IServiceManager(_serviceManager).deregisterOperatorFromAVS(msg.sender);
    }
}
