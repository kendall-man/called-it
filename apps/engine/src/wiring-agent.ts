export function resolvePersonaTemplateKey<const Key extends string>(
  keys: readonly Key[],
  candidate: string,
): Key {
  const key = keys.find((value) => value === candidate);
  if (key === undefined) throw new Error('unknown persona template');
  return key;
}
