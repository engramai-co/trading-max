"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useLocale } from "@/components/locale-provider";
import { paddedPriceDomain } from "@/lib/chart-domain";
import { money } from "@/lib/format";
import type { OptionSnapshot } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import { useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

export function OptionsGammaChart({ option }: { option: OptionSnapshot }) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const points = option.gammaProfile;
  const optionConfig = useMemo<EChartsOption | null>(() => {
    if (points.length < 2) return null;
    const priceDomain = paddedPriceDomain([
      ...points.map((point) => point.spot),
      option.spot,
      option.callWall,
      option.putWall,
      option.maxPain,
      option.gammaFlip,
    ]);
    if (!priceDomain) return null;

    const referenceLines = [
      {
        label: {
          color: chartColours.brandDark,
          formatter: locale === "zh" ? "现价" : "Spot",
          position: "insideEndTop" as const,
        },
        lineStyle: { color: chartColours.brandDark, type: "solid" as const },
        xAxis: option.spot,
      },
      ...(option.gammaFlip == null
        ? []
        : [{
            label: {
              color: chartColours.secondary,
              formatter: "Gamma flip",
              position: "insideEndTop" as const,
            },
            lineStyle: {
              color: chartColours.secondary,
              type: "dashed" as const,
            },
            xAxis: option.gammaFlip,
          }]),
      ...(option.maxPain == null
        ? []
        : [{
            label: {
              color: chartColours.warning,
              formatter: "Max pain",
              position: "insideEndTop" as const,
            },
            lineStyle: {
              color: chartColours.warning,
              type: "dashed" as const,
            },
            xAxis: option.maxPain,
          }]),
      ...(option.callWall == null
        ? []
        : [{
            label: {
              color: chartColours.positive,
              formatter: "Call wall",
              position: "insideEndTop" as const,
            },
            lineStyle: {
              color: chartColours.positive,
              type: "dotted" as const,
            },
            xAxis: option.callWall,
          }]),
      ...(option.putWall == null
        ? []
        : [{
            label: {
              color: chartColours.negative,
              formatter: "Put wall",
              position: "insideEndTop" as const,
            },
            lineStyle: {
              color: chartColours.negative,
              type: "dotted" as const,
            },
            xAxis: option.putWall,
          }]),
    ];

    return {
      animation: false,
      grid: { bottom: 12, containLabel: true, left: 12, right: 12, top: 30 },
      series: [{
        areaStyle: { color: `${chartColours.brand}18` },
        data: points.map((point) => [point.spot, point.netGex]),
        lineStyle: { color: chartColours.brand, width: 2 },
        markLine: {
          data: [
            {
              label: {
                show: false,
              },
              lineStyle: {
                color: chartColours.axis,
                opacity: 0.7,
                type: "dashed",
              },
              yAxis: 0,
            },
            ...referenceLines,
          ],
          silent: true,
          symbol: "none",
        },
        name: "Net GEX",
        showSymbol: false,
        type: "line",
      }],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        formatter: (params: unknown) => {
          const entries = params as Array<{ value: [number, number] }>;
          const [spot, netGex] = entries[0].value;
          return `${money(spot, "USD", 2)}<br/>Net GEX ${new Intl.NumberFormat(
            "en-GB",
            { maximumFractionDigits: 0 },
          ).format(netGex)}`;
        },
        textStyle: { color: chartColours.canvas },
        trigger: "axis",
      },
      xAxis: {
        axisLabel: {
          color: chartColours.axis,
          formatter: (value: number) => money(value, "USD", 0),
        },
        splitLine: {
          lineStyle: { color: chartColours.grid, type: "dashed" },
        },
        max: priceDomain[1],
        min: priceDomain[0],
        scale: true,
        type: "value",
      },
      yAxis: {
        axisLabel: {
          color: chartColours.axis,
          formatter: (value: number) =>
            new Intl.NumberFormat("en-GB", {
              maximumFractionDigits: 1,
              notation: "compact",
            }).format(value),
        },
        splitLine: {
          lineStyle: { color: chartColours.grid, type: "dashed" },
        },
        scale: true,
        type: "value",
      },
    };
  }, [
    chartColours,
    locale,
    option.callWall,
    option.gammaFlip,
    option.maxPain,
    option.putWall,
    option.spot,
    points,
  ]);
  const chartRef = useECharts(optionConfig);

  return (
    <ChartShell
      ariaLabel={locale === "zh" ? "Gamma 敞口曲线" : "Gamma exposure profile"}
      description={locale === "zh"
        ? "横轴显示模型价格区间、现价、期权墙、Max pain 与 Gamma flip；纵轴估算价格变动 1% 时的净 Gamma 敞口。"
        : "The x-axis shows the model price range, spot, option walls, max pain, and gamma flip. The y-axis estimates net gamma exposure for a 1% price move."}
      empty={!optionConfig}
      emptyMessage={locale === "zh" ? "暂无 Gamma 曲线" : "No gamma profile"}
      height={360}
      title={locale === "zh" ? "Gamma 敞口曲线" : "Gamma exposure profile"}
    >
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}
