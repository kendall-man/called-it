import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './env';

/**
 * Anon-key client used by server components. Read-only by construction: the
 * anon role can only see the public_* views (RLS denies base tables), and no
 * code path here ever writes.
 */
export function createAnonServerClient(): SupabaseClient | null {
  const config = getSupabaseConfig();
  if (!config) return null;
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let browserClient: SupabaseClient | null = null;

/**
 * Singleton anon client for client components (Realtime subscriptions plus
 * view refetches). Null when the deploy is awaiting configuration.
 */
export function getAnonBrowserClient(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  if (browserClient) return browserClient;
  const config = getSupabaseConfig();
  if (!config) return null;
  browserClient = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return browserClient;
}
