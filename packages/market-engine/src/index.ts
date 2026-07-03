/**
 * @calledit/market-engine — the pure deterministic core.
 * No I/O, no clocks: time flows in via event timestamps and explicit params.
 */
export * from './types.js';
export * from './constants.js';
export { compileClaim } from './compile.js';
export {
  priceSpec,
  poissonPmf,
  poissonCdf,
  poissonSurvival,
  lambdaFromTotalsLine,
} from './price.js';
export { evaluateSpec, isPeriodComplete } from './evaluate.js';
export {
  reduceMarket,
  checkDebounce,
  type ReducerScratch,
  type ReducibleMarketState,
} from './reduce.js';
