import { JsonRpcError, SuiClient, SuiTransactionBlockResponse } from "@mysten/sui.js/client"
import { Keypair } from "@mysten/sui.js/dist/cjs/cryptography/keypair"
import { TransactionBlock } from "@mysten/sui.js/transactions"

import { setTimeout } from "timers/promises"
import { DataSource } from "./data_sources/data_source"
import { SuiNetworks, getFullnodeUrl } from "./networks"
import { CetusPool } from "./dexs/cetus/cetus"
import { CetusParams, RAMMSuiParams } from "./dexs/dexsParams"
import { Pool } from "./dexs/pool"
import { logger } from "./logger"
import { Strategy } from "./strategies/strategy"
import { RAMMPool } from "./dexs/ramm-sui/ramm-sui"
import {
    RAMMSuiPool,
    TradeEvent,
    processImbRatioEvent,
    processPoolStateEvent,
} from "@ramm/ramm-sui-sdk"

// Default gas budget: 0.1 `SUI`
const DEFAULT_GAS_BUDGET: number = 0.1 * 10 ** 9

/**
 * A simple trading bot which subscribes to a number of trading pools across different DEXs. The bot may use multiple
 * strategies to trade on these pools.
 */
export class Capybot {
    public dataSources: Record<string, DataSource> = {}
    /**
     * A record of all the pools the bot is subscribed to.
     *
     * The key is the UUID (a.k.a. URI) of the pool, and the value is the pool object.
     */
    public pools: Record<string, Pool<CetusParams | RAMMSuiParams>> = {}
    /**
     * A record of the keypairs each pool uses to sign its transactions.
     *
     * The key is the UUID of the pool, and the value is the keypair object.
     */
    public poolKeypairs: Record<string, Keypair> = {}

    /**
     * A record of all the RAMM pools the bot is subscribed to.
     * Each pool, regardless of how many trading pairs or strategies it is a part of, is represented by a single
     * entry here.
     *
     * The key is the Sui address of the pool.
     */
    public rammPools: Record<string, RAMMPool> = {}
    /**
     * Data about the volume of each of the bot's RAMM pools.
     *
     * Nested record:
     * * the outer key is the Sui address of the pool, and a record of its assets and their volumes
     * * the inner key is the asset ticker, and the value is that asset's volume since the bot
     *   began operating
     */
    public rammPoolsVolume: Record<string, Record<string, number>> = {}

    public strategies: Record<string, Array<Strategy>> = {}
    private suiClient: SuiClient
    private network: SuiNetworks

    constructor(network: SuiNetworks) {
        this.network = network
        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
    }

    /**
     * The main loop of the bot.
     *
     * It will run for `duration` milliseconds, with at least `delay` milliseconds between each
     * iteration.
     *
     * @param duration How long the bot should run for, in milliseconds.
     * @param delay The (minimum) delay between each iteration of the bot, in milliseconds.
     */
    async innerLoop(duration: number, delay: number) {
        const startTime = new Date().getTime()

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uniqueStrategies: Record<string, any> = {}
        for (const pool in this.strategies) {
            for (const strategy of this.strategies[pool]) {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        uniqueStrategies,
                        strategy.uri
                    )
                ) {
                    uniqueStrategies[strategy.uri] = strategy["parameters"]
                }
            }
        }
        logger.info({ strategies: uniqueStrategies }, "strategies")

        let transactionBlock: TransactionBlock = new TransactionBlock()
        mainloop: while (new Date().getTime() - startTime < duration) {
            for (const uri in this.dataSources) {
                const dataSource = this.dataSources[uri]
                const data = await dataSource.getData()

                if (!data) {
                    console.error(
                        "No data received from data source " +
                            dataSource.uri +
                            "; skipping round."
                    )
                    continue mainloop
                }

                logger.info(
                    {
                        price: data,
                    },
                    "price"
                )

                // Push new data to all strategies subscribed to this data source
                for (const strategy of this.strategies[uri]) {
                    // Get orders for this strategy.
                    const tradeOrders = strategy.evaluate(data)

                    // Create transactions for the suggested trades
                    for (const order of tradeOrders) {
                        logger.info(
                            { strategy: strategy.uri, decision: order },
                            "order"
                        )

                        const amountIn = Math.round(order.amountIn)
                        const amountOut = Math.round(
                            order.estimatedPrice * amountIn
                        )
                        const a2b: boolean = order.a2b
                        const byAmountIn: boolean = true
                        const slippage: number = 1 // TODO: Define this in a meaningful way. Perhaps by the strategies.

                        const orderPool = this.pools[order.poolUuid]

                        if (orderPool instanceof CetusPool) {
                            // reset the txb - one txb per pool
                            transactionBlock = new TransactionBlock()
                            transactionBlock = await this.pools[
                                order.poolUuid
                            ].createSwapTransaction(transactionBlock, {
                                a2b,
                                amountIn,
                                amountOut,
                                byAmountIn,
                                slippage,
                            })

                            // Execute the transaction
                            await this.executeTransactionBlock(
                                transactionBlock,
                                this.poolKeypairs[order.poolUuid],
                                strategy
                            )
                        } else if (orderPool instanceof RAMMPool) {
                            transactionBlock = new TransactionBlock()
                            transactionBlock = await this.pools[
                                order.poolUuid
                            ].createSwapTransaction(transactionBlock, {
                                a2b,
                                amountIn,
                            })

                            const rammTxResponse =
                                await this.executeTransactionBlock(
                                    transactionBlock,
                                    this.poolKeypairs[order.poolUuid],
                                    strategy,
                                    /* showEvents = */ true
                                )

                            if (rammTxResponse) {
                                const ramm = (
                                    this.rammPools[
                                        orderPool.rammSuiPool.poolAddress
                                    ] as RAMMPool
                                ).rammSuiPool

                                // Update the volume of each of the bot's RAMM pools with the data
                                // from the above trade.
                                this.updateRAMMPoolVolumes(rammTxResponse, ramm)
                            }
                        }
                    }
                }
            }

            /**
             * RAMM specific - log TVL, volume and imbalance ratios
             */
            this.logRAMMTVLAndImbRations()
            this.logRAMMVolumes()
            /**
             *
             */

            await setTimeout(delay)
        }
    }

    /**
     * Given the SDK representation of a RAMM, and a trade's tx response, update the bot's record
     * of the RAMM's pool volumes.
     *
     * @param rammTxResponse Response from executing the trade against the RAMM.
     * @param ramm The SDK representation of the RAMM pool that was traded against.
     */
    private async updateRAMMPoolVolumes(
        rammTxResponse: SuiTransactionBlockResponse,
        ramm: RAMMSuiPool
    ) {
        if (
            rammTxResponse &&
            rammTxResponse.errors === undefined &&
            rammTxResponse.events
        ) {
            // A tx with a single RAMM trade will emit exactly one event of this type.
            const tradeEvent = rammTxResponse.events.filter((event) =>
                event.type.split("::")[2].startsWith("TradeEvent")
            )[0]
            if (tradeEvent === undefined) {
                throw new Error("No TradeEvent found in the response")
            }

            const tradeEventParsedJSON = tradeEvent.parsedJson as TradeEvent
            const assetInIndex = ramm.assetTypeIndices.get(
                // Type names in Sui Move events are missing the leading '0x'
                "0x" + tradeEventParsedJSON.token_in.name
            )
            const assetIn = ramm.assetConfigs[assetInIndex!]
            const assetOutIndex = ramm.assetTypeIndices.get(
                // Type names in Sui Move events are missing the leading '0x'
                "0x" + tradeEventParsedJSON.token_out.name
            )
            const assetOut = ramm.assetConfigs[assetOutIndex!]

            // Scale amounts to base units, disregarding each asset's (possibly) different
            // decimal places
            const amountIn =
                tradeEventParsedJSON.amount_in /
                10 ** assetIn.assetDecimalPlaces
            const amountOut =
                tradeEventParsedJSON.amount_out /
                    10 ** assetOut.assetDecimalPlaces +
                tradeEventParsedJSON.protocol_fee /
                    10 ** assetOut.assetDecimalPlaces

            this.rammPoolsVolume[ramm.poolAddress][assetIn.assetTicker] +=
                amountIn
            this.rammPoolsVolume[ramm.poolAddress][assetOut.assetTicker] +=
                amountOut

        } else {
            console.error(
                `Trade failed with RAMM with ID ${ramm.poolAddress}: ` +
                    rammTxResponse.errors
            )
        }
    }

    /**
     * Logs the following data for each of the RAMM pools known to the bot:
     * * their per-asset TVL, and
     * * their imbalance ratios
     *
     * at the moment of the query.
     */
    async logRAMMTVLAndImbRations() {
        for (const rammAddress in this.rammPools) {
            const rammPool = this.rammPools[rammAddress]
            const rammKeypair = this.poolKeypairs[rammPool.uri]

            // log RAMM pool states and imbalance ratios
            try {
                const { poolStateEventJSON, imbRatioEventJSON } =
                    await rammPool.rammSuiPool.getPoolStateAndImbalanceRatios(
                        rammPool.suiClient,
                        rammKeypair.toSuiAddress()
                    )

                const poolState = processPoolStateEvent(
                    rammPool.rammSuiPool,
                    poolStateEventJSON
                )
                const imbRatioData = processImbRatioEvent(
                    rammPool.rammSuiPool,
                    imbRatioEventJSON
                )

                logger.info(
                    {
                        ramm_id: poolState.rammID,
                        data: poolState.assetBalances,
                    },
                    "ramm pool state"
                )

                logger.info(
                    {
                        ramm_id: imbRatioData.rammID,
                        data: imbRatioData.imbRatios,
                    },
                    "imb ratios"
                )
            } catch (e) {
                console.error("Error logging RAMM imb. ratios/pool states: " + e)
            }
        }
    }

    /**
     * For each of the RAMM pools known to the bot, log each of their assets' volumes at the
     * moment of the query, beginning the count from the moment the bot started operating.
     */
    logRAMMVolumes() {
        for (const rammAddress in this.rammPoolsVolume) {
            logger.info(
                {
                    ramm_id: rammAddress,
                    data: this.rammPoolsVolume[rammAddress],
                },
                "ramm volumes"
            )
        }
    }

    /**
     * Signs and executes a transaction block, if it has any transactions in it.
     * @param transactionBlock
     * @param keypair
     * @param strategy
     * @param showEvents
     * @returns The response obtained from executing the transaction block, `void` otherwise.
     */
    private async executeTransactionBlock(
        transactionBlock: TransactionBlock,
        keypair: Keypair,
        strategy: Strategy,
        showEvents: boolean = false
    ): Promise<SuiTransactionBlockResponse | undefined> {
        if (transactionBlock.blockData.transactions.length !== 0) {
            try {
                transactionBlock.setGasBudget(DEFAULT_GAS_BUDGET)
                const result =
                    await this.suiClient.signAndExecuteTransactionBlock({
                        transactionBlock,
                        signer: keypair,
                        options: {
                            showObjectChanges: true,
                            showEffects: true,
                            showEvents,
                        },
                    })
                logger.info(
                    {
                        strategy: strategy,
                        transaction_status: result.effects?.status,
                    },
                    "transaction"
                )

                return result
            } catch (e) {
                if (e instanceof JsonRpcError) {
                    if (e.code === -32002) {
                        // This error code corresponds to "Transaction execution failed due to issues with transaction inputs",
                        // more specifically: the gas coin used by the PTB has insufficient balance for the budget set.
                        throw e
                    }
                } else {
                    "Error signing/executing transaction block: " + e
                }
            }
        }
    }

    /** Add a strategy to this bot. The pools it subscribes to must have been added first. */
    addStrategy(strategy: Strategy) {
        for (const dataSource of strategy.subscribes_to()) {
            if (
                !Object.prototype.hasOwnProperty.call(
                    this.dataSources,
                    dataSource
                )
            ) {
                throw new Error(
                    "Bot does not know the dataSource with address " +
                        dataSource
                )
            }
            this.strategies[dataSource].push(strategy)
        }
    }

    /** Add a new price data source for this bot to use */
    addDataSource(dataSource: DataSource) {
        if (
            Object.prototype.hasOwnProperty.call(
                this.dataSources,
                dataSource.uri
            )
        ) {
            throw new Error(
                "Data source " + dataSource.uri + " has already been added."
            )
        }
        this.dataSources[dataSource.uri] = dataSource
        this.strategies[dataSource.uri] = []
    }

    /** Add a new pool for this bot to use for trading. */
    addPool(pool: Pool<CetusParams | RAMMSuiParams>, keypair: Keypair) {
        if (Object.prototype.hasOwnProperty.call(this.pools, pool.uuid)) {
            const errMsg: string =
                "Pool " +
                pool.uri +
                " has already been added with asset pair: " +
                pool.coinA.type +
                "/" +
                pool.coinB.type
            throw new Error(errMsg)
        }

        // If the pool being added is a RAMM, and has not yet been recorded by the bot, take
        // note of it.
        if (pool instanceof RAMMPool) {
            // If the pool has not already been added to the RAMM pool state/imb. ratio tracker, do
            // so.
            // Recall that that field is keyed by a RAMM's address, and not its UUID.
            if (
                !Object.prototype.hasOwnProperty.call(
                    this.rammPools,
                    pool.address
                )
            ) {
                this.rammPools[pool.address] = pool as RAMMPool
            }

            // If the pool doesn't already exist in the bot's RAMM volume tracker, add it.
            // Recall that that field is keyed by a RAMM's address, and not its UUID.
            if (
                !Object.prototype.hasOwnProperty.call(
                    this.rammPoolsVolume,
                    pool.address
                )
            ) {
                const ramm = pool as RAMMPool
                this.rammPoolsVolume[ramm.address] = {}

                // For every asset in the RAMM, initialize its volume to 0
                // Key that asset's volume by the asset's ticker, e.g. bitcoin's in 'BTC'.
                for (const asset of ramm.rammSuiPool.assetConfigs) {
                    this.rammPoolsVolume[ramm.address][asset.assetTicker] = 0
                }
            }
        }

        this.pools[pool.uri] = pool
        this.poolKeypairs[pool.uri] = keypair
        this.addDataSource(pool)
    }
}
