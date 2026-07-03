import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const files = {
  sourceScript: "F:/3d-models/models/YZJ/yzj.model.ts",
  assetScript: "F:/3d-models/models/Assets/Models/YZJ/yzj.model.ts",
  sourceMeta: "F:/3d-models/models/YZJ/meta.json",
  assetMeta: "F:/3d-models/models/Assets/Models/YZJ/meta.json",
};

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findField(meta, key) {
  return meta.parameterScripts?.[0]?.fields?.find((field) => field.key === key);
}

function findValue(meta, key) {
  return meta.parameterScripts?.[0]?.values?.[key];
}

function findModelParameter(meta, key) {
  return meta.modelParameters?.parameters?.find((field) => field.key === key);
}

const scriptText = readFileSync(files.sourceScript, "utf8");
const sourceMeta = JSON.parse(readFileSync(files.sourceMeta, "utf8"));
const assetMeta = JSON.parse(readFileSync(files.assetMeta, "utf8"));
const forbiddenTokens = ["applyDimensionScale", "applyForkParameters", "applyShelfArray", "cloneTemplate", "forkGap"];
const forbiddenLengthTokens = ["mapProtectedLengthX", "mapLeftAnchoredLengthX", "extension / 2"];
const hasVisualLeftAnchoredBodyMap =
  scriptText.includes("mapVisualLeftAnchoredLengthX") &&
  scriptText.includes("if (x >= middleEnd) { return x; }") &&
  scriptText.includes("if (x <= middleStart) { return x - extension; }");
const hasIndependentPlatformLength =
  scriptText.includes('const platformLengthRatio = this.ratio(values, "platformLength");') &&
  scriptText.includes("this.applyPlatformParameters(platformLengthRatio, widthRatio, heightOffset);") &&
  scriptText.includes('this.scaleNodeWithAxisAnchors(platform, platformLengthRatio, 1, widthRatio, { x: "min", z: "center" });');
const hasRollerChainLength =
  scriptText.includes("this.applyRollerParameters(values, lengthRatio, heightOffset);") &&
  scriptText.includes('this.scaleNodeWithAxisAnchors(roller, lengthRatio, 1, widthRatio, { x: "min", z: "center" });');

const result = {
  scriptHashEqual: sha256(files.sourceScript) === sha256(files.assetScript),
  metaHashEqual: sha256(files.sourceMeta) === sha256(files.assetMeta),
  sourceScriptHash: sha256(files.sourceScript),
  sourceMetaHash: sha256(files.sourceMeta),
  forbiddenTokensPresent: forbiddenTokens.filter((token) => scriptText.includes(token)),
  forbiddenLengthTokensPresent: forbiddenLengthTokens.filter((token) => scriptText.includes(token)),
  leftAnchoredLengthRuntime: hasVisualLeftAnchoredBodyMap && hasRollerChainLength,
  independentPlatformLengthRuntime: hasIndependentPlatformLength,
  sourcePlatformLength: {
    field: findField(sourceMeta, "platformLength")?.configuration,
    value: findValue(sourceMeta, "platformLength")?.configuration,
    modelParameter: findModelParameter(sourceMeta, "platformLength"),
  },
  assetPlatformLength: {
    field: findField(assetMeta, "platformLength")?.configuration,
    value: findValue(assetMeta, "platformLength")?.configuration,
    modelParameter: findModelParameter(assetMeta, "platformLength"),
  },
  sourceRollerWidth: {
    field: findField(sourceMeta, "rollerWidth")?.configuration,
    value: findValue(sourceMeta, "rollerWidth")?.configuration,
    modelParameter: findModelParameter(sourceMeta, "rollerWidth"),
  },
  assetRollerWidth: {
    field: findField(assetMeta, "rollerWidth")?.configuration,
    value: findValue(assetMeta, "rollerWidth")?.configuration,
    modelParameter: findModelParameter(assetMeta, "rollerWidth"),
  },
};

console.log(JSON.stringify(result, null, 2));
