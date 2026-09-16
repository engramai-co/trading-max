"use client";
import { Button, Group } from "@mantine/core";
import Link from "next/link";
import { Empty, Page, Panel, useCopy } from "@/workspace/foundation";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useCopy();
  return (
    <Page
      title={t("这一页暂时无法显示", "This page could not be displayed")}
    >
      <Panel>
        <Empty
          title={t(
            "尝试重新加载",
            "Try reloading",
          )}
          description={t(
            "重新加载此页面，或返回总览查看其他数据。",
            "Reload this page, or return to the overview to explore other data.",
          )}
          action={
            <Group>
              <Button onClick={reset}>{t("重新加载", "Reload page")}</Button>
              <Button component={Link} href="/" variant="default">
                {t("返回总览", "Back to overview")}
              </Button>
            </Group>
          }
        />
      </Panel>
    </Page>
  );
}
