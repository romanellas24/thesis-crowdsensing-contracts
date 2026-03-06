pragma solidity ^0.8.28;

struct RewardConfig {
    uint totalDst;
    uint16 dataSenderPayout;
    uint16 dataVerifierPayout;
    uint16 dataSenderBond;
    uint16 dataVerifierBond;
}