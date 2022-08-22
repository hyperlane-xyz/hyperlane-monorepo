interface IMultisigValidatorManager {
    function domain() external view returns (uint32);

    // The domain hash of the validator set's outbox chain.
    function domainHash() external view returns (bytes32);

    function threshold() external view returns (uint256);
}
