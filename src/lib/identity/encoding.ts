export const utf8 = new TextEncoder();
export const text = new TextDecoder('utf-8', { fatal: true });
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export function encode(value: ArrayBuffer | Uint8Array): string {
  return btoa(
    Array.from(new Uint8Array(value), (b) => String.fromCharCode(b)).join(''),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function decode(value: unknown, size?: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > 90000 ||
    !/^[\w-]+$/.test(value)
  )
    throw new Error('Invalid encoding.');
  const bytes = Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0),
  );
  if (encode(bytes) !== value || (size !== undefined && bytes.length !== size))
    throw new Error('Invalid encoding or size.');
  return bytes;
}
export function fields(
  value: unknown,
  keys: string[],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw new Error('Unsupported or malformed format.');
}
export function portable(prefix: string, value: unknown): string {
  return prefix + encode(utf8.encode(JSON.stringify(value)));
}
export function payload(input: string): string {
  if (input.length > 92000) throw new Error('Payload too large.');
  const value = input.trim();
  return value.includes('#') ? value.slice(value.indexOf('#') + 1) : value;
}
export function parse(prefix: string, input: string, max: number): unknown {
  const value = payload(input);
  if (!value.startsWith(prefix) || value.length > max)
    throw new Error('Unsupported format or payload too large.');
  return JSON.parse(text.decode(decode(value.slice(prefix.length))));
}
export async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return encode(await crypto.subtle.digest('SHA-256', bytes));
}
export function link(value: string, base = location.href): string {
  const url = new URL(base);
  url.search = '';
  url.hash = value;
  return url.href;
}
export const fingerprint = (id: string) =>
  Array.from(decode(id), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{1,4}/g)!
    .join(' ');
