module.exports = {
  apps: [
    {
      name: "hptourism-stg-rc3",
      script: "dist-new/index.js",
      cwd: __dirname,
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "4000",
        DATABASE_URL:
          process.env.DATABASE_URL ||
          "postgresql://postgres:postgres@localhost:5432/hptourism_stg_rc3",
        SESSION_SECRET:
          process.env.SESSION_SECRET || "hp-tourism-local-dev-secret",
        OBJECT_STORAGE_MODE: process.env.OBJECT_STORAGE_MODE || "local",
        LOCAL_OBJECT_DIR:
          process.env.LOCAL_OBJECT_DIR ||
          `${__dirname}/local-object-storage`,
        LOCAL_MAX_UPLOAD_BYTES:
          process.env.LOCAL_MAX_UPLOAD_BYTES ||
          String(20 * 1024 * 1024),
        VITE_HIMKOSH_TEST_MODE: process.env.VITE_HIMKOSH_TEST_MODE ?? "",
        HIMKOSH_MERCHANT_CODE:
          process.env.HIMKOSH_MERCHANT_CODE || "HIMKOSH230",
        HIMKOSH_DEPT_ID: process.env.HIMKOSH_DEPT_ID || "230",
        HIMKOSH_SERVICE_CODE: process.env.HIMKOSH_SERVICE_CODE || "TSM",
        HIMKOSH_DDO_CODE: process.env.HIMKOSH_DDO_CODE || "CTO00-068",
        HIMKOSH_HEAD: process.env.HIMKOSH_HEAD || "1452-00-800-01",
        HIMKOSH_TEST_MODE: process.env.HIMKOSH_TEST_MODE ?? "",
        HIMKOSH_FORCE_TEST_MODE:
          process.env.HIMKOSH_FORCE_TEST_MODE ?? "",
        HIMKOSH_RETURN_URL:
          process.env.HIMKOSH_RETURN_URL ||
          "https://pay.oispl.dev/api/himkosh/callback",
        HIMKOSH_ALLOW_DEV_FALLBACK:
          process.env.HIMKOSH_ALLOW_DEV_FALLBACK || "false",
        HIMKOSH_KEY_FILE_PATH:
          process.env.HIMKOSH_KEY_FILE_PATH ||
          `${__dirname}/server/himkosh/echallan.key`,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
    },
  ],
};
