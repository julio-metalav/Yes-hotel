/**
 * Comparação em tempo constante de duas strings (UTF-8).
 * Não vaza comprimento via early-return no conteúdo; ainda compara até o maior length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  const len = Math.max(aBuf.length, bBuf.length);
  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < len; i += 1) {
    const av = i < aBuf.length ? aBuf[i]! : 0;
    const bv = i < bBuf.length ? bBuf[i]! : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}
