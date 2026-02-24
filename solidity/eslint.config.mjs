import MonorepoDefaults from "../eslint.config.mjs";

export default [
    ...MonorepoDefaults,
    {
        ignores: [
            "**/lib/**/*",
            "**/test/**/*",
            "**/dist/**/*",
            "**/lib/**/*",
            "**/dependencies/**/*",
            "core-utils/generated/**/*",
            "core-utils/typechain/**/*",
            ".solcover.js",
            "generate-artifact-exports.mjs",
        ],
    },
];
