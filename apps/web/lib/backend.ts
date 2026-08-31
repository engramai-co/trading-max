import "server-only";

export function backendUrl() {
  return process.env.PORTFOLIO_BACKEND_URL?.replace(/\/+$/, "") ?? null;
}

export async function backendFetch(pathname: string, init?: RequestInit) {
  const baseUrl = backendUrl();
  if (!baseUrl) {
    throw new Error("PORTFOLIO_BACKEND_URL is not configured");
  }
  const headers = new Headers(init?.headers);
  const token = process.env.PORTFOLIO_BACKEND_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    cache: "no-store",
    headers,
  });
}
