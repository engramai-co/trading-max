import { CandlestickChart, HeatmapChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  MarkPointComponent,
  VisualMapComponent,
} from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  DataZoomInsideComponent,
  HeatmapChart,
  MarkPointComponent,
  VisualMapComponent,
]);
