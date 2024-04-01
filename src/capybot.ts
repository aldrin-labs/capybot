import { SuiClient } from '@mysten/sui.js/client'
import { Keypair } from '@mysten/sui.js/dist/cjs/cryptography/keypair'
import { TransactionBlock } from '@mysten/sui.js/transactions'

import { setTimeout } from 'timers/promises'
import { DataSource } from './data_sources/data_source'
import { SuiNetworks, getFullnodeUrl } from './networks'
import { CetusPool } from './dexs/cetus/cetus'
import { CetusParams, RAMMSuiParams } from './dexs/dexsParams'
import { Pool } from './dexs/pool'
import { logger } from './logger'
import { Strategy } from './strategies/strategy'
import { RAMMPool } from './dexs/ramm-sui/ramm-sui'
import { processImbRatioEvent, processPoolStateEvent } from '@ramm/ramm-sui-sdk'

// Default gas budget: 0.5 `SUI`
const DEFAULT_GAS_BUDGET: number = 0.5 * (10 ** 9)

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

    public strategies: Record<string, Array<Strategy>> = {}
    private suiClient: SuiClient
    private network: SuiNetworks

    constructor(network: SuiNetworks) {
        this.network = network
        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
    }

    async loop(duration: number, delay: number) {
        let startTime = new Date().getTime()

        let uniqueStrategies: Record<string, any> = {}
        for (const pool in this.strategies) {
            for (const strategy of this.strategies[pool]) {
                if (!uniqueStrategies.hasOwnProperty(strategy.uri)) {
                    uniqueStrategies[strategy.uri] = strategy['parameters']
                }
            }
        }
        logger.info({ strategies: uniqueStrategies }, 'strategies')

        let transactionBlock: TransactionBlock = new TransactionBlock()
        mainloop: while (new Date().getTime() - startTime < duration) {
            for (const uri in this.dataSources) {
                let dataSource = this.dataSources[uri]
                let data = await dataSource.getData()

                if (!data) {
                    logger.error(
                        { dataSource: dataSource.uri },
                        'No data received from data source; skipping round.'
                    )
                    continue mainloop
                }

                logger.info(
                    {
                        price: data,
                    },
                    'price'
                )

                // Push new data to all strategies subscribed to this data source
                for (const strategy of this.strategies[uri]) {
                    // Get orders for this strategy.
                    let tradeOrders = strategy.evaluate(data)

                    // Create transactions for the suggested trades
                    for (const order of tradeOrders) {
                        logger.info(
                            { strategy: strategy.uri, decision: order },
                            'order'
                        )

                        let amountIn = Math.round(order.amountIn)
                        let amountOut = Math.round(
                            order.estimatedPrice * amountIn
                        )
                        const a2b: boolean = order.a2b
                        const byAmountIn: boolean = true
                        const slippage: number = 1 // TODO: Define this in a meaningful way. Perhaps by the strategies.

                        if (this.pools[order.poolUuid] instanceof CetusPool) {
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
/*                             await this.executeTransactionBlock(
                                transactionBlock,
                                this.poolKeypairs[order.poolUuid],
                                strategy
                            ); */
                        } else if (this.pools[order.poolUuid] instanceof RAMMPool) {
                            transactionBlock = new TransactionBlock()
                            transactionBlock = await this.pools[
                                order.poolUuid
                            ].createSwapTransaction(transactionBlock, {
                                a2b,
                                amountIn,
                            })

/*                             await this.executeTransactionBlock(
                                transactionBlock,
                                this.poolKeypairs[order.poolUuid],
                                strategy
                            ); */
                        }
                    }
                }
            }

            for (const rammAddress in this.rammPools) {
                const rammPool = this.rammPools[rammAddress]
                const rammKeypair = this.poolKeypairs[rammPool.uri]

                const { poolStateEventJSON, imbRatioEventJSON } =
                    await rammPool.rammSuiPool.getPoolStateAndImbalanceRatios(
                        rammPool.suiClient,
                        rammKeypair.toSuiAddress()
                    )

                const poolState = processPoolStateEvent(rammPool.rammSuiPool, poolStateEventJSON)
                const imbRatioData = processImbRatioEvent(rammPool.rammSuiPool, imbRatioEventJSON)

                logger.info(
                    { ramm_id: poolState.rammID, data: poolState.assetBalances },
                    'ramm pool state'
                )

                logger.info(
                    { ramm_id: imbRatioData.rammID, data: imbRatioData.imbRatios},
                    'imb ratios'
                )
            }


            await setTimeout(delay)
        }
    }

    private async executeTransactionBlock(
        transactionBlock: TransactionBlock,
        keypair: Keypair,
        strategy: Strategy
    ) {
        if (transactionBlock.blockData.transactions.length !== 0) {
            try {
                transactionBlock.setGasBudget(DEFAULT_GAS_BUDGET)
                let result =
                    await this.suiClient.signAndExecuteTransactionBlock({
                        transactionBlock,
                        signer: keypair,
                        options: {
                            showObjectChanges: true,
                            showEffects: true,
                        },
                    })
                logger.info(
                    { strategy: strategy, transaction: result },
                    'transaction'
                )
            } catch (e) {
                logger.error(e)
            }
        }
    }

    /** Add a strategy to this bot. The pools it subscribes to must have been added first. */
    addStrategy(strategy: Strategy) {
        for (const dataSource of strategy.subscribes_to()) {
            if (!this.dataSources.hasOwnProperty(dataSource)) {
                throw new Error(
                    'Bot does not know the dataSource with address ' +
                        dataSource
                )
            }
            this.strategies[dataSource].push(strategy)
        }
    }

    /** Add a new price data source for this bot to use */
    addDataSource(dataSource: DataSource) {
        if (this.dataSources.hasOwnProperty(dataSource.uri)) {
            throw new Error(
                'Data source ' + dataSource.uri + ' has already been added.'
            )
        }
        this.dataSources[dataSource.uri] = dataSource
        this.strategies[dataSource.uri] = []
    }

    /** Add a new pool for this bot to use for trading. */
    addPool(
        pool: Pool<CetusParams | RAMMSuiParams>,
        keypair: Keypair
    ) {
        if (this.pools.hasOwnProperty(pool.uuid)) {
            const errMsg: string =
                'Pool ' +
                pool.uri +
                ' has already been added with asset pair: ' +
                pool.coinA.type +
                '/' +
                pool.coinB.type
            throw new Error(errMsg)
        }

        // If the pool being added is a RAMM, and has not yet been recorded by the bot, take
        // note of it.
        if (pool instanceof RAMMPool && !this.rammPools.hasOwnProperty(pool.uri)) {
            this.rammPools[pool.address] = pool as RAMMPool
        }

        this.pools[pool.uri] = pool
        this.poolKeypairs[pool.uri] = keypair
        this.addDataSource(pool)
    }
}
