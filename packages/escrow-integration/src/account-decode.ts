const TRAILING_BYTES = / has ([0-9]+) unexpected trailing bytes$/;

export function decodeAnchorAccount<T>(data: Uint8Array, decode: (candidate: Uint8Array) => T): T {
  let candidate = data;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return decode(candidate);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const match = TRAILING_BYTES.exec(error.message);
      const countText = match?.[1];
      if (countText === undefined) throw error;
      const count = Number.parseInt(countText, 10);
      if (count <= 0 || count >= candidate.length) throw error;
      const padding = candidate.slice(candidate.length - count);
      if (padding.some((byte) => byte !== 0)) throw error;
      candidate = candidate.slice(0, candidate.length - count);
    }
  }
  return decode(candidate);
}
