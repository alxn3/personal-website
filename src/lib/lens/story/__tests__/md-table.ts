/** One fixed-width table for the generated maps, columns right-aligned and
 *  sized to their widest cell. */
export function asTable(head: string[], rows: string[][]): string {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padStart(w[i]))
      .join("  ")
      .trimEnd();
  return [
    line(head),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map(line),
  ].join("\n");
}
