import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
  },
  mocha: {
    timeout: 60 * 1000
  },
  networks: {
    /*
    GAS CONSUMPTION
    hardhat: {
      blockGasLimit: 1_000_000_000,
      hardfork: "cancun",
    }
     */
    hardhat : {
      blockGasLimit: 60_000_000,
      mining: { auto: false, interval: 200 }
    }
  }
};

export default config;