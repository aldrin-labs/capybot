import { TransactionBlock } from '@mysten/sui.js/transactions'

import { Coin } from '../coins'
import { DataPoint, DataType } from '../data_sources/data_point'
import { DataSource } from '../data_sources/data_source'
import { CetusParams, RAMMSuiParams, TurbosParams } from './dexsParams'

import { v5 as uuidv5 } from 'uuid'

export type PreswapResult = {
    estimatedAmountIn: number
    estimatedAmountOut: number
    estimatedFeeAmount: number
}

/**
 * Abstract class representing a pool of liquidity for decentralized exchanges (DEXs) such as Cetus and Turbos.
 */
export abstract class Pool<
    C extends CetusParams | TurbosParams | RAMMSuiParams,
> extends DataSource {
    /**
     * The coin type A for the pool.
     */
    public coinA: Coin
    /**
     * The coin type B for the pool.
     */
    public coinB: Coin

    /**
     * Namespace used to created UUIDs for pools using `uuid.v5()` - see
     * https://github.com/uuidjs/uuid?tab=readme-ov-file#uuidv5name-namespace-buffer-offset .
     *
     * Generated from https://www.uuidgenerator.net/.
     */
    public static readonly POOL_UUID_NAMESPACE = '8b05a61f-0c4c-428c-9a91-8955d8119419'

    /**
     * Sui address of the pool.
     */
    public address: string
    /**
     * The UUID of this pool instance. Generated using the `@types/uuid` package.
     *
     * Serves as its URI.
     *
     * Pool addresses cannot be used to uniquely identify a pool, because e.g. the same 3-asset
     * RAMM can be added to the bot in different strategies: once for its `A/B` trading pair, and
     * twice for its `B/C` trading pair.
     */
    public uuid: string

    /**
     * Creates an instance of Pool.
     * @param address The address of the pool.
     * @param coinA The coin type A for the pool.
     * @param coinB The coin type B for the pool.
     */
    constructor(address: string, coinA: Coin, coinB: Coin) {
        const types: string[] = [address];
        const coinTypeA = coinA.type
        const coinTypeB = coinB.type

        if (coinTypeA < coinTypeB) {
            types.push(...[coinTypeA, coinTypeB])
        } else {
            types.push(...[coinTypeB, coinTypeA])
        };

        const uuid: string = uuidv5(types.join(), Pool.POOL_UUID_NAMESPACE)
        super(uuid)
        this.uuid = uuid

        this.address = address
        this.coinA = coinA
        this.coinB = coinB

    }

    /**
     * Abstract method for creating a swap transaction.
     * @param transactionBlock The transaction block to create the transaction in.
     * @param params The parameters for the swap transaction.
     * @returns A Promise of type TransactionBlock.
     */
    abstract createSwapTransaction(
        transactionBlock: TransactionBlock,
        params: C
    ): Promise<TransactionBlock>

    /**
     * Abstract method for estimating the price of a cryptocurrency swap and the fee.
     * @returns A Promise of type number representing the estimated price of the swap and the **relative** fee.
     *
     */
    abstract estimatePriceAndFee(amount?: number): Promise<{
        price: number
        fee: number
    }>

    /**
     * Method for getting data about the pool: current price and fee (as a %), the pool's base and
     * quote assets, and the URI of the pool.
     *
     * The optional `amount` parameter is used specifically by the `Arbitrage` strategy, and only by RAMM pools, as
     * to obtain the exact price of a trade, the amount must be known.
     *
     * @returns A Promise of type DataPoint representing data about the pool.
     */
    async getData(amount?: number): Promise<DataPoint> {
        let priceAndFee = await this.estimatePriceAndFee(amount)
        return {
            type: DataType.Price,
            source_uri: this.uri,
            coinTypeFrom: this.coinA.type,
            coinTypeTo: this.coinB.type,
            price: priceAndFee.price,
            fee: priceAndFee.fee,
        }
    }
}
