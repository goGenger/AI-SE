export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: normalized };
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const data = {};
  for (const line of head.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    data[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { data, body };
}
