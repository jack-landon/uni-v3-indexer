import assert from "assert";
import { 
  TestHelpers,
  EventsSummaryEntity,
  UniswapV3Factory_FeeAmountEnabledEntity
} from "generated";
const { MockDb, UniswapV3Factory, Addresses } = TestHelpers;

import { GLOBAL_EVENTS_SUMMARY_KEY } from "../src/EventHandlers";


const MOCK_EVENTS_SUMMARY_ENTITY: EventsSummaryEntity = {
  id: GLOBAL_EVENTS_SUMMARY_KEY,
  uniswapV3Factory_FeeAmountEnabledCount: BigInt(0),
  uniswapV3Factory_OwnerChangedCount: BigInt(0),
  uniswapV3Factory_PoolCreatedCount: BigInt(0),
  uniswapV3Pool_BurnCount: BigInt(0),
  uniswapV3Pool_CollectCount: BigInt(0),
  uniswapV3Pool_CollectProtocolCount: BigInt(0),
  uniswapV3Pool_FlashCount: BigInt(0),
  uniswapV3Pool_IncreaseObservationCardinalityNextCount: BigInt(0),
  uniswapV3Pool_InitializeCount: BigInt(0),
  uniswapV3Pool_MintCount: BigInt(0),
  uniswapV3Pool_SetFeeProtocolCount: BigInt(0),
  uniswapV3Pool_SwapCount: BigInt(0),
};

describe("UniswapV3Factory contract FeeAmountEnabled event tests", () => {
  // Create mock db
  const mockDbInitial = MockDb.createMockDb();

  // Add mock EventsSummaryEntity to mock db
  const mockDbFinal = mockDbInitial.entities.EventsSummary.set(
    MOCK_EVENTS_SUMMARY_ENTITY
  );

  // Creating mock UniswapV3Factory contract FeeAmountEnabled event
  const mockUniswapV3FactoryFeeAmountEnabledEvent = UniswapV3Factory.FeeAmountEnabled.createMockEvent({
    fee: 0n,
    tickSpacing: 0n,
    mockEventData: {
      chainId: 1,
      blockNumber: 0,
      blockTimestamp: 0,
      blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      srcAddress: Addresses.defaultAddress,
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      transactionIndex: 0,
      logIndex: 0,
    },
  });

  // Processing the event
  const mockDbUpdated = UniswapV3Factory.FeeAmountEnabled.processEvent({
    event: mockUniswapV3FactoryFeeAmountEnabledEvent,
    mockDb: mockDbFinal,
  });

  it("UniswapV3Factory_FeeAmountEnabledEntity is created correctly", () => {
    // Getting the actual entity from the mock database
    let actualUniswapV3FactoryFeeAmountEnabledEntity = mockDbUpdated.entities.UniswapV3Factory_FeeAmountEnabled.get(
      mockUniswapV3FactoryFeeAmountEnabledEvent.transactionHash +
        mockUniswapV3FactoryFeeAmountEnabledEvent.logIndex.toString()
    );

    // Creating the expected entity
    const expectedUniswapV3FactoryFeeAmountEnabledEntity: UniswapV3Factory_FeeAmountEnabledEntity = {
      id:
        mockUniswapV3FactoryFeeAmountEnabledEvent.transactionHash +
        mockUniswapV3FactoryFeeAmountEnabledEvent.logIndex.toString(),
      fee: mockUniswapV3FactoryFeeAmountEnabledEvent.params.fee,
      tickSpacing: mockUniswapV3FactoryFeeAmountEnabledEvent.params.tickSpacing,
      eventsSummary: "GlobalEventsSummary",
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualUniswapV3FactoryFeeAmountEnabledEntity, expectedUniswapV3FactoryFeeAmountEnabledEntity, "Actual UniswapV3FactoryFeeAmountEnabledEntity should be the same as the expectedUniswapV3FactoryFeeAmountEnabledEntity");
  });

  it("EventsSummaryEntity is updated correctly", () => {
    // Getting the actual entity from the mock database
    let actualEventsSummaryEntity = mockDbUpdated.entities.EventsSummary.get(
      GLOBAL_EVENTS_SUMMARY_KEY
    );

    // Creating the expected entity
    const expectedEventsSummaryEntity: EventsSummaryEntity = {
      ...MOCK_EVENTS_SUMMARY_ENTITY,
      uniswapV3Factory_FeeAmountEnabledCount: MOCK_EVENTS_SUMMARY_ENTITY.uniswapV3Factory_FeeAmountEnabledCount + BigInt(1),
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualEventsSummaryEntity, expectedEventsSummaryEntity, "Actual UniswapV3FactoryFeeAmountEnabledEntity should be the same as the expectedUniswapV3FactoryFeeAmountEnabledEntity");
  });
});
