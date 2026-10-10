export function utf8Base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text) {
  let clean = String(text).replaceAll('-', '+').replaceAll('_', '/').replace(/[^A-Za-z0-9+/=]/g, '').split('=')[0];
  // Buffer's base64url decoder ignores incomplete final sextets.
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  const binary = atob(clean);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
