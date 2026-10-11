import { registerPlugin } from '@capacitor/core';
import { createProviderService } from '../../service/providers.js';

export const PocketNative = registerPlugin('PocketNative');

export async function openProviders(settings, http) {
  let snapshot = JSON.parse((await PocketNative.readVault()).value || '{}');
  snapshot.state ||= {}; snapshot.secrets ||= {};
  const service = createProviderService({ settings, http, allowCustomRelays: true, ids: { next: () => crypto.randomUUID() },
    state: { get: (key, fallback) => snapshot.state[key] ?? fallback, set: (key, value) => { snapshot.state[key] = value; } },
    secrets: {
      encrypt(value) { const id = `native-v1:${crypto.randomUUID()}`; snapshot.secrets[id] = value; return id; },
      decrypt(id) { if (!id) return ''; if (!(id in snapshot.secrets)) throw new Error('本机 Token 记录不存在。'); return snapshot.secrets[id]; }
    }
  });
  let tail = Promise.resolve();
  const call = (method, ...args) => {
    const operation = tail.then(async () => {
      const previous = structuredClone(snapshot);
      try {
        const result = await service[method](...args);
        const references = JSON.stringify(snapshot.state);
        for (const id of Object.keys(snapshot.secrets)) if (!references.includes(id)) delete snapshot.secrets[id];
        if (JSON.stringify(previous) !== JSON.stringify(snapshot)) await PocketNative.writeVault({ value: JSON.stringify(snapshot) });
        return result;
      } catch (error) { snapshot = previous; throw error; }
    });
    tail = operation.catch(() => {}); return operation;
  };
  return { call, generationProvider: (...args) => call('generationProvider', ...args) };
}
