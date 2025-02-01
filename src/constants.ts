export const IS_DEV = [
  "local", //
  "development",
  "test",
].includes(process.env.NODE_ENV!);
export const IS_PROD = process.env.NODE_ENV! === "production";
export const IS_LOCAL = process.env.NODE_ENV! === "local";
