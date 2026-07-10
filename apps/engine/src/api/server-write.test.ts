import { describe, expect, it } from 'vitest';
import * as serverWrite from './server-write.js';

describe('engine write API exports', () => {
  it('exposes quote handling without a dead direct-stake handler', () => {
    // Given the route table no longer offers direct stake mutation
    const expectedExports = ['handleQuoteRequest'];

    // When callers inspect the write boundary
    const exportedNames = Object.keys(serverWrite).sort();

    // Then only the active quote handler remains public
    expect(exportedNames).toEqual(expectedExports);
  });
});
