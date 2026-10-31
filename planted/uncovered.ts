// Planted for #60: uncovered new code, to watch the SonarCloud gate fail. Reverted before merge.
export function plantedOne(n: number): number {
  if (n > 10) {
    return n * 2;
  }
  if (n < -10) {
    return n * 3;
  }
  return n + 1;
}

export function plantedTwo(s: string): string {
  if (s.length > 5) {
    return s.toUpperCase();
  }
  if (s.startsWith('x')) {
    return s.slice(1);
  }
  return s.toLowerCase();
}
