// Version ordering, on its own so the read side (and the Worker bundle) need not import the ingest pipeline.
export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
