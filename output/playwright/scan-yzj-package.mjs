import { scanModelPackage } from "../../dist-electron/ipc/modelPackageScanner.js";

const EXPECTED_KEYS = [
  "chainLength",
  "platformLength",
  "platformPosition",
  "chainWidth",
  "chainHeight",
  "rollerWidth",
  "rollerPosition",
  "rollerDensity",
  "infeedSide",
  "outfeedSide",
  "showFrontSupport",
  "showRearSupport",
];

/** 扫描 YZJ 模型包并验证编辑器实际读取到的参数契约。 */
const result = await scanModelPackage("F:/3d-models/models/YZJ");
const asset = result.asset;
const parameterKeys = asset?.parameterConfig?.parameters?.map((item) => item.key) ?? [];
const failures = [];

if (!asset) failures.push(result.skipped?.reason ?? "模型包扫描未返回资产");
if (asset?.displayName !== "一体式顶升移载") failures.push(`显示名异常：${asset?.displayName ?? "<empty>"}`);
if (asset?.defaultAssetCode !== "YZJ01") failures.push(`默认资产编号异常：${asset?.defaultAssetCode ?? "<empty>"}`);
if (JSON.stringify(parameterKeys) !== JSON.stringify(EXPECTED_KEYS)) failures.push(`参数顺序异常：${parameterKeys.join(",")}`);
if ((asset?.scriptAssets?.length ?? 0) !== 1) failures.push(`脚本数量异常：${asset?.scriptAssets?.length ?? 0}`);
if (parameterKeys.includes("showDirectionArrow") || parameterKeys.includes("directionArrowImage")) failures.push("模型包仍包含方向箭头参数");

const report = {
  ok: failures.length === 0,
  failures,
  displayName: asset?.displayName,
  defaultAssetCode: asset?.defaultAssetCode,
  sourcePath: asset?.path,
  lengthUnit: asset?.lengthUnit,
  unitScaleToMeters: asset?.unitScaleToMeters,
  scriptAssets: asset?.scriptAssets?.map((item) => item.name) ?? [],
  parameterKeys,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;