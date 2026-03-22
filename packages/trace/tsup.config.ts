import { defineConfig } from "tsup";
import { baseConfig } from "../../tsup.config.base";

export default defineConfig({
  ...baseConfig,
  dts: {
    compilerOptions: {
      composite: false,
      rootDir: undefined,
      paths: {
        "@moqtap/codec": ["../codec/src/index.ts"],
        "@moqtap/codec/session": ["../codec/src/session.ts"],
      },
    },
  },
  entry: { index: "src/index.ts" },
  external: ["@moqtap/codec", "@moqtap/codec/session", "cbor-x"],
});
