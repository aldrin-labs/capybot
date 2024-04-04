# Capy Trading Bot

This repository contains simple DeFi bots in Typescript, which are designed to find and take advantage of arbitrage opportunities in different SUI DEXs and/or perform trading activities based on script-logic strategies. Since it is still in BETA version, the agents might not be profitable and are mainly open-sourced as a reference implementation that could be reused to implement custom strategies.

## Features

-   Implements a basic `Strategy` interface (developers can implement their own strategies).
-   Provides three basic trading strategies as reference implementations (described later in this Readme).
-   Automatically executes trades when it finds profitable opportunities.
-   Supports multiple cryptocurrencies and trading pairs; currently supporting trading on three Sui DEXs.
-   Supports receiving data from multiple sources, including swap pools and external sources like Binance. Currently, the bot utilizes feeds from [CCTX (CryptoCurrency eXchange Trading Library)](https://github.com/ccxt/ccxt) to get the latest prices from Binance. Note that CCTX supports Binance, Bitget, Coinbase, Kraken, KuCoin and OKX, and it is straight-forward to accept feeds from these CEXs as well.

## Overview

In Capy Trading Bot, **strategies** subscribe to relevant **data sources** and create **trade orders** based on the information they get. Every second, Capy Trading Bot requests new data points from each data source. When it receives a new data point, Capy Trading Bot sends it to subscribing strategies which return trade orders to Capy Trading Bot. Capy Trading Bot submits transactions to the relevant swap pools modules to execute these trade orders. If a strategy returns multiple trade orders, Capy Trading Bot submits them as a single transaction.

```mermaid
sequenceDiagram
    Strategy->>Capybot: Subscribe to relevant data sources
    activate Capybot
    loop Every second for each data source
        Capybot->>+DataSource: Request new data point
        DataSource->>DataSource: Call external API
        DataSource->>-Capybot: New data point
        loop For each subscribing strategy
            Capybot->>+Strategy: New data point
            Strategy->>-Capybot: Trade orders
            Capybot->>Capybot: Submit trade orders as a single transaction block
        end
    end
    deactivate Capybot
```

## Strategies

Capy Trading Bot supports the following three trading strategies:

-   `Arbitrage`: This strategy looks for [arbitrage opportunities](https://en.wikipedia.org/wiki/Triangular_arbitrage) in chains of two or more swap pools across different DEXs. It computes the product of the prices along the chain of swap pools, say SUI -> USDC -> CETUS -> SUI, and if the product is different from 1 it means there is an arbitrage opportunity.
-   `RideTheTrend`: This strategy looks for [trend following](https://en.wikipedia.org/wiki/Trend_following) opportunities in a single swap pool by comparing a short moving average with a longer moving average to get an indication whether the price is going up or down.
-   `MarketDifference`: This strategy compares the relative price of a token pair in a swap pool with the price of the same pair on an exchange, such as Binance. If the price differs, the strategy suggests to either go long or short a given token.

Strategies are located in the `src/strategies` folder, and each strategy extends the `Strategy` class which requires the
`evaluate` method to be implemented. The `evaluate` method is called every second with the latest data point from the
data sources and should return a (potentially empty) array of trade orders.

To add other strategies, you can implement them as described above and add it to Capy Trading Bot by calling `capybot.addStrategy` in `src/index.ts`.

## Data sources

Capy Trading Bot can leverage two different types of data sources: Swap pools and external sources. Capy Trading Bot can execute trades via swap pools, and swap pools provide the current token price in the pool. External data sources can provide additional data that could be useful inputs to trading strategies.

In this release, Capy Trading Bot supports swap pools from [Cetus](https://www.cetus.zone/), [Turbos](https://turbos.finance/) and
[Suiswap](https://suiswap.app/app/), and uses Binance (via [CCTX](https://github.com/ccxt/ccxt)) as an external data source for the relative prices of some token pairs.

## Installation

1. Clone this repository.
2. Install dependencies with `yarn install`.

## Usage

### Set environment variables

Before you run the script, environment variables need to be set: an `ADMIN_PHRASE` and an `ADMIN_ADDRESS` for **each** pool
being traded on.

Note that **each** pool require a **unique** phrase/address combination, which must not be shared
between pools.

If they are shared, it is possible that a concurrent submission of multiple transactions using the same e.g. gas
object may lock that object until the end of the current epoch, causing any of the bot's future transactions
to fail at the execution stage.

Note that in the case of RAMM pools, which support more than 2 assets, a phrase and an address need to be set for each
separate instance of `Pool`:

-   If a `SUI/USDC/USDT` pool is being used twice
    -   once for its `SUI/USDC` pair, and
    -   once again for its `SUI/USDTR` pair
        there must be a total of 2 phrases/address pairs, one pair for each of the above pools.

The `ADMIN_PHRASE` is the passphrase for the keypair a certain pool will use when trading, and its
corresponding `ADMIN_ADDRESS` will then be the hexadecimal address of its account.

They can be exported with the following commands in the terminal:

```shell
export ADMIN_PHRASE="your_passphrase_here"
export ADMIN_ADDRESS="your_address_here"
```

If on Unix-like operating systems, usage of [`direnv`](https://direnv.net/) is recommended instead,
with an `.envrc` file at the root of the `capybot` repository defining phrase/address pairs for
every pool to be used.

This step is **not** sufficient, **and** necessary for the bot to work.

### Declare Pools

On the following snippet of pseudo-code, 3 pools are declared

```typescript
const USDCtoSUI = new Pool('0x0...1', coins.USDC, coins.SUI)

const USDTtoSUI = new Pool('0x0...2', coins.USDT, coins.SUI)

const USDCtoUSDT = new Pool('0x0...3', coins.USDC, coins.USDT)
```

### Add a triangular arbitrage strategy

To execute a triangular arbitrage strategy, a trader makes 3 transactions:
first, exchange the original token for another one (i.e. SUI -> USDC);
second, swap the second token for a third one (i.e. USDC -> USDT); and
third, trade the third token back to the original one (i.e. USDT -> SUI).

On the following snippet of code we add a triangular arbitrage strategy to the capybot.

```typescript
// Add triangular arbitrage strategy: USDC/SUI -> (USDT/SUI)^-1 -> (USDC/USDT)^-1.
capybot.addStrategy(
    new Arbitrage(
        [
            {
                pool: SUItoUSDC.uri,
                a2b: true,
            },
            {
                pool: USDCtoUSDT.uri,
                a2b: true,
            },
            {
                pool: USDTtoSUI.uri,
                a2b: true,
            },
        ],
        defaultAmount[coins.SUI],
        ARBITRAGE_RELATIVE_LIMIT,
        'Arbitrage: SUI -> USDC -> USDT -> SUI'
    )
)
```

`ARBITRAGE_RELATIVE_LIMIT` represents the relative limit. e.g. 1.05 for a 5% win.

### Add a ride the trend strategy

Ride the trend strategy is a trading technique that involves following the direction of the market movement and staying in a position until the trend reverses. The idea is to capture as much profit as possible from a strong and sustained price movement.
To apply this strategy, traders need to identify the trend using technical indicators, such as moving averages and enter a trade when the price confirms the trend.

On the following snippet of code, we add a Ride The Trend strategy to the capybot.

```typescript
capybot.addStrategy(
    new RideTheTrend(
        SUItoUSDC.uri,
        5,
        10,
        [
            defaultAmount[SUItoUSDC.coinTypeA],
            defaultAmount[SUItoUSDC.coinTypeB],
        ],
        RIDE_THE_THREAD_LIMIT,
        'RideTheTrend (SUI/USDC)'
    )
)
```

It takes six parameters as input:

-   pool: The address of the pool to watch.
-   short: The length of the short moving average (in seconds).
-   long: The length of the long moving average (in seconds).
-   defaultAmounts: An array of two numbers, representing the amount of tokens to swap of coin type A and B respectively when the trend changes.
-   limit: A number between 0 and 1, representing the percentage of profit or loss to accept before executing a swap. For example, 1.05 means a 5% profit margin.
-   name: A human-readable name for this strategy.

It calculates the moving averages of the pool price and it then compares the short and long moving averages to determine the trend direction. When the trend changes, it executes a swap, with the specified swap amounts and relative limit.

### Market Difference

The bot can also use external data sources. For example, if there is a price discrepancy between Binance and a SUI DEX, the bot can arbitrage by buying/selling tokens on the DEX.

On the following snippet of code, we create a new market difference strategy. This strategy compare prices between a pool and various exchanges and will buy the token that is too cheap and sell the token that is too expensive.

```typescript
capybot.addStrategy(
    new MarketDifference(
        WBTCtoUSDC,
        'BinanceBTCtoUSDC',
        [defaultAmount[coins.WBTC], defaultAmount[coins.USDC]],
        ARBITRAGE_RELATIVE_LIMIT,
        'Market diff: (W)BTC/USDC, Binance vs DEX'
    )
)
```

The following parameters are required:

-   pool: The pool to monitor for price changes.
-   exchange: The exchange to compare with the pool. It should offer the same trading pairs as the pool.
-   defaultAmounts: The default amounts of tokens to trade when the price difference exceeds the limit.
-   limit: The relative threshold for the price difference. A trade will be executed if the price difference is greater than this value.
-   For example, a value of 1.05 means that the price difference should be at least 5%.
-   name: A human-readable name for this strategy.

## Build and Run the Bot

Build the project with `yarn build`

Run the script with `yarn start`

This will run the bot for one hour.

To run the bot for longer, the `duration` value, in the call to `capybot.loop` in `src/index.ts`, must be changed.

## Monitoring

The Capybot Monitor is a collection of Python scripts to monitor the status of a running instance of a Capybot. It produces live updated plots like the following which shows the price development for the swap pools the given Capybot was trading where 1 is the price when the bot was started.

<img src="./images/pools.png" alt="pools">

Installation instructions are available on the [Capybot Monitor repository](https://github.com/aldrin-labs/capybot-monitor).

## Pools

The table below lists all the pools for the currently supported DEXs:

| DEX   | Coin A - CoinB | Pool                                                               |
| ----- | -------------- | ------------------------------------------------------------------ |
| CETUS | USDT - USDC    | 0xc8d7a1503dc2f9f5b05449a87d8733593e2f0f3e7bffd90541252782e4d2ca20 |
|       | SUI - USDC     | 0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630 |
|       | CETUS - SUI    | 0x2e041f3fd93646dcc877f783c1f2b7fa62d30271bdef1f21ef002cebf857bded |
|       | WETH - USDC    | 0x5b0b24c27ccf6d0e98f3a8704d2e577de83fa574d3a9060eb8945eeb82b3e2df |
|       | SUI - USDT     | 0xa96b0178e9d66635ce3576561429acfa925eb388683992288207dbfffde94b65 |
|       | WSOL - SUI     | 0x014abe87a6669bec41edcaa95aab35763466acb26a46d551325b07808f0c59c1 |
| RAMM  | SUI - USDT     | 0xcb6640194b37023f6bed705f40ff22883eb6007d4c69e72c317c64671f9f6b29 |
|       | SUI - USDC     | 0xcb6640194b37023f6bed705f40ff22883eb6007d4c69e72c317c64671f9f6b29 |

## Contributing

Contributions are welcome! Please open an issue or pull request if you have any suggestions or improvements.
