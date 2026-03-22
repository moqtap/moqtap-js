import { defineConfig } from "tsup";
import { baseConfig } from "../../tsup.config.base";

export default defineConfig({
  ...baseConfig,
  dts: { compilerOptions: { composite: false } },
  sourcemap: false,
  entry: {
    index: "src/index.ts",
    session: "src/session.ts",
    draft7: "src/drafts/draft07/index.ts",
    "draft7-session": "src/drafts/draft07/session.ts",
    draft14: "src/drafts/draft14/index.ts",
    "draft14-session": "src/drafts/draft14/session.ts",
  },
});
