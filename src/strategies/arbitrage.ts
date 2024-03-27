import { DataPoint, DataType } from '../data_sources/data_point'
import { Strategy } from './strategy'
import { TradeOrder } from './order'
import { Coin } from '../coins'

type PoolWithDirection = {
    poolUuid: string
    coinA: Coin
    coinB: Coin
    a2b: boolean
}

export class Arbitrage extends Strategy {
    private readonly lowerLimit: number
    private readonly poolChain: Array<PoolWithDirection>
    private latestRate: Record<string, number> = {}
    private latestFee: Record<string, number> = {}
    private readonly defaultAmount: number

    /**
     * Create a new arbitrage strategy.
     *
     * @param poolChain The chain of pools to consider for an arbitrage. The order should be defined such that a transaction on all chains in order will end up with the same token.
     * @param defaultAmount The default amount of the first coin in the pool chain to trade (e.g. `poolChain[0].a2b ? poolChain[0].pool.coinTypeA : poolChain[0].pool.coinTypeB`.
     *
     * It is an unscaled amount, and decimal places are applied contingent on the `a2b` property in each circumstance.
     * @param relativeLimit Relative limit is percentage, e.g. 1.05 for a 5% win.
     * @param name A human-readable name for this strategy.
     */
    constructor(
        poolChain: Array<PoolWithDirection>,
        defaultAmount: number,
        relativeLimit: number,
        name: string
    ) {
        super({
            name: name,
            poolChain: poolChain,
        })
        this.poolChain = poolChain
        this.defaultAmount = defaultAmount
        this.lowerLimit = relativeLimit
    }

    evaluate(data: DataPoint): Array<TradeOrder> {
        // This strategy is only interested in the price from the pools it's observing
        if (
            data.type != DataType.Price ||
            !this.poolChain.map((p) => p.poolUuid).includes(data.source_uri)
        ) {
            return []
        }

        // Update history
        this.latestRate[data.source_uri] = data.price
        this.latestFee[data.source_uri] = data.fee

        // Compute the price when exchanging coins around the chain
        let arbitrage = 1
        let arbitrageReverse = 1
        for (const pool of this.poolChain) {
            let rate = this.getLatestRate(pool.poolUuid, pool.a2b)
            if (rate == undefined) {
                // Not all pools have a registered value yet.
                return []
            }
            arbitrage *= (1 - this.latestFee[pool.poolUuid]) * rate
            arbitrageReverse *= (1 - this.latestFee[pool.poolUuid]) * (1 / rate)
        }
        this.logStatus({ arbitrage: arbitrage, reverse: arbitrageReverse })

        let amountIn: number = this.defaultAmount

        if (arbitrage > this.lowerLimit) {
            // The amount of A by trading around the chain is higher than the amount in.
            let orders = []
            
            for (const pool of this.poolChain) {
                let latestRate = this.getLatestRate(pool.poolUuid, pool.a2b)

                //console.log('\n\nAMOUNT IN: ' + amountIn)
                const scaledAmountIn = amountIn * (pool.a2b ? 10 ** pool.coinA.decimals : 10 ** pool.coinB.decimals)
                //console.log('SCALED AMOUNT IN: ' + scaledAmountIn)
                //console.log('ASSET IN: ' + (pool.a2b ? pool.coinA.type : pool.coinB.type))

                orders.push({
                    poolUuid: pool.poolUuid,
                    assetIn: pool.a2b ? pool.coinA.type : pool.coinB.type,
                    amountIn: scaledAmountIn,
                    estimatedPrice: latestRate,
                    a2b: pool.a2b,
                })

                amountIn = amountIn * latestRate

                //console.log('POST MUL AMOUNT IN: ' + amountIn + '\n\n')
            }
            return orders
        } else if (arbitrageReverse > this.lowerLimit) {
            // The amount of A by trading around the chain is lower than the amount in. Trade in the opposite direction.
            let orders = []
            for (const pool of this.poolChain.reverse()) {
                let latestRate = this.getLatestRate(pool.poolUuid, !pool.a2b)

                // recall that in this case, `pool.a2b` is false, so B is inbound
                //console.log('\n\nREV AMOUNT IN: ' + amountIn)
                const scaledAmountIn = amountIn * (!pool.a2b ? 10 ** pool.coinA.decimals : 10 ** pool.coinB.decimals)
                //console.log('REV SCALED AMOUNT IN: ' + scaledAmountIn)
                //console.log('REV ASSET IN: ' + (!pool.a2b ? pool.coinA.type : pool.coinB.type))

                orders.push({
                    poolUuid: pool.poolUuid,
                    assetIn: !pool.a2b ? pool.coinA.type : pool.coinB.type,
                    amountIn: scaledAmountIn,
                    estimatedPrice: latestRate,
                    a2b: !pool.a2b,
                })

                amountIn = amountIn * latestRate

                //console.log('REV POST MUL AMOUNT IN: ' + amountIn + '\n\n')
            }
            return orders
        }

        // No decisions can be made at this point
        return []
    }

    subscribes_to(): Array<string> {
        return this.poolChain.map((value) => value.poolUuid)
    }

    getLatestRate(pool: string, a2b: boolean): number {
        return a2b ? this.latestRate[pool] : 1 / this.latestRate[pool]
    }
}
