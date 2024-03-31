import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519'
import { Keypair } from '@mysten/sui.js/cryptography'
import { SuiSupportedNetworks, rammSuiConfigs } from '@ramm/ramm-sui-sdk'

import { Capybot } from './capybot'
import { Coin, Assets } from './coins'
import { CetusPool } from './dexs/cetus/cetus'
import { Arbitrage } from './strategies/arbitrage'
import { RAMMPool } from './dexs/ramm-sui/ramm-sui'

// A conservative upper limit on the max gas price per transaction block in SUI
export const MAX_GAS_PRICE_PER_TRANSACTION = 4_400_000

const RIDE_THE_TREND_LIMIT = 1.000005

// Arbitrage threshold - 0.05%, or above
const ARBITRAGE_RELATIVE_LIMIT = 1.0005
// Trades should not be bigger than 0.1 of whatever asset is being traded - scaled at the moment of
// the trade to the asset's correct decimal places.
const ARBITRAGE_DEFAULT_AMOUNT = 0.1

const MARKET_DIFFERENCE_LIMIT = 1.01

/**
 * Default amount to trade, for each token. Set to approximately 0.1 USD each.
 */
export const defaultAmounts: Record<string, number> = {};
defaultAmounts[Assets.SUI.type] = 50_000_000;
defaultAmounts[Assets.USDC.type] = 100_000;
defaultAmounts[Assets.USDT.type] = 100_000;

// Setup wallet from passphrase.
const cetusUsdcSuiPhrase = process.env.CETUS_SUI_USDC_ADMIN_PHRASE
export const cetusUsdcSuiKeypair = Ed25519Keypair.deriveKeypair(cetusUsdcSuiPhrase!)

const rammUsdcSuiPhrase = process.env.RAMM_SUI_USDC_ADMIN_PHRASE
export const rammUsdcSuiKeypair = Ed25519Keypair.deriveKeypair(rammUsdcSuiPhrase!)

enum SupportedPools {
    Cetus,
    RAMM
}

type PoolData = {
    address: string,
    keypair: Keypair
}

export const poolAddresses: { [key in SupportedPools]: Record<string, PoolData> } = {
    [SupportedPools.Cetus]: {
        "SUI/USDC": {
            address: "0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630",
            keypair: cetusUsdcSuiKeypair
        }
    },
    [SupportedPools.RAMM]: {
        "SUI/USDC": {
            address: "0x4ee5425220bc12f2ff633d37b1dc1eb56cc8fd96b1c72c49bd4ce6e895bd6cd7",
            keypair: rammUsdcSuiKeypair
        }
    }
}

let capybot = new Capybot('mainnet')

const cetusUSDCtoSUI = new CetusPool(
    '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630',
    Assets.USDC,
    Assets.SUI,
    cetusUsdcSuiKeypair,
    'mainnet'
)

const rammSUItoUSDC = new RAMMPool(
    rammSuiConfigs[SuiSupportedNetworks.mainnet][0],
    '0x4ee5425220bc12f2ff633d37b1dc1eb56cc8fd96b1c72c49bd4ce6e895bd6cd7',
    Assets.SUI,
    defaultAmounts[Assets.SUI.type],
    Assets.USDC,
    rammUsdcSuiKeypair,
    'mainnet'
)

/* const rammSUItoUSDT = new RAMMPool(
    rammSuiConfigs[SuiSupportedNetworks.mainnet][0],
    '0x4ee5425220bc12f2ff633d37b1dc1eb56cc8fd96b1c72c49bd4ce6e895bd6cd7',
    coins.SUI,
    coins.USDT,
    'mainnet'
) */

capybot.addPool(cetusUSDCtoSUI, cetusUsdcSuiKeypair)
capybot.addPool(rammSUItoUSDC, rammUsdcSuiKeypair)
// TODO: fix the way `capybot` stores pool information, so that a RAMM pool with over 2 assets
// can be added more than once e.g. for its `SUI/USDC` and `SUI/USDT` pairs.
// FIXED, although the below still needs its own keypair loaded with SUI and USDT to work.
//capybot.addPool(rammSUItoUSDT)

console.log('Cetus USDC/SUI UUID: ' +  cetusUSDCtoSUI.uuid);
console.log('RAMM SUI/USDC UUID: ' + rammSUItoUSDC.uuid);

// Add arbitrage strategy: SUI/USDC -> USDC/SUI
capybot.addStrategy(
    new Arbitrage(
        [
            {
                poolUuid: cetusUSDCtoSUI.uuid,
                coinA: cetusUSDCtoSUI.coinA,
                coinB: cetusUSDCtoSUI.coinB,
                a2b: true,
            },
            {
                poolUuid: rammSUItoUSDC.uuid,
                coinA: rammSUItoUSDC.coinA,
                coinB: rammSUItoUSDC.coinB,
                a2b: true,
            }
        ],
        defaultAmounts,
        ARBITRAGE_RELATIVE_LIMIT,
        'Arbitrage: SUI -CETUS-> USDC -RAMM-> SUI'
    )
)

const oneHour = 3.6e6

// Start the bot
capybot.loop(3 * oneHour, 1000)
