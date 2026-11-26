import {
  CandlestickChart,
  CustomChart,
  ScatterChart,
} from "echarts/charts";
import {
  DataZoomSliderComponent,
  MarkAreaComponent,
} from "echarts/components";
import { use as registerModules } from "echarts/core";

registerModules([
  CandlestickChart,
  CustomChart,
  DataZoomSliderComponent,
  MarkAreaComponent,
  ScatterChart,
]);
