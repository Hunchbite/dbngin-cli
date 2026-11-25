const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
};

const visible = (s: string) => s.replace(/\x1b\[\d+m/g, "");

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visible(r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i]! - visible(cell).length)))
      .join("  ")
      .trimEnd();
  return [c.dim(line(headers)), ...rows.map(line)].join("\n");
}

/** Progress and notes go to stderr so stdout stays clean for piping. */
export const note = (msg: string) => console.error(msg);

export const json = (data: unknown) => console.log(JSON.stringify(data, null, 2));
