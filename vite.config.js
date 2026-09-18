import { defineConfig } from "vite";

// foxglove-ros-adapter 依赖 @foxglove/rosmsg 等，预构建一下避免 dev 首屏慢
export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    include: [
      "foxglove-ros-adapter",
      "@foxglove/rosmsg",
      "@foxglove/rosmsg2-serialization",
    ],
  },
});
