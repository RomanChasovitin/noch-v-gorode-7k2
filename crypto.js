// Shared by the browser and the build script: Web Crypto is global in both.
// The content is encrypted once with a random content key. Each accepted oath
// answer wraps that same key, so any accepted answer opens the game.

const ITERATIONS = 250000;
const encoder = new TextEncoder();

export function normalizeAnswer(answer) {
  return answer.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ');
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function answerKey(answer, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', encoder.encode(normalizeAnswer(answer)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBundle(plaintext, answers) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, plaintext));

  const keys = [];
  for (const answer of answers) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapping = await answerKey(answer, salt, ITERATIONS);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, wrapping, rawKey));
    keys.push({ salt: toBase64(salt), iv: toBase64(keyIv), key: toBase64(wrapped) });
  }

  return { header: { iterations: ITERATIONS, iv: toBase64(iv), keys }, data };
}

// Returns the raw content key, or null when the answer matches no accepted variant.
export async function unlockKey(header, answer) {
  for (const entry of header.keys) {
    const wrapping = await answerKey(answer, fromBase64(entry.salt), header.iterations);
    try {
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(entry.iv) }, wrapping, fromBase64(entry.key),
      );
      return new Uint8Array(raw);
    } catch {
      // Wrong answer for this variant: try the next one.
    }
  }
  return null;
}

export async function decryptBundle(header, data, rawKey) {
  const contentKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(header.iv) }, contentKey, data);
  return new Uint8Array(plain);
}
