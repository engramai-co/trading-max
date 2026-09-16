import {
  CandlestickChart,
  CustomChart,
  GaugeChart,
  HeatmapChart,
  ScatterChart,
} from "echarts/charts";
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  MarkPointComponent,
  VisualMapComponent,
} from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  CustomChart,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GaugeChart,
  HeatmapChart,
  MarkPointComponent,
  ScatterChart,
  VisualMapComponent,
]);
