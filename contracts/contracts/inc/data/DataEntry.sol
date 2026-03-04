// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import "./DataEnum.sol";

    struct DataEntry {
        address sender;
        bytes encryptedCid;
        DataStatus status;
        address assignedVerifier;
    }