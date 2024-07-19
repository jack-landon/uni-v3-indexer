import { PoolEntity, UniswapV3FactoryContract } from "generated";
import { getSubgraphConfig, SubgraphConfig } from "./utils/chains";
import {
  fetchTokenDecimals,
  fetchTokenName,
  fetchTokenSymbol,
  fetchTokenTotalSupply,
} from "./utils/token";
import {
  ADDRESS_ZERO,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
  BASE_FACTORY_CONTRACT,
  BASE_MAINNET_ID,
  ETH_MAINNET_FACTORY_CONTRACT,
  ETH_MAINNET_ID,
  poolsToSkip,
} from "./utils/constants";
import type { publicClients } from "./utils/viem";

// const poolsToWatch = [
//   "0x9fee7385a2979D15277C3467Db7D99EF1A2669D7", // tbtc/WETH 0.3
//   "0xecA826E450a8AC6Cf9Ab228AE12B84D0407212a7", // tbtc/USDC 0.3
//   "0xbD268aC461969eb956707Fb35cE486f1A89c9167", // SKR/WETH 0.3
//   "0xd0b53D9277642d899DF5C87A3966A349A798F224", // WETH/USDC 0.05
//   "0x455fd3AE52a8AB80f319a1bF912457AA8296695a", // IHF/WETH 1%
//   "0xe9Ed60539a8eA7A4dA04eBFa524e631B1Fd48525", // WETH/SKOP 1%
// ];

UniswapV3FactoryContract.PoolCreated.loader(({ event, context }) => {
  // if (event.chainId == ETH_MAINNET_ID) {
  //   context.Factory.load(ETH_MAINNET_FACTORY_CONTRACT);
  // } else if (event.chainId == BASE_MAINNET_ID) {
  //   context.Factory.load(BASE_FACTORY_CONTRACT);
  // }
  context.contractRegistration.addUniswapV3Pool(event.params.pool);
});

UniswapV3FactoryContract.PoolCreated.handlerAsync(
  async ({ event, context }) => {
    const subgraphConfig = getSubgraphConfig(event.chainId);
    const whitelistTokens = subgraphConfig.whitelistTokens;
    const tokenOverrides = subgraphConfig.tokenOverrides;
    context.log.info(
      `This is the Token Overrides: ${tokenOverrides.map(
        (override) => `${override.address} - ${override.symbol}`
      )}`
    );
    const poolMappings = subgraphConfig.poolMappings;

    // temp fix
    if (poolsToSkip.includes(event.params.pool)) return;

    // load factory
    let factory = await context.Factory.get(event.srcAddress);

    if (!factory) {
      context.log.info(`Creating Factory`);

      factory = {
        id: event.srcAddress,
        poolCount: ZERO_BI,
        totalVolumeETH: ZERO_BD,
        totalVolumeUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        totalFeesUSD: ZERO_BD,
        totalFeesETH: ZERO_BD,
        totalValueLockedETH: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
        totalValueLockedUSDUntracked: ZERO_BD,
        totalValueLockedETHUntracked: ZERO_BD,
        txCount: ZERO_BI,
        owner: ADDRESS_ZERO,
      };

      // create new bundle for tracking eth price
      context.Bundle.set({
        id: event.chainId.toString(),
        ethPriceUSD: ZERO_BD,
      });

      // if (poolMappings.length > 0) {
      //   await populateEmptyPools(
      //     event.blockNumber,
      //     event.blockTimestamp,
      //     poolMappings,
      //     whitelistTokens,
      //     tokenOverrides,
      //     context,
      //     event.chainId as keyof typeof publicClients
      //   ); // Do this if you need to backfill - This is used for generating optimism pre-regenesis data.
      // }
    }

    factory = {
      ...factory,
      poolCount: factory.poolCount + ONE_BI,
    };

    let pool: PoolEntity = {
      id: event.params.pool,
      token0_id: event.params.token0,
      token1_id: event.params.token1,
      feeTier: BigInt(event.params.fee),
      createdAtTimestamp: event.blockTimestamp,
      createdAtBlockNumber: event.blockNumber,
      liquidityProviderCount: ZERO_BI,
      txCount: ZERO_BI,
      liquidity: ZERO_BI,
      sqrtPrice: ZERO_BI,
      token0Price: ZERO_BD,
      token1Price: ZERO_BD,
      observationIndex: ZERO_BI,
      totalValueLockedToken0: ZERO_BD,
      totalValueLockedToken1: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedETH: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      collectedFeesToken0: ZERO_BD,
      collectedFeesToken1: ZERO_BD,
      collectedFeesUSD: ZERO_BD,
      tick: undefined,
    };

    let [token0, token1] = await Promise.all([
      context.Token.get(event.params.token0),
      context.Token.get(event.params.token1),
    ]);

    // fetch info if null
    if (!token0) {
      const [decimals, symbol, name, totalSupply] = await Promise.all([
        fetchTokenDecimals(
          event.params.token0,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenSymbol(
          event.params.token0,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenName(
          event.params.token0,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenTotalSupply(
          event.params.token0,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
      ]);

      // bail if we couldn't figure out the decimals
      if (!decimals) {
        context.log.debug("No Decimal for token0");
        return;
      }

      token0 = {
        id: event.params.token0,
        symbol,
        name,
        totalSupply,
        decimals,
        derivedETH: ZERO_BD,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
        totalValueLockedUSDUntracked: ZERO_BD,
        txCount: ZERO_BI,
        poolCount: ZERO_BI,
        whitelistPools: [],
      };
    }

    if (!token1) {
      const [decimals, symbol, name, totalSupply] = await Promise.all([
        fetchTokenDecimals(
          event.params.token1,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenSymbol(
          event.params.token1,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenName(
          event.params.token1,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
        fetchTokenTotalSupply(
          event.params.token1,
          tokenOverrides,
          event.chainId as keyof typeof publicClients
        ),
      ]);

      // bail if we couldn't figure out the decimals
      if (!decimals) {
        context.log.debug("No Decimal for token1");
        return;
      }

      token1 = {
        id: event.params.token1,
        symbol,
        name,
        totalSupply,
        decimals,
        derivedETH: ZERO_BD,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
        totalValueLockedUSDUntracked: ZERO_BD,
        txCount: ZERO_BI,
        poolCount: ZERO_BI,
        whitelistPools: [],
      };
    }

    // update white listed pools
    if (whitelistTokens.includes(token0.id)) {
      const newPools = token1.whitelistPools;
      newPools.push(pool.id);
      token1 = {
        ...token1,
        whitelistPools: newPools,
      };
    }
    if (whitelistTokens.includes(token1.id)) {
      const newPools = token0.whitelistPools;
      newPools.push(pool.id);
      token0 = {
        ...token0,
        whitelistPools: newPools,
      };
    }

    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
    context.Factory.set(factory);

    //   DOUBLE CHECK THIS
    // create the tracked contract based on the template
    // PoolTemplate.create(event.params.pool);
  }
);
