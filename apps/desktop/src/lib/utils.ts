import clsx, { type ClassValue } from "clsx";

export const cn = (...v: ClassValue[]) => clsx(v);

export const uid = () => crypto.randomUUID();

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function permString(mode: number | null, isDir: boolean): string {
  if (mode == null) return "";
  const chars = "rwxrwxrwx";
  let out = isDir ? "d" : "-";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
  return out;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function joinRemote(dir: string, name: string): string {
  if (!dir || dir === ".") return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function parentRemote(path: string): string {
  const t = path.replace(/\/+$/, "");
  if (t === "" && path.startsWith("/")) return "/";
  const i = t.lastIndexOf("/");
  if (i === 0) return "/";
  if (i < 0) return ".";
  return t.slice(0, i);
}

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Placeholders `{{name}}` in a snippet body, excluding built-ins (mirror of core::snippet). */
export const BUILTIN_VARS = ["host", "hostname", "port", "user", "label"];
export function customPlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g)) {
    const n = m[1];
    if (!BUILTIN_VARS.includes(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
