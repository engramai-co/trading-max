import {
  BarChart,
  LineChart,
  PieChart,
} from "echarts/charts";
import {
  AxisPointerComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
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
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  LabelLayout,
  CanvasRenderer,
]);

export { init };
