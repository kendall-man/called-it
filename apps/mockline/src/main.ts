/**
 * Mockline boot: start the fake TxLINE server and pre-schedule the finished
 * replay match so `/replay 9001` works the moment the engine is up.
 */

import { MOCKLINE } from './constants.js';
import { createMocklineServer } from './server.js';
import { MatchStore } from './store.js';
import { FRANCE_SPAIN_SEMI } from './scripts/france-spain-20260714.js';
import { WORLDCUP_FINAL } from './scripts/worldcup-final.js';
import type { MatchScript } from './types.js';

// Default script: the REAL 2026-07-14 semifinal. The fictional worldcup-final
// stays selectable for exercising the VAR-discard machinery.
const scripts = new Map<string, MatchScript>([
  [FRANCE_SPAIN_SEMI.key, FRANCE_SPAIN_SEMI],
  [WORLDCUP_FINAL.key, WORLDCUP_FINAL],
]);

const store = new MatchStore();
store.scheduleFinished(FRANCE_SPAIN_SEMI, MOCKLINE.REPLAY_FIXTURE_ID);

const log = (message: string, context?: Record<string, unknown>): void => {
  const suffix = context === undefined ? '' : ` ${JSON.stringify(context)}`;
  // eslint-disable-next-line no-console
  console.log(`[mockline] ${message}${suffix}`);
};

const port = Number(process.env.MOCKLINE_PORT ?? MOCKLINE.DEFAULT_PORT);
const server = createMocklineServer({
  store,
  scripts,
  defaultScriptKey: FRANCE_SPAIN_SEMI.key,
  log,
});

server.listen(port, () => {
  log('up', { port });
  log(`France 0-2 Spain (the real 2026-07-14 semi) ready — in your group: /replay ${MOCKLINE.REPLAY_FIXTURE_ID}`);
  log(`schedule a live match: curl -X POST localhost:${port}/mock/schedule -d '{"inMinutes":20}'`);
  log(`status: curl localhost:${port}/mock/status`);
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
