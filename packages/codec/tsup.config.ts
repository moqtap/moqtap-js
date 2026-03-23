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
    draft8: "src/drafts/draft08/index.ts",
    "draft8-session": "src/drafts/draft08/session.ts",
    draft9: "src/drafts/draft09/index.ts",
    "draft9-session": "src/drafts/draft09/session.ts",
    draft10: "src/drafts/draft10/index.ts",
    "draft10-session": "src/drafts/draft10/session.ts",
    draft11: "src/drafts/draft11/index.ts",
    "draft11-session": "src/drafts/draft11/session.ts",
    draft12: "src/drafts/draft12/index.ts",
    "draft12-session": "src/drafts/draft12/session.ts",
    draft13: "src/drafts/draft13/index.ts",
    "draft13-session": "src/drafts/draft13/session.ts",
    draft14: "src/drafts/draft14/index.ts",
    "draft14-session": "src/drafts/draft14/session.ts",
    draft15: "src/drafts/draft15/index.ts",
    "draft15-session": "src/drafts/draft15/session.ts",
    draft16: "src/drafts/draft16/index.ts",
    "draft16-session": "src/drafts/draft16/session.ts",
    draft17: "src/drafts/draft17/index.ts",
    "draft17-session": "src/drafts/draft17/session.ts",
  },
});
