/** LTTB chooses silhouette points. An additional high and low per bucket,
 * segment endpoints and named anchors preserve extremes and evidence. Raw
 * observations remain with the caller for readout, risk maths and export. */
export function sampleLine<T>(
  points: readonly T[],
  width: number,
  x: (point: T) => number,
  value: (point: T) => number | null,
  keep: (point: T) => boolean = () => false,
): readonly T[] {
  const limit = Math.max(3, Math.floor(width * 2));
  if (points.length <= limit) return points;
  const sampled: T[] = [];
  for (let start = 0; start < points.length;) {
    if (value(points[start]) == null) {
      // One null is enough to break a stroke. Known gap connectors separately
      // retain their exact endpoints; additional nulls supply no observations.
      sampled.push(points[start++]);
      while (start < points.length && value(points[start]) == null) start++;
      continue;
    }
    let end = start + 1;
    while (end < points.length && value(points[end]) != null) end++;
    const count = end - start;
    const budget = Math.max(3, Math.floor(limit * count / points.length));
    if (count <= budget) {
      for (let i = start; i < end; i++) sampled.push(points[i]);
    } else {
      const bucketCount = Math.max(1, Math.floor((budget - 2) / 3));
      const stride = (count - 2) / bucketCount;
      sampled.push(points[start]);
      let anchor = start;
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const from = start + 1 + Math.floor(bucket * stride);
        const to = start + 1 + Math.floor((bucket + 1) * stride);
        const nextTo = Math.min(end, start + 1 + Math.floor((bucket + 2) * stride));
        let sumX = 0, sumY = 0;
        for (let i = to; i < nextTo; i++) {
          sumX += x(points[i]);
          sumY += value(points[i])!;
        }
        const size = Math.max(1, nextTo - to);
        const nextX = sumX / size, nextY = sumY / size;
        const ax = x(points[anchor]), ay = value(points[anchor])!;
        let low = from, high = from, triangle = from, maxArea = -1;
        const selected = new Set<number>();
        for (let i = from; i < to; i++) {
          const point = points[i], y = value(point)!;
          if (y < value(points[low])!) low = i;
          if (y > value(points[high])!) high = i;
          if (keep(point)) selected.add(i);
          const area = Math.abs((ax - nextX) * (y - ay) - (ax - x(point)) * (nextY - ay));
          if (area > maxArea) { maxArea = area; triangle = i; }
        }
        selected.add(low); selected.add(high); selected.add(triangle);
        for (const i of [...selected].sort((a, b) => a - b)) sampled.push(points[i]);
        anchor = triangle;
      }
      sampled.push(points[end - 1]);
    }
    start = end;
  }
  return sampled;
}
