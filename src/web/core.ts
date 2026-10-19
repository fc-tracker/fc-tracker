// The app's Gallery model (Rust: gallery, gallery_sets, lineup) built for WebAssembly
// (web-core/), plus the public card catalog. One JSON call per question.
import wasmUrl from "../../web-core/target/wasm32-unknown-unknown/release/fct_web_core.wasm?url";
import catalogUrl from "./catalog.json?url";

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  call(ptr: number, len: number): bigint;
}

let ready: Promise<Exports> | null = null;
/** Every points value a Gallery card can have (a chip reading outside it is a misread). */
let points = new Set<number>();
export const validPoints = () => points;

export function core(): Promise<Exports> {
  ready ??= (async () => {
    const imports = { env: { now_ms: () => Date.now() } };
    const load = () =>
      WebAssembly.instantiateStreaming(fetch(wasmUrl), imports).catch(() =>
        fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b, imports)),
      );
    const [{ instance }, catalog] = await Promise.all([load(), fetch(catalogUrl).then((r) => r.json())]);
    const ex = instance.exports as unknown as Exports;
    points = new Set((catalog.gallery as { score: number }[]).map((g) => g.score));
    callWith(ex, { fn: "load_catalog", catalog });
    return ex;
  })();
  ready.catch(() => (ready = null));
  return ready;
}

function callWith<T>(ex: Exports, req: object): T {
  const input = new TextEncoder().encode(JSON.stringify(req));
  const p = ex.alloc(input.length);
  new Uint8Array(ex.memory.buffer, p, input.length).set(input);
  const r = ex.call(p, input.length);
  ex.dealloc(p, input.length);
  const op = Number(r >> 32n), ol = Number(r & 0xffffffffn);
  const out = JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, op, ol)));
  ex.dealloc(op, ol);
  if (out.error) throw new Error(out.error);
  return out.ok as T;
}

export async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return callWith<T>(await core(), { fn, ...args });
}
