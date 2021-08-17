const LMSRMarketMakerFactory = artifacts.require("LMSRMarketMakerFactory");
const FixedProductMarketMakerFactory = artifacts.require(
  "FixedProductMarketMakerFactory"
);
const FPMMDeterministicFactoryV2 = artifacts.require(
  "FPMMDeterministicFactoryV2"
);

module.exports = function (deployer) {
  deployer.link(artifacts.require("Fixed192x64Math"), LMSRMarketMakerFactory);
  deployer.deploy(LMSRMarketMakerFactory);
  deployer.deploy(FixedProductMarketMakerFactory);
  deployer.deploy(FPMMDeterministicFactoryV2);
};
