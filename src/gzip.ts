// JSON ⇄ gzip + base64 in the page (the account sync's wire format, same as the app's Rust side).

async function streamBytes(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([input as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function pack(value: unknown): Promise<string> {
  return toB64(await streamBytes(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("gzip")));
}

export async function unpack<T>(b64: string): Promise<T> {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(await streamBytes(bytes, new DecompressionStream("gzip")))) as T;
}
