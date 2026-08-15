import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getVersion(): string {
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgPath), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
