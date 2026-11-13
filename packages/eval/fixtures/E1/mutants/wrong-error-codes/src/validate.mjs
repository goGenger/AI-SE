// 输入校验：title（1–100 码点，trim 后判定）与 dueDate（YYYY-MM-DD 真实日期）。

export function validateTitle(value) {
  if (typeof value !== "string") {
    return { ok: false };
  }
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > 100) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDueDate(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return { ok: false };
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? { ok: true, value } : { ok: false };
}
