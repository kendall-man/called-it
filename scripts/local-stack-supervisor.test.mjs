import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { superviseStack } from './local-stack-supervisor.mjs';

const child = () => Object.assign(new EventEmitter(), {
  signals: [],
  kill(signal) { this.signals.push(signal); },
});

test('stack supervisor stops the sibling when one process exits unexpectedly', () => {
  const engine = child();
  const web = child();
  const exitCodes = [];
  superviseStack([engine, web], { onUnexpectedExit: (code) => exitCodes.push(code) });

  engine.emit('exit', 7, null);

  assert.deepEqual(engine.signals, []);
  assert.deepEqual(web.signals, ['SIGTERM']);
  assert.deepEqual(exitCodes, [7]);
});
