const { step } = require("mocha-steps");
const { expectEvent } = require("openzeppelin-test-helpers");
const { getConditionId, getCollectionId, getPositionId } =
  require("@gnosis.pm/conditional-tokens-contracts/utils/id-helpers")(
    web3.utils
  );
const { randomHex, toBN } = web3.utils;

const ConditionalTokens = artifacts.require("ConditionalTokens");
const WETH9 = artifacts.require("WETH9");
const FPMMDeterministicFactoryV2 = artifacts.require(
  "FPMMDeterministicFactoryV2"
);
const FixedProductMarketMaker = artifacts.require("FixedProductMarketMaker");

contract(
  "FPMMDeterministicFactoryV2",
  function ([feeSetter, creator, oracle, trader, investor2, testInvestor]) {
    const questionId = randomHex(32);
    const numOutcomes = 10;
    const conditionId = getConditionId(oracle, questionId, numOutcomes);
    const collectionIds = Array.from({ length: numOutcomes }, (_, i) =>
      getCollectionId(conditionId, toBN(1).shln(i))
    );

    let conditionalTokens;
    let collateralToken;
    let fpmmDeterministicFactory;
    let positionIds;
    before(async function () {
      conditionalTokens = await ConditionalTokens.deployed();
      collateralToken = await WETH9.deployed();
      fpmmDeterministicFactory = await FPMMDeterministicFactoryV2.deployed({
        from: feeSetter,
      });
      positionIds = collectionIds.map((collectionId) =>
        getPositionId(collateralToken.address, collectionId)
      );
    });

    let fixedProductMarketMaker;
    const saltNonce = toBN(2020);
    const feeFactor = toBN(3e15); // (0.3%)
    const initialFunds = toBN(10e18);
    const initialDistribution = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const expectedFundedAmounts = initialDistribution.map((n) =>
      toBN(1e18 * n)
    );

    step("can set protocol fee", async function () {
      await fpmmDeterministicFactory.setProtocolFeeOn(true, {
        from: feeSetter,
      });
      await fpmmDeterministicFactory.setProtocolFeeDenominator(toBN(10), {
        from: feeSetter,
      });
      const protocolFeeOn = await fpmmDeterministicFactory.protocolFeeOn();
      const protocolFeeDenominator =
        await fpmmDeterministicFactory.protocolFeeDenominator();

      protocolFeeOn.should.be.true;
      protocolFeeDenominator.should.be.bignumber.equal(toBN(10));
    });

    step("can be created and funded by factory", async function () {
      await collateralToken.deposit({ value: initialFunds, from: creator });
      await collateralToken.approve(
        fpmmDeterministicFactory.address,
        initialFunds,
        { from: creator }
      );

      await conditionalTokens.prepareCondition(oracle, questionId, numOutcomes);
      const createArgs = [
        saltNonce,
        conditionalTokens.address,
        collateralToken.address,
        [conditionId],
        feeFactor,
        initialFunds,
        initialDistribution,
        { from: creator },
      ];
      const fixedProductMarketMakerAddress =
        await fpmmDeterministicFactory.create2FixedProductMarketMaker.call(
          ...createArgs
        );

      // TODO: somehow abstract this deterministic address calculation into a utility function
      fixedProductMarketMakerAddress.should.be.equal(
        web3.utils.toChecksumAddress(
          `0x${web3.utils
            .soliditySha3(
              { t: "bytes", v: "0xff" },
              { t: "address", v: fpmmDeterministicFactory.address },
              {
                t: "bytes32",
                v: web3.utils.keccak256(
                  web3.eth.abi.encodeParameters(
                    ["address", "uint"],
                    [creator, saltNonce.toString()]
                  )
                ),
              },
              {
                t: "bytes32",
                v: web3.utils.keccak256(
                  `0x3d3d606380380380913d393d73${fpmmDeterministicFactory.address.replace(
                    /^0x/,
                    ""
                  )}5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73${(
                    await fpmmDeterministicFactory.implementationMaster()
                  ).replace(
                    /^0x/,
                    ""
                  )}5af43d82803e903d91602b57fd5bf3${web3.eth.abi
                    .encodeFunctionCall(
                      {
                        name: "cloneConstructor",
                        type: "function",
                        inputs: [
                          {
                            type: "bytes",
                            name: "data",
                          },
                        ],
                      },
                      [
                        web3.eth.abi.encodeParameters(
                          [
                            "address",
                            "address",
                            "bytes32[]",
                            "uint",
                            "address",
                          ],
                          [
                            conditionalTokens.address,
                            collateralToken.address,
                            [conditionId],
                            feeFactor.toString(),
                            fpmmDeterministicFactory.address,
                          ]
                        ),
                      ]
                    )
                    .replace(/^0x/, "")}`
                ),
              }
            )
            .slice(-40)}`
        )
      );

      const createTx =
        await fpmmDeterministicFactory.create2FixedProductMarketMaker(
          ...createArgs
        );
      expectEvent.inLogs(createTx.logs, "FixedProductMarketMakerCreation", {
        creator,
        fixedProductMarketMaker: fixedProductMarketMakerAddress,
        conditionalTokens: conditionalTokens.address,
        collateralToken: collateralToken.address,
        // conditionIds: [conditionId],
        fee: feeFactor,
      });

      expectEvent.inLogs(createTx.logs, "FPMMFundingAdded", {
        funder: fpmmDeterministicFactory.address,
        // amountsAdded: expectedFundedAmounts,
        sharesMinted: initialFunds,
      });

      fixedProductMarketMaker = await FixedProductMarketMaker.at(
        fixedProductMarketMakerAddress
      );

      (await collateralToken.balanceOf(creator)).should.be.a.bignumber.equal(
        "0"
      );
      (
        await fixedProductMarketMaker.balanceOf(creator)
      ).should.be.a.bignumber.equal(initialFunds);

      for (let i = 0; i < positionIds.length; i++) {
        (
          await conditionalTokens.balanceOf(
            fixedProductMarketMaker.address,
            positionIds[i]
          )
        ).should.be.a.bignumber.equal(expectedFundedAmounts[i]);
        (
          await conditionalTokens.balanceOf(creator, positionIds[i])
        ).should.be.a.bignumber.equal(
          initialFunds.sub(expectedFundedAmounts[i])
        );
      }
    });

    const feePoolManipulationAmount = toBN(30e18);
    const testAdditionalFunding = toBN(1e18);
    const expectedTestEndingAmounts = initialDistribution.map((n) =>
      toBN(1.1e18 * n)
    );
    step(
      "cannot set fee pool proportion directly with transfer",
      async function () {
        await collateralToken.deposit({
          from: creator,
          value: feePoolManipulationAmount,
        });
        await collateralToken.transfer(
          fixedProductMarketMaker.address,
          feePoolManipulationAmount,
          { from: creator }
        );

        await collateralToken.deposit({
          value: testAdditionalFunding,
          from: testInvestor,
        });
        await collateralToken.approve(
          fixedProductMarketMaker.address,
          testAdditionalFunding,
          { from: testInvestor }
        );
        await fixedProductMarketMaker.addFunding(testAdditionalFunding, [], {
          from: testInvestor,
        });

        for (let i = 0; i < positionIds.length; i++) {
          (
            await conditionalTokens.balanceOf(
              fixedProductMarketMaker.address,
              positionIds[i]
            )
          ).should.be.a.bignumber.equal(expectedTestEndingAmounts[i]);
          (
            await conditionalTokens.balanceOf(testInvestor, positionIds[i])
          ).should.be.a.bignumber.equal(
            testAdditionalFunding
              .add(expectedFundedAmounts[i])
              .sub(expectedTestEndingAmounts[i])
          );
        }

        (
          await fixedProductMarketMaker.balanceOf(testInvestor)
        ).should.be.a.bignumber.equal(testAdditionalFunding);

        await fixedProductMarketMaker.removeFunding(testAdditionalFunding, {
          from: testInvestor,
        });
      }
    );

    let marketMakerPool;
    let buyProtocolFeeAmount;
    step("can buy tokens from it", async function () {
      const investmentAmount = toBN(1e18);
      const buyOutcomeIndex = 1;
      await collateralToken.deposit({ value: investmentAmount, from: trader });
      await collateralToken.approve(
        fixedProductMarketMaker.address,
        investmentAmount,
        { from: trader }
      );

      const outcomeTokensToBuy = await fixedProductMarketMaker.calcBuyAmount(
        investmentAmount,
        buyOutcomeIndex
      );
      const feeAmount = investmentAmount.mul(feeFactor).div(investmentAmount);

      const protocolFeeDenominator =
        await fpmmDeterministicFactory.protocolFeeDenominator();
      buyProtocolFeeAmount = feeAmount.div(protocolFeeDenominator);

      const poolProductBefore = (
        await conditionalTokens.balanceOfBatch(
          Array.from(positionIds, () => fixedProductMarketMaker.address),
          positionIds
        )
      ).reduce((a, b) => a.mul(b), toBN(1));

      const buyTx = await fixedProductMarketMaker.buy(
        investmentAmount,
        buyOutcomeIndex,
        outcomeTokensToBuy,
        { from: trader }
      );
      expectEvent.inLogs(buyTx.logs, "FPMMBuy", {
        buyer: trader,
        investmentAmount,
        feeAmount,
        outcomeIndex: toBN(buyOutcomeIndex),
        outcomeTokensBought: outcomeTokensToBuy,
      });

      const poolProductAfter = (
        await conditionalTokens.balanceOfBatch(
          Array.from(positionIds, () => fixedProductMarketMaker.address),
          positionIds
        )
      ).reduce((a, b) => a.mul(b), toBN(1));

      poolProductAfter
        .sub(poolProductBefore)
        .should.be.a.bignumber.gte("0")
        .and.be.a.bignumber.lte(
          poolProductBefore
            .mul(feeAmount.mul(toBN(positionIds.length)))
            .div(investmentAmount)
        );
      (await collateralToken.balanceOf(trader)).should.be.a.bignumber.equal(
        "0"
      );
      (
        await fixedProductMarketMaker.balanceOf(trader)
      ).should.be.a.bignumber.equal("0");
      (
        await collateralToken.balanceOf(fixedProductMarketMaker.address)
      ).should.be.a.bignumber.equal(feePoolManipulationAmount);

      marketMakerPool = [];
      for (let i = 0; i < positionIds.length; i++) {
        let newMarketMakerBalance;
        if (i === buyOutcomeIndex) {
          newMarketMakerBalance = expectedFundedAmounts[i]
            .add(investmentAmount)
            .sub(outcomeTokensToBuy);
          (
            await conditionalTokens.balanceOf(trader, positionIds[i])
          ).should.be.a.bignumber.equal(outcomeTokensToBuy);
        } else {
          newMarketMakerBalance =
            expectedFundedAmounts[i].add(investmentAmount);
          (
            await conditionalTokens.balanceOf(trader, positionIds[i])
          ).should.be.a.bignumber.equal("0");
        }
        (
          await conditionalTokens.balanceOf(
            fixedProductMarketMaker.address,
            positionIds[i]
          )
        ).should.be.a.bignumber.equal(
          newMarketMakerBalance.sub(buyProtocolFeeAmount)
        );
        marketMakerPool[i] = newMarketMakerBalance;
      }
    });

    step("cannot leech wei by adding and removing funding", async function () {
      const poolBalancesBefore = await conditionalTokens.balanceOfBatch(
        Array.from(positionIds, () => fixedProductMarketMaker.address),
        positionIds
      );
      const poolProductBefore = poolBalancesBefore.reduce(
        (a, b) => a.mul(b),
        toBN(1)
      );

      await collateralToken.deposit({
        value: testAdditionalFunding,
        from: testInvestor,
      });
      await collateralToken.approve(
        fixedProductMarketMaker.address,
        testAdditionalFunding,
        { from: testInvestor }
      );
      await fixedProductMarketMaker.addFunding(testAdditionalFunding, [], {
        from: testInvestor,
      });
      const testSharesMinted = await fixedProductMarketMaker.balanceOf(
        testInvestor
      );
      await fixedProductMarketMaker.removeFunding(testSharesMinted, {
        from: testInvestor,
      });

      const poolBalancesAfter = await conditionalTokens.balanceOfBatch(
        Array.from(positionIds, () => fixedProductMarketMaker.address),
        positionIds
      );
      const poolProductAfter = poolBalancesAfter.reduce(
        (a, b) => a.mul(b),
        toBN(1)
      );

      poolBalancesBefore.forEach((beforeBalance, i) => {
        poolBalancesAfter[i].should.be.a.bignumber.gte(beforeBalance);
      });

      poolProductAfter.should.be.a.bignumber.gte(poolProductBefore);
    });

    let totalProtocolFeeAmount;
    step("can sell tokens to it", async function () {
      const returnAmount = toBN(1e17);
      const sellOutcomeIndex = 1;
      await conditionalTokens.setApprovalForAll(
        fixedProductMarketMaker.address,
        true,
        { from: trader }
      );

      const outcomeTokensToSell = await fixedProductMarketMaker.calcSellAmount(
        returnAmount,
        sellOutcomeIndex
      );
      (
        await conditionalTokens.balanceOf(trader, positionIds[sellOutcomeIndex])
      ).should.be.a.bignumber.gte(outcomeTokensToSell);
      const feeAmount = returnAmount
        .mul(feeFactor)
        .div(toBN(1e18).sub(feeFactor));

      const protocolFeeDenominator =
        await fpmmDeterministicFactory.protocolFeeDenominator();
      totalProtocolFeeAmount = feeAmount
        .div(protocolFeeDenominator)
        .add(buyProtocolFeeAmount);

      const poolProductBefore = (
        await conditionalTokens.balanceOfBatch(
          Array.from(positionIds, () => fixedProductMarketMaker.address),
          positionIds
        )
      ).reduce((a, b) => a.mul(b), toBN(1));

      const sellTx = await fixedProductMarketMaker.sell(
        returnAmount,
        sellOutcomeIndex,
        outcomeTokensToSell,
        { from: trader }
      );
      expectEvent.inLogs(sellTx.logs, "FPMMSell", {
        seller: trader,
        returnAmount,
        feeAmount,
        outcomeIndex: toBN(sellOutcomeIndex),
        outcomeTokensSold: outcomeTokensToSell,
      });

      const poolProductAfter = (
        await conditionalTokens.balanceOfBatch(
          Array.from(positionIds, () => fixedProductMarketMaker.address),
          positionIds
        )
      ).reduce((a, b) => a.mul(b), toBN(1));

      poolProductAfter
        .sub(poolProductBefore)
        .should.be.a.bignumber.gte("0")
        .and.be.a.bignumber.lte(
          poolProductBefore
            .mul(feeAmount.mul(toBN(positionIds.length)))
            .div(toBN(1e18))
        );
      (await collateralToken.balanceOf(trader)).should.be.a.bignumber.equal(
        returnAmount
      );
      (
        await fixedProductMarketMaker.balanceOf(trader)
      ).should.be.a.bignumber.equal("0");

      for (let i = 0; i < positionIds.length; i++) {
        let newMarketMakerBalance;
        if (i === sellOutcomeIndex) {
          newMarketMakerBalance = marketMakerPool[i]
            .sub(returnAmount)
            .add(outcomeTokensToSell);
        } else {
          newMarketMakerBalance = marketMakerPool[i].sub(returnAmount);
        }
        (
          await conditionalTokens.balanceOf(
            fixedProductMarketMaker.address,
            positionIds[i]
          )
        ).should.be.a.bignumber.gte(
          newMarketMakerBalance.sub(totalProtocolFeeAmount)
        );
        marketMakerPool[i] = newMarketMakerBalance;
      }
    });

    const addedFunds2 = toBN(5e18);
    step("can continue being funded", async function () {
      const currentPoolBalances = await conditionalTokens.balanceOfBatch(
        new Array(positionIds.length).fill(fixedProductMarketMaker.address),
        positionIds
      );
      const maxPoolBalance = currentPoolBalances.reduce((a, b) =>
        a.gt(b) ? a : b
      );
      const currentPoolShareSupply =
        await fixedProductMarketMaker.totalSupply();

      await collateralToken.deposit({ value: addedFunds2, from: investor2 });
      await collateralToken.approve(
        fixedProductMarketMaker.address,
        addedFunds2,
        { from: investor2 }
      );

      const addFundingTx = await fixedProductMarketMaker.addFunding(
        addedFunds2,
        [],
        { from: investor2 }
      );

      expectEvent.inLogs(addFundingTx.logs, "FPMMFundingAdded", {
        funder: investor2,
        // amountsAdded,
        sharesMinted: currentPoolShareSupply
          .mul(addedFunds2)
          .div(maxPoolBalance),
      });

      (await collateralToken.balanceOf(investor2)).should.be.a.bignumber.equal(
        "0"
      );
      (
        await fixedProductMarketMaker.balanceOf(investor2)
      ).should.be.a.bignumber.gt("0");

      for (let i = 0; i < positionIds.length; i++) {
        let newMarketMakerBalance = await conditionalTokens.balanceOf(
          fixedProductMarketMaker.address,
          positionIds[i]
        );
        newMarketMakerBalance.should.be.a.bignumber
          .gt(marketMakerPool[i])
          .lte(marketMakerPool[i].add(addedFunds2).addn(1));
        marketMakerPool[i] = newMarketMakerBalance;

        (
          await conditionalTokens.balanceOf(investor2, positionIds[i])
        ).should.be.a.bignumber
          .gte("0")
          .lt(addedFunds2);
      }
    });

    const burnedShares1 = toBN(1e18);
    step("can be defunded", async function () {
      const creatorSharesBefore = await fixedProductMarketMaker.balanceOf(
        creator
      );
      const creatorCollateralBalanceBefore = await collateralToken.balanceOf(
        creator
      );
      const shareSupplyBefore = await fixedProductMarketMaker.totalSupply();
      const removeFundingTx = await fixedProductMarketMaker.removeFunding(
        burnedShares1,
        { from: creator }
      );
      const creatorCollateralBalanceAfter = await collateralToken.balanceOf(
        creator
      );

      expectEvent.inLogs(removeFundingTx.logs, "FPMMFundingRemoved", {
        funder: creator,
        // amountsRemoved,
        sharesBurnt: burnedShares1,
        collateralRemovedFromFeePool: toBN(0),
      });

      creatorCollateralBalanceAfter
        .sub(creatorCollateralBalanceBefore)
        .should.be.a.bignumber.equal(toBN(0));
      (
        await fixedProductMarketMaker.balanceOf(creator)
      ).should.be.a.bignumber.equal(creatorSharesBefore.sub(burnedShares1));

      for (let i = 0; i < positionIds.length; i++) {
        let newMarketMakerBalance = await conditionalTokens.balanceOf(
          fixedProductMarketMaker.address,
          positionIds[i]
        );
        newMarketMakerBalance.should.be.a.bignumber.equal(
          marketMakerPool[i].sub(
            marketMakerPool[i].mul(burnedShares1).div(shareSupplyBefore)
          )
        );

        marketMakerPool[i] = newMarketMakerBalance;
      }
    });

    step("fee setter can withdraw accrued protocol fees", async function () {
      const feeSetterBalanceBefore = await collateralToken.balanceOf(feeSetter);
      await fpmmDeterministicFactory.withdrawProtocolFees(
        [collateralToken.address],
        feeSetter,
        { from: feeSetter }
      );
      const feeSetterBalanceAfter = await collateralToken.balanceOf(feeSetter);

      feeSetterBalanceAfter
        .sub(feeSetterBalanceBefore)
        .should.be.bignumber.equal(totalProtocolFeeAmount);
    });
  }
);
