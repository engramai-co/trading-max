// Explicit URL presentation. Ordinary browser routes never opt in via cookies,
// user-agent detection or a persistent preference.
const pages = new Set(["", "holdings", "analytics", "research", "review", "account-analysis", "settings", "activity", "imports"]);
export function desktopPage(pathname: string): string | null {
  if (pathname !== "/desktop" && !pathname.startsWith("/desktop/")) return null;
  const page = pathname.slice("/desktop".length).replace(/^\//, "");
  return pages.has(page) ? page : null;
}
export function auxiliaryPage(pathname: string): string | null {
  const page = desktopPage(pathname);
  return page && ["settings", "activity", "imports"].includes(page) ? page : null;
}
export function presentationLink(pathname: string, href: string) {
  if (desktopPage(pathname) === null || !href.startsWith("/") || href.startsWith("//")) return { href, separate: false };
  const url = new URL(href, "https://workspace.invalid");
  let page = url.pathname.slice(1);
  if (page === "health") page = "activity";
  if (page.startsWith("desktop/")) page = page.slice(8);
  if (page === "desktop") page = "";
  if (!pages.has(page)) return { href, separate: false };
  const target = "/desktop" + (page ? "/" + page : "");
  const currentSurface = auxiliaryPage(pathname);
  const targetSurface = auxiliaryPage(target);
  return { href: target + url.search + url.hash, separate: currentSurface !== targetSurface };
}
