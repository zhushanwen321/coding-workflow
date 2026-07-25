#!/usr/bin/env node
/**
 * 构建期脚本：预计算所有 ACTION_SCHEMA 的 schema 文本，输出到
 * dist/v1/guidance/schemas.gen.json。
 *
 * 设计原因：npm pack 只发布 dist/ 目录，运行时 src/v1/core/*.ts 源文件不存在，
 * 因此必须在 build 阶段把 schema 文本打包进产物。运行时 getSchemaText 优先读此 JSON。
 *
 * 前置条件：必须先运行 tsc，确保 dist/v1/guidance/schema-injector.js 已生成。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildSchemaGenFile } from "../dist/v1/guidance/schema-injector.js";

const target = new URL("../dist/v1/guidance/schemas.gen.json", import.meta.url);

// 确保父目录存在（tsc 已生成 dist/v1/guidance，但防御性创建更安全）。
mkdirSync(dirname(target.pathname), { recursive: true });

const schemas = buildSchemaGenFile();
writeFileSync(target, `${JSON.stringify(schemas, null, 2)}\n`, "utf-8");

console.log(`Generated ${target.pathname}`);
