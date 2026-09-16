"use client";
import { Button } from "@mantine/core";
import Link from "next/link";
import { Empty, Page, Panel, useCopy } from "@/workspace/foundation";
export default function NotFound() {
  const t = useCopy();
  return (
    <Page
      eyebrow="404"
      title={t("页面不存在", "Page not found")}
    >
      <Panel>
        <Empty
          title={t("检查页面地址", "Check the page address")}
          description={t(
            "地址可能已变更。可通过导航重新选择，或回到组合总览。",
            "The address may have changed. Choose a page from navigation or return to your portfolio.",
          )}
          action={
            <Button component={Link} href="/">
              {t("返回组合总览", "Back to overview")}
            </Button>
          }
        />
      </Panel>
    </Page>
  );
}
