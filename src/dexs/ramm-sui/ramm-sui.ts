import { CoinStruct, SuiClient, getFullnodeUrl } from '@mysten/sui.js/client'
import { Keypair } from '@mysten/sui.js/cryptography'
import {
    TransactionBlock,
    TransactionObjectArgument,
} from '@mysten/sui.js/transactions'

import { SuiNetworks } from '../../networks'

import { RAMMSuiParams } from '../dexsParams'
import { Pool } from '../pool'

import {
    RAMMSuiPool,
    RAMMSuiPoolConfig,
    PriceEstimationEvent,
} from '@ramm/ramm-sui-sdk'
import { Coin } from '../../coins'
import { logger } from '../../logger'

export class RAMMPool extends Pool<RAMMSuiParams> {
    public rammSuiPool: RAMMSuiPool
    public suiClient: SuiClient

    /**
     * The SUI address of the SUI token, in short and long form.
     *
     * Needed when selecting a coin for payment with the RAMM SDK - if the payment is in SUI, the
     * gas object must be split.
     *
     * In order to know whether the payment is in SUI, the asset type must be compared to these
     * values.
     */
    private static readonly SUI_ADDRESS_SHORT: string = '0x2::SUI::sui'
    private static readonly SUI_ADDRESS_LONG: string =
        '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'

    public senderAddress: string
    // Required to estimate the price of a trade
    public defaultAmountCoinA: number

    constructor(
        rammConfig: RAMMSuiPoolConfig,
        address: string,
        coinA: Coin,
        defaultAmountCoinA: number,
        coinB: Coin,
        keypair: Keypair,
        network: SuiNetworks
    ) {
        super(address, coinA, coinB)
        this.defaultAmountCoinA = defaultAmountCoinA

        this.rammSuiPool = new RAMMSuiPool(rammConfig)
        this.senderAddress = keypair.getPublicKey().toSuiAddress()

        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
    }

    /**
     * Select a certain amount of a coin of a certain asset to perform a trade against the RAMM.
     *
     * @param txb Transaction block to which the coin selection/splitting transactions will be added
     * @param asset Asset in which denomination the coin will be selected
     * @param quantity Quantity of the asset to be prepared for payment
     * @returns Object with two properties:
     * 1. the quantity of the asset with the multiplier applied, and
     * 2. the new coin object, whose balance is equal to the value in 1.
     */
    async prepareCoinForPaymentCommon(
        txb: TransactionBlock,
        asset: string,
        quantityWithMultiplier: number
    ): Promise<{
        quantityWithMultiplier: number
        newCoinObj: TransactionObjectArgument
    }> {
        // If the currency used for the payment is `SUI`, split the needed amount from the gas
        // object.
        if (
            asset === RAMMPool.SUI_ADDRESS_LONG ||
            asset === RAMMPool.SUI_ADDRESS_SHORT
        ) {
            return {
                quantityWithMultiplier,
                newCoinObj: txb.splitCoins(txb.gas, [
                    txb.pure(quantityWithMultiplier),
                ]),
            }
        }

        // Get all coins of type `asset` owned by the wallet
        const baseCoins = (
            await this.suiClient.getCoins({
                owner: this.senderAddress,
                coinType: asset,
                // By default, only 5 coins are queried, which may not be enough
                limit: 25,
            })
        ).data
        const balance = (c: CoinStruct) => parseInt(c.balance)
        const basedCoinUsedToPay = baseCoins.find(
            (c) => balance(c) >= quantityWithMultiplier
        )
        // If there is a coin whose balance is large enough to pay for the trade, use it and
        // the process ends here.
        if (basedCoinUsedToPay) {
            return {
                quantityWithMultiplier,
                newCoinObj: txb.splitCoins(
                    txb.object(basedCoinUsedToPay.coinObjectId),
                    [txb.pure(quantityWithMultiplier)]
                ),
            }
        }

        // Sort coins, from least to most valuable, and use as many as necessary to
        // pay for the trade.
        // Stop as soon as enough coins have been found.
        const sortedBaseCoins = baseCoins.sort(
            (a, b) => balance(a) - balance(b)
        )

        let sum = 0
        const necessaryCoins: CoinStruct[] = []
        // Assuming the wallet has enough balance, at the end of the loop, `necessaryCoins` will
        // be a list of coins such that
        // 1. the balances of which are individually insufficient to pay for the trade, but
        // 2. whose combined balance is sufficient.
        for (const coin of sortedBaseCoins) {
            const coinValue = balance(coin)
            sum += coinValue
            necessaryCoins.push(coin)

            if (sum >= quantityWithMultiplier) {
                break
            }
        }

        if (sum < quantityWithMultiplier) {
            throw new Error(
                `Insufficient balance to pay for the trade. Needed: ${quantityWithMultiplier}, found: ${sum}`
            )
        }

        // Base coin object, to which the remaining coins will be merged to pay for the trade
        const baseCoin = necessaryCoins[0]
        // The remaining coins, to be merged into the base coin.
        const otherCoins = necessaryCoins.slice(1)

        // Remember - `mergeCoins` does not return a PTB argument - it mutates its first argument,
        // the base coin
        txb.mergeCoins(
            txb.object(baseCoin.coinObjectId),
            otherCoins.map((c) => txb.object(c.coinObjectId))
        )
        // `splitCoins` returns a list of coins whose length is the length of its second argument,
        // so in this case, one coin.
        const [newCoinObj] = txb.splitCoins(txb.object(baseCoin.coinObjectId), [
            txb.pure(quantityWithMultiplier),
        ])

        return {
            quantityWithMultiplier,
            newCoinObj,
        }
    }

    /**
     * Create swap transaction
     * @param transactionBlock Transaction block
     * @param params Cetus parameters
     * @returns Transaction block
     */
    async createSwapTransaction(
        transactionBlock: TransactionBlock,
        params: RAMMSuiParams
    ): Promise<TransactionBlock> {
        if (params.amountIn === 0) {
            throw new Error('AmountIn or amountOut must be non-zero')
        }

        const { assetIn, assetOut } = params.a2b
            ? { assetIn: this.coinA.type, assetOut: this.coinB.type }
            : { assetIn: this.coinB.type, assetOut: this.coinA.type }

        try {
            const { newCoinObj } = await this.prepareCoinForPaymentCommon(
                transactionBlock,
                assetIn,
                params.amountIn
            )

            this.rammSuiPool.tradeAmountIn(transactionBlock, {
                assetIn,
                assetOut,
                amountIn: newCoinObj,
                minAmountOut: 1,
            })
        } catch (e) {
            logger.error(e)
        }

        return transactionBlock
    }

    /**
     * Given a trader for a RAMM Sui pool, a base asset, a quote asset and a quantity, returns the
     * estimated price a trade for such an amount would receive.
     *
     * The price will be expressed as a ratio of the quote asset to the base asset, i.e. the cost
     * of 1 unit of the quote asset in terms of the base asset.
     */
    async estimatePriceAndFee(): Promise<{
        price: number
        fee: number
    }> {
        const amountIn = this.defaultAmountCoinA * 10 ** this.coinA.decimals

        const estimate_txb: TransactionBlock =
            this.rammSuiPool.estimatePriceWithAmountIn({
                assetIn: this.coinA.type,
                assetOut: this.coinB.type,
                amountIn,
            })

        const devInspectRes = await this.suiClient.devInspectTransactionBlock({
            sender: this.senderAddress,
            transactionBlock: estimate_txb,
        })

        if (
            !devInspectRes ||
            !devInspectRes.events ||
            devInspectRes.events.length === 0
        ) {
            logger.error('No events found in the transaction block')
        }

        if (devInspectRes.error) {
            throw new Error(
                'Price estimation devInpect failed with: ' + devInspectRes.error
            )
        }

        // Price estimation, if successful, only returns one event, so this indexation is safe.
        const priceEstimationEventJSON = devInspectRes.events[0]
            .parsedJson as PriceEstimationEvent

        const price =
            priceEstimationEventJSON.amount_out /
            priceEstimationEventJSON.amount_in
        const scaledPrice =
            price * 10 ** (this.coinA.decimals - this.coinB.decimals)

        return {
            price: scaledPrice,
            fee: priceEstimationEventJSON.protocol_fee / amountIn,
        }
    }
}
