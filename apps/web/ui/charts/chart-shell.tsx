"use client";

import {
  Alert,
  Box,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ChartLine, Info } from "@phosphor-icons/react";

import { ContextHelp } from "@/components/context-help";
import { useLocale } from "@/components/locale-provider";

export function ChartShell({
  ariaLabel,
  children,
  description,
  empty,
  emptyMessage,
  embedded = false,
  height = 360,
  headerAction,
  loading = false,
  title,
}: {
  ariaLabel: string;
  children: React.ReactNode;
  description?: string;
  empty?: boolean;
  emptyMessage?: string;
  embedded?: boolean;
  height?: number | string;
  headerAction?: React.ReactNode;
  loading?: boolean;
  title?: string;
}) {
  const { locale } = useLocale();

  return (
    <Paper component="section" p={embedded ? 0 : "lg"} withBorder={!embedded}>
      <Stack gap="sm">
        {title ? (
          <Group align="flex-start" justify="space-between" wrap="wrap">
            <Box style={{ flex: "1 1 32rem", minWidth: 0 }}>
              <Group align="center" gap="xs" wrap="nowrap">
                <Title order={2} size="h3">
                  {title}
                </Title>
                {description ? (
                  <ContextHelp
                    content={description}
                    label={locale === "zh" ? `${title}说明` : `About ${title}`}
                    title={title}
                  />
                ) : null}
              </Group>
            </Box>
            {headerAction}
          </Group>
        ) : null}
        {empty ? (
          <Alert
            color="gray"
            icon={<Info aria-hidden="true" size={18} />}
            title={emptyMessage ?? "No data"}
          />
        ) : loading ? (
          <Center h={height}>
            <Loader aria-label={ariaLabel} />
          </Center>
        ) : (
          <Box
            aria-label={ariaLabel}
            h={height}
            role="img"
            style={{ minWidth: 0 }}
          >
            {children}
          </Box>
        )}
        <Text c="dimmed" hiddenFrom="sm" size="xs">
          <ChartLine aria-hidden="true" size={14} /> {ariaLabel}
        </Text>
      </Stack>
    </Paper>
  );
}
