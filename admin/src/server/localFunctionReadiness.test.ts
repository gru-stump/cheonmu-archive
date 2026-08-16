/** @vitest-environment node */

import { afterEach, describe, expect, it } from 'vitest';
import { startFakeProviderFunctions } from '../../e2e/localOwnerHarness';

const realFetch = globalThis.fetch;

describe('local function readiness', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('ignores an unrelated gateway 403 until the new worker child serves a closed probe', async () => {
    let sawClosedWorkerProbe = false;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/functions/v1/run-schedules') && init?.method === 'OPTIONS') {
        return new Response(null, { status: 403 });
      }
      if (url.endsWith('/functions/v1/run-generation-worker') && (init?.method ?? 'GET') === 'GET') {
        sawClosedWorkerProbe = new Headers(init?.headers).get('connection') === 'close';
      }
      return realFetch(input, init);
    };

    const functions = await startFakeProviderFunctions();
    try {
      expect(sawClosedWorkerProbe).toBe(true);
    } finally {
      await functions.stop();
    }
  });
});
