import { createClient } from '@supabase/supabase-js';
import type { AuthClient } from '../auth/AuthGate';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required.');
}

const supabase = createClient(url, anonKey);

export const authClient: AuthClient = {
  auth: {
    getSession: () => supabase.auth.getSession(),
    onAuthStateChange: (callback) => supabase.auth.onAuthStateChange(callback),
    signInWithOtp: (input) => supabase.auth.signInWithOtp(input),
    signOut: () => supabase.auth.signOut(),
  },
  ownerProfiles: {
    findByOwnerId: async (ownerId) => supabase
      .from('owner_profiles')
      .select('owner_id')
      .eq('owner_id', ownerId)
      .maybeSingle(),
  },
};

// Sensitive narrative Edge Function calls are intentionally reserved for a
// same-origin /api/narrative/* Vercel proxy in a later task. The browser never
// receives a service role, provider, GitHub, or model credential.
