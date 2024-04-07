import SDK, {
    Percentage,
    SdkOptions,
    adjustForSlippage,
    d,
} from '@cetusprotocol/cetus-sui-clmm-sdk/dist'

import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client'
import { Keypair } from '@mysten/sui.js/cryptography'
import { TransactionBlock } from '@mysten/sui.js/transactions'

import { SuiNetworks } from '../../networks'

import BN from 'bn.js'
import { getTotalBalanceByCoinType } from '../../utils/utils'
import { CetusParams } from '../dexsParams'
import { Pool } from '../pool'
import { clmmMainnet } from './mainnet_config'
import { Coin } from '../../coins'


function buildSdkOptions(network: SuiNetworks): SdkOptions {
    switch (network) {
        case 'mainnet':
            return clmmMainnet
        case 'testnet':
            throw new Error('Testnet not yet supported')
    }
}

export class CetusPool extends Pool<CetusParams> {
    private sdk: SDK
    private suiClient: SuiClient
    private network: SuiNetworks

    constructor(
        poolAddress: string,
        coinA: Coin,
        coinB: Coin,
        keypair: Keypair,
        network: SuiNetworks
    ) {
        super(poolAddress, coinA, coinB)
        this.network = network
        this.sdk = new SDK(buildSdkOptions(this.network))

        this.sdk.senderAddress = keypair.getPublicKey().toSuiAddress()
        this.suiClient = new SuiClient({ url: getFullnodeUrl(network) })
    }

    /**
     * Create swap transaction
     * @param transactionBlock Transaction block
     * @param params Cetus parameters
     * @returns Transaction block
     */
    async createSwapTransaction(
        transactionBlock: TransactionBlock,
        params: CetusParams
    ): Promise<TransactionBlock> {
        const totalBalance = await getTotalBalanceByCoinType(
            this.suiClient,
            this.sdk.senderAddress,
            params.a2b ? this.coinA.type : this.coinB.type
        )

        if (params.amountIn > 0 && Number(totalBalance) >= params.amountIn) {
            transactionBlock = await this.createCetusTransactionBlockWithSDK(transactionBlock, params)

            return transactionBlock
        }

        throw new Error("can't build cetus tx")
    }

    async estimatePriceAndFee(): Promise<{
        price: number
        fee: number
    }> {
        const pool = await this.sdk.Pool.getPool(this.address)
        const price = pool.current_sqrt_price ** 2 / 2 ** 128

        const scaled_price = price * (10 ** (this.coinA.decimals - this.coinB.decimals))

        let fee = pool.fee_rate * 10 ** -6

        return {
            price: scaled_price,
            fee,
        }
    }

    async createCetusTransactionBlockWithSDK(
        txb: TransactionBlock,
        params: CetusParams
    ): Promise<TransactionBlock> {
        // fix input token amount
        const coinAmount = new BN(params.amountIn)
        // input token amount is token a
        const byAmountIn = true
        // slippage value
        const slippage = Percentage.fromDecimal(d(params.slippage))
        // Fetch pool data
        const pool = await this.sdk.Pool.getPool(this.address)
        // Estimated amountIn amountOut fee

        const res: any = await this.sdk.Swap.preswap({
            a2b: params.a2b,
            amount: coinAmount.toString(),
            byAmountIn: byAmountIn,
            coinTypeA: this.coinA.type,
            coinTypeB: this.coinB.type,
            currentSqrtPrice: pool.current_sqrt_price,
            decimalsA: this.coinA.decimals,
            decimalsB: this.coinB.decimals,
            pool: pool,
        })

        /*const toAmount = byAmountIn
            ? res.estimatedAmountOut
            : res.estimatedAmountIn
        
        // const amountLimit = adjustForSlippage(toAmount, slippage, !byAmountIn);

        const amountLimit = adjustForSlippage(
            new BN(toAmount),
            slippage,
            !byAmountIn
        )*/

        // build swap Payload
        txb = await this.sdk.Swap.createSwapTransactionPayload(txb, {
            pool_id: pool.poolAddress,
            coinTypeA: pool.coinTypeA,
            coinTypeB: pool.coinTypeB,
            a2b: params.a2b,
            by_amount_in: byAmountIn,
            amount: res.amount.toString(),
            amount_limit: params.amountOut.toString(),
        })

        return txb
    }
}
