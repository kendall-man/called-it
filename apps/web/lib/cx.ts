/** Minimal class-name joiner (shadcn-idiom `cn` without the clsx dependency). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
