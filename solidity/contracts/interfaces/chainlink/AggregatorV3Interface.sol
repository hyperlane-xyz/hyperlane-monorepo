// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface AggregatorV3Interface {
    event AnswerUpdated(
        int256 indexed current,
        uint256 indexed roundId,
        uint256 updatedAt
    );
    event NewRound(
        uint256 indexed roundId,
        address indexed startedBy,
        uint256 startedAt
    );

    /**
     * @notice indicates that a new report was transmitted
     * @param aggregatorRoundId the round to which this report was assigned
     * @param answer median of the observations attached this report
     * @param transmitter address from which the report was transmitted
     * @param observations observations transmitted with this report
     * @param rawReportContext signature-replay-prevention domain-separation tag
     */
    event NewTransmission(
        uint32 indexed aggregatorRoundId,
        int192 answer,
        address transmitter,
        int192[] observations,
        bytes observers,
        bytes32 rawReportContext
    );

    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
