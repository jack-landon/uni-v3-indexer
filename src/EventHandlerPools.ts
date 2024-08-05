import {
  BigDecimal,
  Burn,
  Collect,
  Mint,
  Swap,
  Tick,
  Token,
  UniswapV3Pool,
} from "generated";
import {
  BASE_FACTORY_CONTRACT,
  ETH_MAINNET_FACTORY_CONTRACT,
  ETH_MAINNET_ID,
  ONE_BI,
  ZERO_BD,
} from "./utils/constants";
import {
  convertTokenToDecimal,
  getFactoryAddress,
  getAndSetTransaction,
  safeDiv,
} from "./utils";
import {
  findNativePerToken,
  getNativePriceInUSD,
  getTrackedAmountUSD,
  sqrtPriceX96ToTokenPrices,
} from "./utils/pricing";
import { getSubgraphConfig } from "./utils/chains";
import {
  getDayID,
  getHourIndex,
  getHourStartUnix,
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
  updateUniswapDayData,
} from "./utils/intervalUpdates";
import { createTick } from "./utils/tick";

// Burn event handling
UniswapV3Pool.Burn.handlerWithLoader({
  loader: async ({ event, context }) => {
    const factoryAddress = getFactoryAddress(event.chainId);
    const poolAddress = event.srcAddress;
    const lowerTickId = `${poolAddress}#${event.params.tickLower.toString()}`;
    const upperTickId = `${poolAddress}#${event.params.tickUpper.toString()}`;

    let [bundle, pool, factory] = await Promise.all([
      context.Bundle.get(event.chainId.toString()),
      context.Pool.get(poolAddress),
      context.Factory.get(factoryAddress),
    ]);

    if (!bundle || !pool || !factory) {
      throw Error(`Missing data: Bundle, Pool, or Factory not found for chain ${event.chainId}`);
    }

    let [token0, token1, lowerTick, upperTick] = await Promise.all([
      context.Token.get(pool.token0_id),
      context.Token.get(pool.token1_id),
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
    ]);

    return { bundle, pool, factory, token0, token1, lowerTick, upperTick };
  },

  handler: async ({ event, context, loaderReturn }) => {
    let { bundle, pool, factory, token0, token1, lowerTick, upperTick } = loaderReturn;

    if (token0 && token1) {
      const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
      const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
      const amountUSD = amount0
        .times(token0.derivedETH.times(bundle.ethPriceUSD))
        .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

      factory = { ...factory, txCount: factory.txCount + ONE_BI };
      token0 = { ...token0, txCount: token0.txCount + ONE_BI };
      token1 = { ...token1, txCount: token1.txCount + ONE_BI };
      pool = { ...pool, txCount: pool.txCount + ONE_BI };

      if (pool.tick && event.params.tickLower <= pool.tick && event.params.tickUpper > pool.tick) {
        pool = { ...pool, liquidity: pool.liquidity - event.params.amount };
      }

      const transaction = await getAndSetTransaction(event.transaction.hash, event.block.number, event.block.timestamp, context);
      const burn: Burn = {
        id: `${transaction.id}-${event.logIndex.toString()}`,
        transaction_id: transaction.id,
        timestamp: BigInt(transaction.timestamp),
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        owner: event.params.owner,
        origin: event.transaction.from,
        amount: event.params.amount,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountUSD,
        tickLower: event.params.tickLower,
        tickUpper: event.params.tickUpper,
        logIndex: event.logIndex,
      };

      if (lowerTick && upperTick) {
        const amount = event.params.amount;
        lowerTick = { ...lowerTick, liquidityGross: lowerTick.liquidityGross - amount, liquidityNet: lowerTick.liquidityNet - amount };
        upperTick = { ...upperTick, liquidityGross: upperTick.liquidityGross - amount, liquidityNet: upperTick.liquidityNet + amount };

        await context.Tick.set(lowerTick);
        await context.Tick.set(upperTick);
      }

      const dayID = getDayID(event.block.timestamp);

      await Promise.all([
        updateUniswapDayData(dayID, factory, context),
        updatePoolDayData(dayID, pool, context),
        updatePoolHourData(event.block.timestamp, pool, context),
        updateTokenDayData(token0, bundle, dayID, context),
        updateTokenDayData(token1, bundle, dayID, context),
        updateTokenHourData(token0, bundle, event.block.timestamp, context),
        updateTokenHourData(token1, bundle, event.block.timestamp, context),
      ]);

      await context.Token.set(token0);
      await context.Token.set(token1);
      await context.Pool.set(pool);
      await context.Factory.set(factory);
      await context.Burn.set(burn);
    }
  }
});

// Collect event handling
UniswapV3Pool.Collect.handlerWithLoader({
  loader: async ({ event, context }) => {
    const subgraphConfig = getSubgraphConfig(event.chainId);

    let [bundle, pool] = await Promise.all([
      context.Bundle.get(event.chainId.toString()),
      context.Pool.get(event.srcAddress, /* { loadToken0: true, loadToken1: true } */),
    ]);

    if (!bundle || !pool) {
      // return context.log.error(`Missing data: Bundle or Pool not found for chain ${event.chainId}`);
      throw new Error(`Missing data: Bundle or Pool not found for chain ${event.chainId}`);
    }

    const dayID = getDayID(event.block.timestamp);
    const dayPoolID = `${event.srcAddress}-${dayID.toString()}`;
    const hourIndex = getHourIndex(event.block.timestamp);
    const hourPoolID = `${event.srcAddress}-${hourIndex.toString()}`;

    let [token0, token1] = await Promise.all([
      context.Token.get(pool.token0_id),
      context.Token.get(pool.token1_id),
    ]);

    if (!token0 || !token1) {
      throw new Error(`Missing data: Token0 or Token1 not found for chain ${event.chainId} - they should have id ${pool.token0_id} and ${pool.token1_id}`);
    }

    await Promise.all([
      context.UniswapDayData.get(dayID.toString()),
      context.PoolDayData.get(dayPoolID, /* { loadPool: { loadToken0: true, loadToken1: true } } */),
      context.PoolHourData.get(hourPoolID, /* { loadPool: { loadToken0: true, loadToken1: true } } */),
    ]);

    const factoryAddress = getFactoryAddress(event.chainId);
    let factory = await context.Factory.get(factoryAddress);
    if (!factory) {
      // return context.log.error(`Factory not found for chain ${event.chainId}`);
      throw new Error(`Factory not found for chain ${event.chainId}`);
    }

    return {
      bundle, pool, subgraphConfig, factory, token0, token1
    };
  },

  handler: async ({ event, context, loaderReturn }) => {
    if (!loaderReturn) return;
    let { bundle, pool, subgraphConfig, factory, token0, token1 } = loaderReturn;
    const whitelistTokens = subgraphConfig.whitelistTokens;

    const transaction = await getAndSetTransaction(event.transaction.hash, event.block.number, event.block.timestamp, context);

    const collectedAmountToken0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    const collectedAmountToken1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
    const trackedCollectedAmountUSD = getTrackedAmountUSD(
      collectedAmountToken0,
      token0,
      collectedAmountToken1,
      token1,
      whitelistTokens,
      bundle
    );

    factory = {
      ...factory,
      totalValueLockedETH: factory.totalValueLockedETH.minus(pool.totalValueLockedETH),
      txCount: factory.txCount + ONE_BI,
    };

    token0 = {
      ...token0,
      txCount: token0.txCount + ONE_BI,
      totalValueLocked: token0.totalValueLocked.minus(collectedAmountToken0),
      totalValueLockedUSD: token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD)),
    };

    token1 = {
      ...token1,
      txCount: token1.txCount + ONE_BI,
      totalValueLocked: token1.totalValueLocked.minus(collectedAmountToken1),
      totalValueLockedUSD: token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD)),
    };

    pool = {
      ...pool,
      txCount: pool.txCount + ONE_BI,
      totalValueLockedToken0: pool.totalValueLockedToken0.minus(collectedAmountToken0),
      totalValueLockedToken1: pool.totalValueLockedToken1.minus(collectedAmountToken1),
      totalValueLockedETH: pool.totalValueLockedToken0.times(token0.derivedETH).plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
      totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
      collectedFeesToken0: pool.collectedFeesToken0.plus(collectedAmountToken0),
      collectedFeesToken1: pool.collectedFeesToken1.plus(collectedAmountToken1),
      collectedFeesUSD: pool.collectedFeesUSD.plus(trackedCollectedAmountUSD),
    };

    factory = {
      ...factory,
      totalValueLockedETH: factory.totalValueLockedETH.plus(pool.totalValueLockedETH),
      totalValueLockedUSD: factory.totalValueLockedETH.times(bundle.ethPriceUSD),
    };

    const collect: Collect = {
      id: `${transaction.id}-${event.logIndex.toString()}`,
      transaction_id: transaction.id,
      timestamp: BigInt(event.block.timestamp),
      pool_id: pool.id,
      owner: event.params.owner,
      amount0: collectedAmountToken0,
      amount1: collectedAmountToken1,
      amountUSD: trackedCollectedAmountUSD,
      tickLower: event.params.tickLower,
      tickUpper: event.params.tickUpper,
      logIndex: event.logIndex,
    };

    const dayID = getDayID(event.block.timestamp);

    await Promise.all([
      updateUniswapDayData(dayID, factory, context),
      updatePoolDayData(dayID, pool, context),
      updatePoolHourData(event.block.timestamp, pool, context),
      updateTokenDayData(token0, bundle, dayID, context),
      updateTokenDayData(token1, bundle, dayID, context),
      updateTokenHourData(token0, bundle, event.block.timestamp, context),
      updateTokenHourData(token1, bundle, event.block.timestamp, context),
    ]);

    await context.Token.set(token0);
    await context.Token.set(token1);
    await context.Factory.set(factory);
    await context.Pool.set(pool);
    await context.Collect.set(collect);
  }
});

// Initialize event handling
UniswapV3Pool.Initialize.handlerWithLoader({
  loader: async ({ event, context }) => {
    const subgraphConfig = getSubgraphConfig(event.chainId);

    // await context.Pool.get(event.srcAddress/* , { loadToken0: true, loadToken1: true } */);
    // await context.Bundle.get(event.chainId.toString());
    // await context.Pool.get(subgraphConfig.stablecoinWrappedNativePoolAddress/* , { loadToken0: true, loadToken1: true } */);

    const dayID = getDayID(event.block.timestamp);
    const dayPoolID = `${event.srcAddress}-${dayID.toString()}`;
    await context.PoolDayData.get(dayPoolID/* , { loadPool: { loadToken0: true, loadToken1: true } } */);

    let [bundle, pool, stablecoinWrappedNativePool] = await Promise.all([
      context.Bundle.get(event.chainId.toString()),
      context.Pool.get(event.srcAddress),
      context.Pool.get(subgraphConfig.stablecoinWrappedNativePoolAddress),
    ]);

    if (!pool || !bundle) {
      // return context.log.error(`Missing data: Pool or Bundle not found for chain ${event.chainId}`);
      throw new Error(`Missing data: Pool or Bundle not found for chain ${event.chainId}`);
    }

    let [token0, token1] = await Promise.all([
      context.Token.get(pool.token0_id),
      context.Token.get(pool.token1_id)
    ])

    return { bundle, pool, stablecoinWrappedNativePool, token0, token1 }
  },

  handler: async ({ event, context, loaderReturn }) => {
    let { bundle, pool, stablecoinWrappedNativePool, token0, token1 } = loaderReturn;

    const subgraphConfig = getSubgraphConfig(event.chainId);

    const stablecoinWrappedNativePoolAddress = subgraphConfig.stablecoinWrappedNativePoolAddress;
    const stablecoinIsToken0 = subgraphConfig.stablecoinIsToken0;
    const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress;
    const stablecoinAddresses = subgraphConfig.stablecoinAddresses;
    const minimumNativeLocked = subgraphConfig.minimumNativeLocked;

    pool = {
      ...pool,
      sqrtPrice: event.params.sqrtPriceX96,
      tick: event.params.tick,
    };

    await context.Pool.set(pool);

    bundle = {
      ...bundle,
      ethPriceUSD: getNativePriceInUSD(stablecoinIsToken0, stablecoinWrappedNativePool),
    };

    await context.Bundle.set(bundle);

    const dayID = getDayID(event.block.timestamp);

    await Promise.all([
      context.Token.get(pool.token0_id),
      context.Token.get(pool.token1_id),
      updatePoolDayData(dayID, pool, context),
      updatePoolHourData(event.block.timestamp, pool, context),
    ]);

    if (token0 && token1) {
      const [token0DerivedEth, token1DerivedEth] = await Promise.all([
        findNativePerToken(token0, wrappedNativeAddress, stablecoinAddresses, minimumNativeLocked, bundle, context),
        findNativePerToken(token1, wrappedNativeAddress, stablecoinAddresses, minimumNativeLocked, bundle, context),
      ]);

      token0 = { ...token0, derivedETH: token0DerivedEth };
      token1 = { ...token1, derivedETH: token1DerivedEth };

      await context.Token.set(token0);
      await context.Token.set(token1);
    }
  }
});

// Mint event handling
UniswapV3Pool.Mint.handlerWithLoader({
  loader: async ({ event, context }) => {
    const factoryAddress = getFactoryAddress(event.chainId);

    let [bundle, pool, factory] = await Promise.all([
      context.Bundle.get(event.chainId.toString()),
      context.Pool.get(event.srcAddress),
      context.Factory.get(factoryAddress),
    ]);

    if (!bundle || !pool || !factory) {
      // return context.log.error(`Missing data: Bundle, Pool, or Factory not found for chain ${event.chainId}`);
      throw new Error(`Missing data: Bundle, Pool, or Factory not found for chain ${event.chainId}`);
    }

    // await context.Bundle.get(event.chainId.toString());
    // await context.Factory.get(getFactoryAddress(event.chainId));
    // await context.Pool.get(event.srcAddress/* , { loadToken0: true, loadToken1: true } */);


    // const lowerTickId = `${event.srcAddress}#${event.params.tickLower.toString()}`;
    // const upperTickId = `${event.srcAddress}#${event.params.tickUpper.toString()}`;

    // let lowerTick = await context.Tick.get(lowerTickId/* , { loadPool: { loadToken0: true, loadToken1: true } } */);
    // let upperTick = await context.Tick.get(upperTickId/* , { loadPool: { loadToken0: true, loadToken1: true } } */);


    const lowerTickId = `${event.srcAddress}#${event.params.tickLower.toString()}`;
    const upperTickId = `${event.srcAddress}#${event.params.tickUpper.toString()}`;

    let [token0, token1, lowerTick, upperTick] = await Promise.all([
      context.Token.get(pool.token0_id) as Promise<Token>,
      context.Token.get(pool.token1_id) as Promise<Token>,
      context.Tick.get(lowerTickId) as Promise<Tick>,
      context.Tick.get(upperTickId) as Promise<Tick>,
    ]);

    const dayID = getDayID(event.block.timestamp);
    await context.UniswapDayData.get(dayID.toString());

    const dayPoolID = `${event.srcAddress}-${dayID.toString()}`;
    await context.PoolDayData.get(dayPoolID/* , { loadPool: { loadToken0: true, loadToken1: true } } */);

    const hourIndex = getHourIndex(event.block.timestamp);
    const hourPoolID = `${event.srcAddress}-${hourIndex.toString()}`;
    await context.PoolHourData.get(hourPoolID/* , { loadPool: { loadToken0: true, loadToken1: true } } */);

    await context.Transaction.get(event.transaction.hash);

    return { bundle, pool, factory, token0, token1, lowerTick, upperTick }
  },

  handler: async ({ event, context, loaderReturn }) => {
    let { bundle, factory, pool, token0, token1, lowerTick, upperTick } = loaderReturn;

    let transaction = await getAndSetTransaction(event.transaction.hash, event.block.number, event.block.timestamp, context)

    if (token0 && token1) {
      const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
      const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
      const amountUSD = amount0.times(token0.derivedETH.times(bundle.ethPriceUSD)).plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

      factory = {
        ...factory,
        totalValueLockedETH: factory.totalValueLockedETH.minus(pool.totalValueLockedETH),
        txCount: factory.txCount + ONE_BI,
      };

      token0 = {
        ...token0,
        txCount: token0.txCount + ONE_BI,
        totalValueLocked: token0.totalValueLocked.plus(amount0),
        totalValueLockedUSD: token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD)),
      };

      token1 = {
        ...token1,
        txCount: token1.txCount + ONE_BI,
        totalValueLocked: token1.totalValueLocked.plus(amount1),
        totalValueLockedUSD: token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD)),
      };

      pool = { ...pool, txCount: pool.txCount + ONE_BI };

      if (pool.tick && event.params.tickLower <= pool.tick && event.params.tickUpper > pool.tick) {
        pool = { ...pool, liquidity: pool.liquidity + event.params.amount };
      }

      pool = {
        ...pool,
        totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
        totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
        totalValueLockedETH: pool.totalValueLockedToken0.times(token0.derivedETH).plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
        totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
      };

      factory = { ...factory, totalValueLockedETH: factory.totalValueLockedETH.plus(pool.totalValueLockedETH) };
      factory = { ...factory, totalValueLockedUSD: factory.totalValueLockedETH.times(bundle.ethPriceUSD) };

      const mint: Mint = {
        id: `${transaction.id}-${event.logIndex.toString()}`,
        transaction_id: transaction.id,
        timestamp: BigInt(transaction.timestamp),
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        owner: event.params.owner,
        sender: event.params.sender,
        origin: event.transaction.from,
        amount: event.params.amount,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountUSD,
        tickLower: event.params.tickLower,
        tickUpper: event.params.tickUpper,
        logIndex: event.logIndex,
      };

      if (!lowerTick) {
        lowerTick = createTick(`${event.srcAddress}#${event.params.tickLower.toString()}`, event.params.tickLower, pool.id, event.block.timestamp, event.block.number);
      }

      if (!upperTick) {
        upperTick = createTick(`${event.srcAddress}#${event.params.tickUpper.toString()}`, event.params.tickUpper, pool.id, event.block.timestamp, event.block.number);
      }

      const amount = event.params.amount;
      lowerTick = { ...lowerTick, liquidityGross: lowerTick.liquidityGross + amount, liquidityNet: lowerTick.liquidityNet + amount };
      upperTick = { ...upperTick, liquidityGross: upperTick.liquidityGross + amount, liquidityNet: upperTick.liquidityNet - amount };

      await context.Tick.set(lowerTick);
      await context.Tick.set(upperTick);

      const dayID = getDayID(event.block.timestamp);

      await Promise.all([
        updateUniswapDayData(dayID, factory, context),
        updatePoolDayData(dayID, pool, context),
        updatePoolHourData(event.block.timestamp, pool, context),
        updateTokenDayData(token0, bundle, dayID, context),
        updateTokenDayData(token1, bundle, dayID, context),
        updateTokenHourData(token0, bundle, event.block.timestamp, context),
        updateTokenHourData(token1, bundle, event.block.timestamp, context),
      ]);

      await context.Token.set(token0);
      await context.Token.set(token1);
      await context.Pool.set(pool);
      await context.Factory.set(factory);
      await context.Mint.set(mint);
    }
  }
});

// Swap event handling
UniswapV3Pool.Swap.handlerWithLoader({
  loader: async ({ event, context }) => {
    // This loader can be cleaned up a bit more
    const subgraphConfig = getSubgraphConfig(event.chainId);
    const factoryAddress = getFactoryAddress(event.chainId);


    const stablecoinWrappedNativePool = await context.Pool.get(subgraphConfig.stablecoinWrappedNativePoolAddress/* , { loadToken0: true, loadToken1: true } */);

    const [bundle, pool, factory] = await Promise.all([
      context.Bundle.get(event.chainId.toString()),
      context.Pool.get(event.srcAddress),
      context.Factory.get(factoryAddress),
    ]);

    if (!bundle || !pool || !factory) {
      // return context.log.error(`Missing data: Bundle, Pool, or Factory not found for chain ${event.chainId}`);
      throw new Error(`Missing data: Bundle, Pool, or Factory not found for chain ${event.chainId}`);
    }

    let [token0, token1] = await Promise.all([
      context.Token.get(pool.token0_id),
      context.Token.get(pool.token1_id),
    ]);

    const dayID = getDayID(event.block.timestamp);
    await context.UniswapDayData.get(dayID.toString());

    const dayPoolID = `${event.srcAddress}-${dayID.toString()}`;
    await context.PoolDayData.get(dayPoolID/* , { loadPool: { loadToken0: true, loadToken1: true } } */);

    const hourIndex = getHourIndex(event.block.timestamp);
    const hourPoolID = `${event.srcAddress}-${hourIndex.toString()}`;
    await context.PoolHourData.get(hourPoolID/* , { loadPool: { loadToken0: true, loadToken1: true } } */);

    return { pool, token0, token1, bundle, factory, stablecoinWrappedNativePool }
  },

  handler: async ({ event, context, loaderReturn }) => {
    let { pool, token0, token1, bundle, factory, stablecoinWrappedNativePool } = loaderReturn;
    const subgraphConfig = getSubgraphConfig(event.chainId);

    const stablecoinWrappedNativePoolAddress = subgraphConfig.stablecoinWrappedNativePoolAddress;
    const stablecoinIsToken0 = subgraphConfig.stablecoinIsToken0;
    const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress;
    const stablecoinAddresses = subgraphConfig.stablecoinAddresses;
    const minimumNativeLocked = subgraphConfig.minimumNativeLocked;
    const whitelistTokens = subgraphConfig.whitelistTokens;

    if (pool.id == "0x9663f2ca0454accad3e094448ea6f77443880454") {
      return;
    }

    if (token0 && token1) {
      const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
      const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

      let amount0Abs = amount0;
      if (amount0.lt(ZERO_BD)) {
        amount0Abs = amount0.times(BigDecimal("-1"));
      }
      let amount1Abs = amount1;
      if (amount1.lt(ZERO_BD)) {
        amount1Abs = amount1.times(BigDecimal("-1"));
      }

      const amount0ETH = amount0Abs.times(token0.derivedETH);
      const amount1ETH = amount1Abs.times(token1.derivedETH);
      const amount0USD = amount0ETH.times(bundle.ethPriceUSD);
      const amount1USD = amount1ETH.times(bundle.ethPriceUSD);

      const amountTotalUSDTracked = getTrackedAmountUSD(
        amount0Abs,
        token0,
        amount1Abs,
        token1,
        whitelistTokens,
        bundle
      ).div(BigDecimal("2"));
      const amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD);
      const amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal("2"));

      const feesETH = amountTotalETHTracked
        .times(BigDecimal(pool.feeTier.toString()))
        .div(BigDecimal("1000000"));
      const feesUSD = amountTotalUSDTracked
        .times(BigDecimal(pool.feeTier.toString()))
        .div(BigDecimal("1000000"));

      const currentPoolTvlETH = pool.totalValueLockedETH;

      factory = {
        ...factory,
        txCount: factory.txCount + ONE_BI,
        totalVolumeETH: factory.totalVolumeETH.plus(amountTotalETHTracked),
        totalVolumeUSD: factory.totalVolumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: factory.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        totalFeesETH: factory.totalFeesETH.plus(feesETH),
        totalFeesUSD: factory.totalFeesUSD.plus(feesUSD),
        totalValueLockedETH: factory.totalValueLockedETH.minus(currentPoolTvlETH),
      };

      pool = {
        ...pool,
        txCount: pool.txCount + ONE_BI,
        volumeToken0: pool.volumeToken0.plus(amount0Abs),
        volumeToken1: pool.volumeToken1.plus(amount1Abs),
        volumeUSD: pool.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: pool.feesUSD.plus(feesUSD),
        liquidity: event.params.liquidity,
        tick: event.params.tick,
        sqrtPrice: event.params.sqrtPriceX96,
        totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
        totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
      };

      token0 = {
        ...token0,
        volume: token0.volume.plus(amount0Abs),
        totalValueLocked: token0.totalValueLocked.plus(amount0),
        volumeUSD: token0.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token0.feesUSD.plus(feesUSD),
        txCount: token0.txCount + ONE_BI,
      };

      token1 = {
        ...token1,
        volume: token1.volume.plus(amount1Abs),
        totalValueLocked: token1.totalValueLocked.plus(amount1),
        volumeUSD: token1.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token1.feesUSD.plus(feesUSD),
        txCount: token1.txCount + ONE_BI,
      };

      const prices = sqrtPriceX96ToTokenPrices(pool.sqrtPrice, token0, token1);
      pool = { ...pool, token0Price: prices[0], token1Price: prices[1] };

      await context.Pool.set(pool);

      bundle = { ...bundle, ethPriceUSD: getNativePriceInUSD(stablecoinIsToken0, stablecoinWrappedNativePool) };

      await context.Bundle.set(bundle);

      const [token0DerivedEth, token1DerivedEth, transaction] = await Promise.all([
        findNativePerToken(token0, wrappedNativeAddress, stablecoinAddresses, minimumNativeLocked, bundle, context),
        findNativePerToken(token1, wrappedNativeAddress, stablecoinAddresses, minimumNativeLocked, bundle, context),
        getAndSetTransaction(event.transaction.hash, event.block.number, event.block.timestamp, context),
      ]);

      token0 = { ...token0, derivedETH: token0DerivedEth };
      token1 = { ...token1, derivedETH: token1DerivedEth };

      pool = {
        ...pool,
        totalValueLockedETH: pool.totalValueLockedToken0.times(token0.derivedETH).plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
        totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
      };

      factory = { ...factory, totalValueLockedETH: factory.totalValueLockedETH.plus(pool.totalValueLockedETH) };
      factory = { ...factory, totalValueLockedUSD: factory.totalValueLockedETH.times(bundle.ethPriceUSD) };

      token0 = {
        ...token0,
        totalValueLockedUSD: token0.totalValueLocked.times(token0.derivedETH).times(bundle.ethPriceUSD),
      };

      token1 = {
        ...token1,
        totalValueLockedUSD: token1.totalValueLocked.times(token1.derivedETH).times(bundle.ethPriceUSD),
      };

      const swap: Swap = {
        id: `${transaction.id}-${event.logIndex.toString()}`,
        transaction_id: transaction.id,
        timestamp: BigInt(transaction.timestamp),
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        sender: event.params.sender,
        origin: event.transaction.from,
        recipient: event.params.recipient,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountTotalUSDTracked,
        tick: event.params.tick,
        sqrtPriceX96: event.params.sqrtPriceX96,
        logIndex: event.logIndex,
      };

      const dayID = getDayID(event.block.timestamp);

      let [
        uniswapDayData,
        poolDayData,
        poolHourData,
        token0DayData,
        token1DayData,
        token0HourData,
        token1HourData,
      ] = await Promise.all([
        updateUniswapDayData(dayID, factory, context),
        updatePoolDayData(dayID, pool, context),
        updatePoolHourData(event.block.timestamp, pool, context),
        updateTokenDayData(token0, bundle, dayID, context),
        updateTokenDayData(token1, bundle, dayID, context),
        updateTokenHourData(token0, bundle, event.block.timestamp, context),
        updateTokenHourData(token1, bundle, event.block.timestamp, context),
      ]);

      uniswapDayData = {
        ...uniswapDayData,
        volumeETH: uniswapDayData.volumeETH.plus(amountTotalETHTracked),
        volumeUSD: uniswapDayData.volumeUSD.plus(amountTotalUSDTracked),
        feesUSD: uniswapDayData.feesUSD.plus(feesUSD),
      };

      poolDayData = {
        ...poolDayData,
        volumeUSD: poolDayData.volumeUSD.plus(amountTotalUSDTracked),
        volumeToken0: poolDayData.volumeToken0.plus(amount0Abs),
        volumeToken1: poolDayData.volumeToken1.plus(amount1Abs),
        feesUSD: poolDayData.feesUSD.plus(feesUSD),
      };

      poolHourData = {
        ...poolHourData,
        volumeUSD: poolHourData.volumeUSD.plus(amountTotalUSDTracked),
        volumeToken0: poolHourData.volumeToken0.plus(amount0Abs),
        volumeToken1: poolHourData.volumeToken1.plus(amount1Abs),
        feesUSD: poolHourData.feesUSD.plus(feesUSD),
      };

      token0DayData = {
        ...token0DayData,
        volume: token0DayData.volume.plus(amount0Abs),
        volumeUSD: token0DayData.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token0DayData.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token0DayData.feesUSD.plus(feesUSD),
      };

      token0HourData = {
        ...token0HourData,
        volume: token0HourData.volume.plus(amount0Abs),
        volumeUSD: token0HourData.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token0HourData.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token0HourData.feesUSD.plus(feesUSD),
      };

      token1DayData = {
        ...token1DayData,
        volume: token1DayData.volume.plus(amount1Abs),
        volumeUSD: token1DayData.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token1DayData.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token1DayData.feesUSD.plus(feesUSD),
      };

      token1HourData = {
        ...token1HourData,
        volume: token1HourData.volume.plus(amount1Abs),
        volumeUSD: token1HourData.volumeUSD.plus(amountTotalUSDTracked),
        untrackedVolumeUSD: token1HourData.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
        feesUSD: token1HourData.feesUSD.plus(feesUSD),
      };

      await context.Swap.set(swap);
      await context.TokenDayData.set(token0DayData);
      await context.TokenDayData.set(token1DayData);
      await context.UniswapDayData.set(uniswapDayData);
      await context.PoolDayData.set(poolDayData);
      await context.PoolHourData.set(poolHourData);
      await context.TokenHourData.set(token0HourData);
      await context.TokenHourData.set(token1HourData);
      await context.PoolHourData.set(poolHourData);
      await context.Factory.set(factory);
      await context.Pool.set(pool);
      await context.Token.set(token0);
      await context.Token.set(token1);
    }
  }
});

