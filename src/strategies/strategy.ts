import { DataPoint } from "../data_sources/data_point"
import { TradeOrder } from "./order"
import { Md5 } from "ts-md5"
import { logger } from "../logger"

export abstract class Strategy {
    public readonly uri: string
    private parameters: unknown

    protected constructor(parameters: unknown) {
        this.parameters = parameters
        // Generate short unique identifier for this strategy
        this.uri = Md5.hashAsciiStr(JSON.stringify(parameters))
    }

    /**
     * Outcome of evaluation.
     *
     * Given a data point, the strategy evaluates it and returns a list of trade orders to be
     * executed contigent on that datum.
     *
     * After some refactorings, the `Arbitrage` strategy - the only one that is relevant at the
     * moment - already scales each trade order's amount to the asset's correct decimal places.
     *
     * All other strategies are not up tp date, and should be used with care.
     *
     *The a2b parameter indicates whether coin A should be swapped for coin B, or vice-versa.
     *
     * Return values of null or an empty list mean that no trade should done.
     *
     * @param data The data to evaluate.
     */
    abstract evaluate(data: DataPoint): Array<TradeOrder>

    /**
     * The pools and coin types this pool needs information from.
     */
    abstract subscribes_to(): Array<string>

    /**
     * Report key statistics to the logger.
     * @param status A map of key-value pairs to report.
     * @protected
     */
    protected logStatus(status: Record<string, number>): void {
        logger.info(
            {
                uri: this.uri,
                data: status,
            },
            "strategy status"
        )
    }
}
