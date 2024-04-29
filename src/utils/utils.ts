import { PaginatedCoins, SuiClient } from "@mysten/sui.js/client"
import {
    TransactionArgument,
    TransactionBlock,
} from "@mysten/sui.js/transactions"
import { normalizeSuiObjectId } from "@mysten/sui.js/utils"

import Decimal from "decimal.js"

export const SUI_COIN_OBJECT_ID = "0x2::sui::SUI"

export function convertTradeCoins(
    txb: TransactionBlock,
    coinIds: string[],
    coinType: string,
    amount: Decimal
): TransactionArgument[] {
    return isSuiCoin(coinType)
        ? [txb.splitCoins(txb.gas, [txb.pure(amount.toNumber())])[0]!]
        : coinIds.map((id) => txb.object(id))
}

export type SuiStructTag = {
    full_address: string
    source_address: string
    address: string
    module: string
    name: string
    type_arguments: string[]
}

export type CoinAsset = {
    coinAddress: string
    coinObjectId: string
    balance: bigint
}

export function moveCallCoinZero(txb: TransactionBlock, coinType: string) {
    return txb.moveCall({
        target: "0x2::coin::zero",
        typeArguments: [coinType],
    })
}

function isSUI(coinType: string) {
    return coinType.toLowerCase().indexOf("sui") > -1
}

function isSuiCoin(coinType: string) {
    return (
        extractStructTagFromType(coinType).full_address === SUI_COIN_OBJECT_ID
    )
}

export function extractStructTagFromType(type: string): SuiStructTag {
    let _type = type.replace(/\s/g, "")

    const genericsString = _type.match(/(<.+>)$/)
    const generics = genericsString?.[0]?.match(
        /(\w+::\w+::\w+)(?:<.*?>(?!>))?/g
    )
    if (generics) {
        _type = _type.slice(0, _type.indexOf("<"))
        const tag = extractStructTagFromType(_type)
        const structTag: SuiStructTag = {
            ...tag,
            type_arguments: generics.map(
                (item) => extractStructTagFromType(item).source_address
            ),
        }
        structTag.type_arguments = structTag.type_arguments.map((item) => {
            return isSuiCoin(item)
                ? item
                : extractStructTagFromType(item).source_address
        })
        structTag.source_address = composeType(
            structTag.full_address,
            structTag.type_arguments
        )
        return structTag
    }
    const parts = _type.split("::")

    const structTag: SuiStructTag = {
        full_address: _type,
        address: parts[2] === "SUI" ? "0x2" : normalizeSuiObjectId(parts[0]),
        module: parts[1],
        name: parts[2],
        type_arguments: [],
        source_address: "",
    }
    structTag.full_address = `${structTag.address}::${structTag.module}::${structTag.name}`
    structTag.source_address = composeType(
        structTag.full_address,
        structTag.type_arguments
    )
    return structTag
}

export function composeType(address: string, generics: string[]): string
export function composeType(
    address: string,
    struct: string,
    generics?: string[]
): string
export function composeType(
    address: string,
    module: string,
    struct: string,
    generics?: string[]
): string
export function composeType(address: string, ...args: unknown[]): string {
    const generics: string[] = Array.isArray(args[args.length - 1])
        ? (args.pop() as string[])
        : []
    const chains = [address, ...args].filter(Boolean)

    let result: string = chains.join("::")

    if (generics && generics.length) {
        result += `<${generics.join(", ")}>`
    }

    return result
}

export async function selectTradeCoins(
    suiClient: SuiClient,
    owner: string,
    coinType: string,
    expectedAmount: Decimal
): Promise<string[]> {
    console.log(
        `selectTradeCoins: coinType: (${coinType}), expectedAmount: (${expectedAmount})`
    )
    const coins: PaginatedCoins["data"][number][] = []
    const coinIds: string[] = []
    let totalAmount = new Decimal(0)
    let result: PaginatedCoins | undefined

    do {
        result = await suiClient.getCoins({
            owner,
            coinType,
            cursor: result?.nextCursor,
        })
        coins.push(...result.data)
    } while (result.hasNextPage)

    coins.sort((a, b) => {
        // From big to small
        return Number(b.balance) - Number(a.balance)
    })

    for (const coin of coins) {
        coinIds.push(coin.coinObjectId)
        totalAmount = totalAmount.add(coin.balance)
        if (totalAmount.gte(expectedAmount)) {
            break
        }
    }
    return coinIds
}

export async function getTotalBalanceByCoinType(
    suiClient: SuiClient,
    owner: string,
    coinType: string
): Promise<string> {
    const amountTotal = await suiClient.getBalance({
        owner,
        coinType,
    })

    console.log(
        `TotalBalance for CoinType (${coinType}), is: ${amountTotal.totalBalance} and the owner is: ${owner}`
    )

    return amountTotal.totalBalance
}

export async function getBalancesForCoinTypes(
    suiClient: SuiClient,
    owner: string,
    coinTypes: Set<string>
): Promise<Map<string, bigint>> {
    const coinsBalances = new Map<string, bigint>()

    for (const coinType of coinTypes.values()) {
        const coinBalance = await suiClient.getBalance({
            owner,
            coinType,
        })
        console.log(coinType, " - ", BigInt(coinBalance.totalBalance))
        coinsBalances.set(coinType, BigInt(coinBalance.totalBalance))
    }

    return coinsBalances
}

export async function buildInputCoinForAmount(
    txb: TransactionBlock,
    amount: bigint,
    coinType: string,
    owner: string,
    suiClient: SuiClient
): Promise<TransactionArgument[] | undefined> {
    if (amount === BigInt(0)) {
        throw new Error(`The amount cannot be (${amount})`)
    }

    const totalBalance = await getTotalBalanceByCoinType(
        suiClient,
        owner,
        coinType
    )

    if (BigInt(totalBalance) < amount) {
        // throw new Error(`The amount(${totalBalance}) is Insufficient balance for ${coinType} , expect ${amount}`);
        console.log(
            `The amount(${totalBalance}) is Insufficient balance for ${coinType} , expect ${amount}`
        )
        return undefined
    }

    if (isSUI(coinType)) {
        console.log(`coinType: (${coinType}), amount: (${amount})`)
        return [txb.splitCoins(txb.gas, [txb.pure(amount)])[0]!]
    }

    const coinObjectIds = await selectTradeCoins(
        suiClient,
        owner,
        coinType,
        new Decimal(Number(amount))
    )
    console.log(`coinObjectIds: ${coinObjectIds}`)
    return coinObjectIds.map((id) => txb.object(id))
}
