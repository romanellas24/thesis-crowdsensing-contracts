// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

struct NovelParameters {
    bool rewardDecayEnabled;
    uint256 rewardDecayFactor;
    uint256 kickVerifierAfterWrongVotes; // 0 = disabled
    uint256 pardonWrongVoteAfterRightVotes; // 0 = disabled
}