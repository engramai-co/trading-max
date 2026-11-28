"use client";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { documentTitle, useDocumentTitle } from "@/workspace/document-title";
import { Empty, Page, Panel, useCopy } from "@/workspace/foundation";

export default function NotFound() {
  const t = useCopy();
  const title = t("页面不存在", "Page not found");
  useDocumentTitle(documentTitle(title), "status");
  return (
    <Page
      className="mx-not-found"
      eyebrow="404"
      title={title}
    >
      <Panel>
        <Empty
          headingLevel={2}
          title={t("检查页面地址", "Check the page address")}
          description={t(
            "地址可能已变更。可通过导航重新选择，或回到组合总览。",
            "The address may have changed. Choose a page from navigation or return to your portfolio.",
          )}
          action={
            <Link href="/" data-slot="button" className={buttonVariants()}>
              {t("返回组合总览", "Back to overview")}
            </Link>
          }
        />
      </Panel>
    </Page>
  );
}
