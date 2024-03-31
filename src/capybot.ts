import { SuiClient } from '@mysten/sui.js/client'
import { Keypair } from '@mysten/sui.js/dist/cjs/cryptography/keypair'
import { TransactionBlock } from '@mysten/sui.js/transactions'

import { setTimeout } from 'timers/promises'
import { DataSource } from './data_sources/data_source'
import { SuiNetworks, getFullnodeUrl } from './networks'
import { CetusPool } from './dexs/cetus/cetus'
import { CetusParams, RAMMSuiParams, TurbosParams } from './dexs/dexsParams'
import { Pool } from './dexs/pool'
import { logger } from './logger'
import { Strategy } from './strategies/strategy'
import { RAMMPool } from './dexs/ramm-sui/ramm-sui'
import { Int } from 'ccxt/js/src/base/types'

// Default gas budget: 0.5 `SUI`
const DEFAULT_GAS_BUDGET: number = 0.5 * (10 ** 9)

interface Transfer {
    to: string;
    amount: number;
}

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
    public pools: Record<
        string,
        Pool<CetusParams | TurbosParams | RAMMSuiParams>
    > = {}

    /**
     * A record of the keypairs each pool uses to sign its transactions.
     *
     * The key is the address of the pool, and the value is the keypair object.
     */
    public poolKeypairs: Record<string, Keypair> = {}
    public strategies: Record<string, Array<Strategy>> = {}

    private suiClient: SuiClient
    private network: SuiNetworks

    private rebalanceKeypairs: Set<Keypair>
    private coinTypes: Set<string>
    private maxDelta: number

    constructor(network: SuiNetworks, maxDelta: number = 0.2) {
        this.network = network
        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
        this.rebalanceKeypairs = new Set<Keypair>()
        this.coinTypes = new Set<string>()
        this.maxDelta = maxDelta
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
            await this.rebalance()
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
                            await this.executeTransactionBlock(
                                transactionBlock,
                                this.poolKeypairs[order.poolUuid],
                                strategy
                            );
                        } else if (this.pools[order.poolUuid] instanceof RAMMPool) {
                            transactionBlock = new TransactionBlock()
                            transactionBlock = await this.pools[
                                order.poolUuid
                            ].createSwapTransaction(transactionBlock, {
                                a2b,
                                amountIn,
                            })

                            await this.executeTransactionBlock(
                                transactionBlock,
                                this.poolKeypairs[order.poolUuid],
                                strategy
                            );
                        }
                    }
                }
            }
            await setTimeout(delay)
        }
    }

    private async rebalance() {

        logger.info("checking if needs rebalance")
        const balances = new Map<string, number[]>()
        const rebalance = new Map<string, number[]>()

        for (let coin of this.coinTypes) {
            const kpBalance: number[] = []
            const balanceAddrs: string[] = []
            let avg: number = 0
            const keypairs = Array.from(this.rebalanceKeypairs)
            for (let keypair of keypairs) {
                let coins = await this.suiClient.getCoins({ owner: keypair.toSuiAddress(), coinType: coin })
                let coinBalance = coins.data[0]
                for (let i = 0; i < coins.data.length; i++) {
                    const coinData = coins.data[i];
                    if (coinBalance.balance < coinData.balance) {
                        coinBalance = coinData
                    }
                }
                kpBalance.push(Number(coinBalance.balance))
                balanceAddrs.push(coinBalance.coinObjectId)
                avg += Number(coinBalance.balance)
            }
            balances.set(coin, kpBalance)

            const avgDiff: number[] = []
            const from: Transfer[] = []
            const to: Transfer[] = []
            let senderPos = 0;
            let triggerRebalance: boolean = false
            avg = avg / this.rebalanceKeypairs.size
            for (let i = 0; i < kpBalance.length; i++) {
                const amt = kpBalance[i];
                let delta = Math.floor(avg - amt)
                if (Math.abs(delta) / avg >= this.maxDelta) {
                    triggerRebalance = true
                }
                avgDiff.push(delta)
                if (delta > 0) {
                    to.push({ amount: Number(delta), to: keypairs[i].toSuiAddress() })
                } else {
                    senderPos = i
                    from.push({ amount: Number(-delta), to: balanceAddrs[i] })
                }
            }
            rebalance.set(coin, avgDiff)

            if (triggerRebalance) {
                logger.info("executing rebalance")
                await this.executeRebalanceTx(keypairs[senderPos], from[0], to)
            }
        }
    }

    private async executeRebalanceTx(sender: Keypair, from: Transfer, to: Transfer[]) {
        let txb = new TransactionBlock()
        const coins = txb.splitCoins(
            from.to,
            to.map((transfer) => transfer.amount),
        );
        to.forEach((transfer, index) => {
            txb.transferObjects([coins[index]], transfer.to);
        });
        let res = await this.suiClient.signAndExecuteTransactionBlock({
            transactionBlock: txb,
            signer: sender
        });
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
        pool: Pool<CetusParams | RAMMSuiParams | TurbosParams>,
        keypair: Keypair,
        requiresRebalance: boolean = false
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

        this.pools[pool.uri] = pool
        this.poolKeypairs[pool.uri] = keypair
        this.addDataSource(pool)

        if (requiresRebalance) {
            this.rebalanceKeypairs.add(keypair)
            this.coinTypes.add(pool.coinA.type)
            this.coinTypes.add(pool.coinB.type)
        }
    }
}
