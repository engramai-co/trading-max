import {
  CandlestickChart,
  CustomChart,
  GaugeChart,
  HeatmapChart,
  ScatterChart,
} from "echarts/charts";
import {
  DataZoomInsideComponent,
  MarkPointComponent,
  VisualMapComponent,
} from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  CustomChart,
  DataZoomInsideComponent,
  GaugeChart,
  HeatmapChart,
  MarkPointComponent,
  ScatterChart,
  VisualMapComponent,
]);
