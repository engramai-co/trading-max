import { CandlestickChart, HeatmapChart } from "echarts/charts";
import { VisualMapComponent } from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  HeatmapChart,
  VisualMapComponent,
]);
