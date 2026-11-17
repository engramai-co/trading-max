import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** An account's review is the review in that account's scope; earlier links keep working. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) query.append(key, item);
  }
  if (!query.has("account")) query.set("account", "A");
  if (query.get("reviewView") === "decisions") query.delete("reviewView");
  redirect("/review?" + query.toString());
}
