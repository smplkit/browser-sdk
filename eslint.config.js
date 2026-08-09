import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "tests/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: "error",
    },
  },
  {
    files: ["src/vendor/**"],
    rules: {
      eqeqeq: "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-var": "off",
      "prefer-const": "off",
      "prefer-rest-params": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
