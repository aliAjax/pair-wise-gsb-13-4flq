export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}¥${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function liters(n: number): string {
  return `${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} L`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function clockOf(iso: string | null): string {
  if (!iso) return "未确认";
  return timeOf(iso);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
