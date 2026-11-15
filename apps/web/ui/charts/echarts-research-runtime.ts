import {
  CandlestickChart,
  CustomChart,
  GaugeChart,
  HeatmapChart,
  ScatterChart,
} from "echarts/charts";
import {
  DataZoomSliderComponent,
  MarkAreaComponent,
  MarkPointComponent,
  VisualMapComponent,
} from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  CustomChart,
  DataZoomSliderComponent,
  GaugeChart,
  HeatmapChart,
  MarkAreaComponent,
  MarkPointComponent,
  ScatterChart,
  VisualMapComponent,
]);
