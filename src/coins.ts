export type Coin = {
    name: string // The name of the coin.
    symbol: string // The symbol of the coin.
    type: string // The type of the coin.
    decimals: number // The number of decimals for the coin.
}

export namespace Assets {
    export const SUI: Coin = {
        name: "Sui",
        symbol: "SUI",
        type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        decimals: 9
    }

    export const USDT: Coin = {
        name: "Tether USD",
        symbol: "USDT",
        type: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
        decimals: 6
    }

    export const USDC: Coin = {
        "name": "USD Coin",
        "symbol": "USDC",
        "type": "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
        "decimals": 6,
    }

    export const WBTC: Coin = {
        "name": "Wrapped BTC",
        "symbol": "WBTC",
        "type": "0x27792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN",
        "decimals": 8,
    }
}

export const AssetTypeToSymbol = new Map([
    [Assets.SUI.type, Assets.SUI.symbol],
    [Assets.USDT.type, Assets.USDT.symbol],
    [Assets.USDC.type, Assets.USDC.symbol],
    [Assets.WBTC.type, Assets.WBTC.symbol],
]);