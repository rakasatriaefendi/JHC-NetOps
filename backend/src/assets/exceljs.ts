import { createRequire } from "node:module";

import type * as ExcelJSTypes from "../../node_modules/@excel.js/exceljs/index.js";

type ExcelJSRuntime = Readonly<{
  Workbook: typeof ExcelJSTypes.Workbook;
  ValueType: typeof ExcelJSTypes.ValueType;
}>;

export type ExcelWorkbook = ExcelJSTypes.Workbook;
export type ExcelWorksheet = ExcelJSTypes.Worksheet;

export const ExcelJS = loadExcelJS();

function loadExcelJS(): ExcelJSRuntime {
  const loaded: unknown = createRequire(import.meta.url)("@excel.js/exceljs");
  const candidate = record(loaded) && record(loaded.default) ? loaded.default : loaded;
  if (!record(candidate) || typeof candidate.Workbook !== "function" || !record(candidate.ValueType)) {
    throw new Error("XLSX runtime is unavailable");
  }
  return {
    Workbook: candidate.Workbook as typeof ExcelJSTypes.Workbook,
    ValueType: candidate.ValueType as typeof ExcelJSTypes.ValueType,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
