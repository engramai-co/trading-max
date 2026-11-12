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
  MarkAreaComponent,
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
  MarkAreaComponent,
  MarkPointComponent,
  ScatterChart,
  VisualMapComponent,
]);
