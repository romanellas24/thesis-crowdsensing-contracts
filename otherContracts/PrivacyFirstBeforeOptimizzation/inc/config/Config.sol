// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./SmartContractNeeds.sol";
import "./ChunkConfig.sol";
import "./RewardConfig.sol";
import "../chunks/GlobalPosition.sol";

    struct Config {
        SmartContractNeeds needs;
        ChunkConfig chunkConfig;
        RewardConfig rewardConfig;
        GlobalPosition originCoordinates;
    }