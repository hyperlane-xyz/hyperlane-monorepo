// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DelegationManager} from "@eigenlayer/core/DelegationManager.sol";
import {ISignatureUtils} from "@eigenlayer/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";

import {MockAVSDeployer} from "eigenlayer-middleware/test/utils/MockAVSDeployer.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistry.sol";

import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";

contract HyperlaneServiceManagerTest is MockAVSDeployer {
    // TODO
    // register -> deregister
    // register -> stake -> deregister
    // register -> stake -> queue withdrawal -> deregister
    // register -> stake -> queue withdrawal -> complete -> deregister
    // enroll for 3 test challengers -> unenroll
    // enroll, stake/unstake -> unenroll
    // enroll,
    // register. enroll, unenroll partial, deregister
    // register. enroll, deregister
    // register, handle challenge=true, deregister

    DelegationManager public delegationManager;

    HyperlaneServiceManager internal hsm;
    ECDSAStakeRegistry internal ecdsaStakeRegistry;

    // Operator info
    uint256 operatorPrivateKey = 0xdeadbeef;
    address operator;

    bytes32 emptySalt;
    uint256 maxExpiry = type(uint256).max;

    function setUp() public {
        _deployMockEigenLayerAndAVS();

        delegationManager = new DelegationManager(
            strategyManagerMock,
            slasher,
            eigenPodManagerMock
        );

        ecdsaStakeRegistry = new ECDSAStakeRegistry(delegationManager);

        hsm = new HyperlaneServiceManager(avsDirectory, ecdsaStakeRegistry);

        // todo
        // IStakeRegistry.StrategyParams[][] memory quorumStrategiesConsideredAndMultipliers =
        //     new IStakeRegistry.StrategyParams[][](numQuorumsToAdd);
        // for (uint256 i = 0; i < quorumStrategiesConsideredAndMultipliers.length; i++) {
        //     quorumStrategiesConsideredAndMultipliers[i] = new IStakeRegistry.StrategyParams[](1);
        //     quorumStrategiesConsideredAndMultipliers[i][0] =
        //         IStakeRegistry.StrategyParams(IStrategy(address(uint160(i))), uint96(WEIGHTING_DIVISOR));
        // }
        // Quorum memory _quorum = Quorum({strategies: quorumStrategiesConsideredAndMultipliers});
        // ecdsaStakeRegistry.initialize(address(hsm), 6667, _quorum);
    }

    function test_registerOperator() public {
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(hsm),
                emptySalt,
                maxExpiry
            );
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(serviceManager), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.REGISTERED)
        );
    }

    function _getOperatorSignature(
        uint256 _operatorPrivateKey,
        address operatorToSign,
        address avs,
        bytes32 salt,
        uint256 expiry
    )
        internal
        view
        returns (
            ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
        )
    {
        operatorSignature.salt = salt;
        operatorSignature.expiry = expiry;
        {
            bytes32 digestHash = avsDirectory
                .calculateOperatorAVSRegistrationDigestHash(
                    operatorToSign,
                    avs,
                    salt,
                    expiry
                );
            (uint8 v, bytes32 r, bytes32 s) = cheats.sign(
                _operatorPrivateKey,
                digestHash
            );
            operatorSignature.signature = abi.encodePacked(r, s, v);
        }
        return operatorSignature;
    }
}
