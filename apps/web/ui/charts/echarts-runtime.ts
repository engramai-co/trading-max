import {
  BarChart,
  LineChart,
  PieChart,
} from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomInsideComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import { init, use as registerModules } from "echarts/core";
import { LabelLayout } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";

registerModules([
  BarChart,
  LineChart,
  PieChart,
  AxisPointerComponent,
  DataZoomInsideComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
  LabelLayout,
  CanvasRenderer,
]);

export { init };
