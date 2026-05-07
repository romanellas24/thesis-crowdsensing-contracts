# Thesis: Privacy-Enhanced Crowdsensing via Smart Contracts

Smart contract implementation and gas analysis for a privacy-enhanced decentralized crowdsensing protocol.

## Overview

This project implements a blockchain-based protocol where a smart contract acts as a trusted intermediary for crowdsensing campaigns, enabling pseudonymous participation through campaign-specific key pairs and multi-layered encryption.

### Protocol Actors

- **A (Sender)**: End-users who contribute data to the crowdsensing campaign
- **B (Admin)**: Campaign initiator responsible for collecting and processing submitted data
- **V (Verifier)**: Independent verifier who validates the submitted data
- **SC**: Smart contract deployed on-chain that mediates all interactions

## Project Structure (WIP)

## Prerequisites (WIP)

## Setup

```bash
npm install
```

## Usage

```bash
# Compile contracts
npx hardhat compile

# Run tests with gas reporting
npx hardhat test
```

## Tech Stack

- Solidity ^0.8.28
- Hardhat 2.x (Mocha + Ethers.js)
- OpenZeppelin Contracts (ERC-20, Ownable)
- hardhat-gas-reporter

## License
CC BY 4.0 - you can reuse anything, just give credit.