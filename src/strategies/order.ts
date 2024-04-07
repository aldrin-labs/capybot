export type TradeOrder = {
    poolUuid: string
    assetIn: string
    amountIn: number
    amountOut: number
    estimatedPrice: number
    a2b: boolean,
    slippage: number
}
