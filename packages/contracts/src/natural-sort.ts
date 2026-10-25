const key = (name: string): string => name.normalize('NFC').replace(/[A-Z]/g, (character) => character.toLowerCase());
const scalarCompare = (a: string, b: string): number => {
  const left = Array.from(a, (x) => x.codePointAt(0)!); const right = Array.from(b, (x) => x.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
export function naturalSort<T extends { displayName: string; inputOrdinal: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const leftKey = key(a.displayName); const rightKey = key(b.displayName);
    const left = leftKey.match(/[0-9]+|[^0-9]+/g) ?? []; const right = rightKey.match(/[0-9]+|[^0-9]+/g) ?? [];
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const x = left[i]; const y = right[i];
      if (/^[0-9]+$/.test(x) && /^[0-9]+$/.test(y)) {
        const nx = x.replace(/^0+/, '') || '0'; const ny = y.replace(/^0+/, '') || '0';
        const comparison = nx.length - ny.length || scalarCompare(nx, ny); if (comparison) return comparison;
      } else { const comparison = scalarCompare(x, y); if (comparison) return comparison; }
    }
    return left.length - right.length || scalarCompare(leftKey, rightKey) || a.inputOrdinal - b.inputOrdinal;
  });
}
