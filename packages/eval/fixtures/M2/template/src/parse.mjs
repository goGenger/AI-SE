export function parseTable(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const cells = lines.map((line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
  );
  if (cells.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = cells.filter((_, index) => index !== 1);
  return { headers, rows };
}
