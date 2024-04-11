import { CoinStruct, SuiClient, SuiTransactionBlockResponse } from '@mysten/sui.js/client'
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
import { AssetTypeToSymbol, Assets } from './coins'
import { SuiObjectRef } from '@mysten/sui.js/dist/cjs/transactions'
import { RAMMImbalanceRatioData } from '@ramm/ramm-sui-sdk'

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
    private botKeypair: Keypair

    private rebalanceKeypairs: Set<Keypair>
    private coinTypes: Set<string>
    private maxDelta: number

    private imbalance!: RAMMImbalanceRatioData
    private lastImbalanceCheckTime!: number

    constructor(network: SuiNetworks, botKeypair: Keypair, maxDelta: number = 0.2) {
        this.network = network
        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
        this.botKeypair = botKeypair
        this.rebalanceKeypairs = new Set<Keypair>()
        this.coinTypes = new Set<string>()
        this.maxDelta = maxDelta
    }

    async loop(duration: number, delay: number, maxDelay: number) {
        let startTime = new Date().getTime()
        const baseDelay = delay

        let uniqueStrategies: Record<string, any> = {}
        for (const pool in this.strategies) {
            for (const strategy of this.strategies[pool]) {
                if (!uniqueStrategies.hasOwnProperty(strategy.uri)) {
                    uniqueStrategies[strategy.uri] = strategy['parameters']
                }
            }
        }
        logger.info({ strategies: uniqueStrategies }, 'strategies')

        mainloop: while (new Date().getTime() - startTime < duration) {
            //await this.rebalance()
            await this.checkSplitTokens(2, delay) ///TODO: change this
            await setTimeout(delay)
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
                    let txb = new TransactionBlock()

                    for (const order of tradeOrders) {
                        logger.info(
                            { strategy: strategy.uri, decision: order },
                            'order'
                        )

                        const a2b: boolean = order.a2b
                        const pool = this.pools[order.poolUuid]

                        const byAmountIn: boolean = true

                        if (pool instanceof RAMMPool) {
                            if (!this.imbalance || this.lastImbalanceCheckTime + 1000 * 30 <= Date.now()) {
                                this.imbalance = await pool.getImbalance()
                                this.lastImbalanceCheckTime = Date.now()
                            }
                            const imb = this.imbalance.imbRatios
                            const type = AssetTypeToSymbol.get(order.assetIn)

                            if (type && imb[type] >= 1.2) {
                                txb = new TransactionBlock()
                                break
                            }
                        }

                        txb = await this.pools[
                            order.poolUuid
                        ].createSwapTransaction(txb, {
                            a2b,
                            amountIn: order.amountIn,
                            amountOut: order.amountOut,
                            byAmountIn,
                            slippage: order.slippage,
                        })
                    }

                    // Execute the transaction
                    const res = await this.executeTransactionBlock(
                        txb,
                        this.botKeypair,
                        strategy
                    );
                    if (res) {
                        if (res.errors) {
                            delay = delay * 10
                        } else {

                        }
                    }
                    delay = Math.min(Math.max(delay, baseDelay), maxDelay);
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

    private async checkSplitTokens(n: number, delay: number) {
        let splitTXB = new TransactionBlock()

        const rs = await this.suiClient.getCoins({ owner: this.botKeypair.toSuiAddress(), coinType: Assets.SUI.type })

        //const coinToPay = await (await this.suiClient.getCoins({ owner: this.botKeypair.toSuiAddress(), coinType: Assets.SUI.type })).data[0]
        //splitTXB.setGasPayment([{ digest: coinToPay.digest, objectId: coinToPay.coinObjectId, version: coinToPay.version }]);

        for (let coin of this.coinTypes) {
            if (coin === Assets.SUI.type) {
                continue
            }
            const resp = await this.suiClient.getCoins({ owner: this.botKeypair.toSuiAddress(), coinType: coin })
            const balance = await this.suiClient.getBalance({ owner: this.botKeypair.toSuiAddress(), coinType: coin })
            const amt = Math.floor((Number(balance.totalBalance) - Math.random() * 10 ** 3) / n)

            resp.data.sort((a, b) => Number(b.balance) - Number(a.balance))
            if (resp.data.length < n) {
                console.log("splitting coins", coin, n - resp.data.length)
                let largest = resp.data[0]

                for (let i = 0; i < n - resp.data.length; i++) {
                    const [coin] = splitTXB.splitCoins(largest.coinObjectId, [splitTXB.pure(amt)])
                    splitTXB.transferObjects([coin], splitTXB.pure(this.botKeypair.toSuiAddress()))
                }
            } else if (resp.data.length > n * 3) {
                const toMerge = resp.data.slice(n + 1).map((a) => a.coinObjectId)
                splitTXB.mergeCoins(resp.data[0].coinObjectId, toMerge)
            }
        }

        splitTXB.setGasBudget(DEFAULT_GAS_BUDGET)
        if (splitTXB.blockData.transactions.length !== 0) {
            await this.suiClient.signAndExecuteTransactionBlock({
                transactionBlock: splitTXB,
                signer: this.botKeypair
            });
        }

        await setTimeout(delay)
        if (this.coinTypes.has(Assets.SUI.type)) {
            let gasTXB = new TransactionBlock()
            const coin = Assets.SUI.type

            const resp = await this.suiClient.getCoins({ owner: this.botKeypair.toSuiAddress(), coinType: coin })

            resp.data.sort((a, b) => Number(b.balance) - Number(a.balance))

            const amts = []
            for (let i = 0; i < (n + 1 - resp.data.length) * 2; i++) {
                const amt = Math.floor(DEFAULT_GAS_BUDGET * n * 10 + Math.random() * 10 ** 7)
                amts.push(amt)
            }

            if (amts.length !== 0) {
                console.log("splitting gas", coin, n + 2 - resp.data.length)
                let gasCoins = gasTXB.splitCoins(gasTXB.gas, amts)

                amts.forEach((_transfer, index) => {
                    gasTXB.transferObjects([gasCoins[index]], this.botKeypair.toSuiAddress());
                });
                this.suiClient.signAndExecuteTransactionBlock({
                    transactionBlock: gasTXB,
                    signer: this.botKeypair
                })
            }
        }
    }

    private async executeTransactionBlock(
        transactionBlock: TransactionBlock,
        keypair: Keypair,
        strategy: Strategy,
    ): Promise<SuiTransactionBlockResponse | undefined> {
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
                return result
            } catch (e) {
                logger.error(e)
            }
        }
        return undefined
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
