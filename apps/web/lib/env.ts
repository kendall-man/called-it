/**
 * Public runtime configuration. The app MUST build and render with all of
 * these unset — every accessor returns null instead of throwing, and pages
 * degrade to an "awaiting configuration" state.
 *
 * NEXT_PUBLIC_* reads stay as literal property accesses so Next.js can inline
 * them into client bundles.
 */

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

export interface SolanaPublicConfig {
  rpcUrl: string;
  programId: string;
}

export function getSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function getSolanaConfig(): SolanaPublicConfig | null {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  const programId = process.env.NEXT_PUBLIC_TXORACLE_PROGRAM_ID;
  if (!rpcUrl || !programId) return null;
  return { rpcUrl, programId };
}
