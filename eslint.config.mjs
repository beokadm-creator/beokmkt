import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 신규 strict 룰: 흔한 로딩 패턴(useEffect 내 setLoading 등)까지 에러로 막는다.
  // 빌드를 차단하지 않도록 경고로 낮추되, 가시성은 유지(추후 점진 리팩터링).
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // 설정 파일은 CommonJS(require)·익명 default export 관례를 허용.
  {
    files: ["**/*.config.js", "**/*.config.cjs", "**/*.config.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "import/no-anonymous-default-export": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 빌드 산출물·외부 런타임은 lint 대상에서 제외(감사 후속)
    "dist/**",
    "coverage/**",
    "node_modules/**",
    "functions/**",          // Cloud Functions(별도 런타임/설정)
    "server/**",             // SSR 빌드 산출물
    "executors/**",          // Node 워커(.mjs, 자체 node --check로 검증)
    "scripts/**",
    "blog_publisher/**",     // Python
    "**/*.min.js",
  ]),
]);

export default eslintConfig;
