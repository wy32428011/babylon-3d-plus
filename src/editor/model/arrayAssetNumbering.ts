/** 阵列资产编号允许保存的最大字符长度，与现有模型和定位线框编号边界一致。 */
export const ARRAY_ASSET_NUMBER_MAX_LENGTH = 128;

const ARRAY_ASSET_NUMBER_TRAILING_DECIMAL_PATTERN = /^(.*?)(\d+)$/;

/** 阵列资产编号规则解析成功结果。 */
type ArrayAssetNumberRuleParseSuccess = {
  ok: true;
  rule: string;
  placeholder: string | null;
  seed: number | null;
  seedWidth: number;
};

/** 阵列资产编号规则解析失败结果。 */
type ArrayAssetNumberRuleParseFailure = {
  ok: false;
  error: string;
};

/** 阵列资产编号规则解析结果。 */
type ArrayAssetNumberRuleParseResult = ArrayAssetNumberRuleParseSuccess | ArrayAssetNumberRuleParseFailure;

/** 阵列资产编号生成结果，失败时返回可直接展示的中文原因。 */
export type ArrayAssetNumberResult = { ok: true; value: string } | { ok: false; error: string };

/** 判断数值是否为从 1 开始的安全整数。 */
function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** 按原数字位宽补零，数值增长超过原位宽时允许自然扩展。 */
function formatDecimalWithWidth(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 校验最终编号长度并返回结构化结果。 */
function createValidatedAssetNumber(value: string): ArrayAssetNumberResult {
  if (value.length > ARRAY_ASSET_NUMBER_MAX_LENGTH) {
    return { ok: false, error: `生成后的资产编号不能超过 ${ARRAY_ASSET_NUMBER_MAX_LENGTH} 个字符。` };
  }

  return { ok: true, value };
}

/** 解析规则；空规则合法，非空规则必须且只能包含一个 `${非负十进制整数}` 占位符。 */
function parseArrayAssetNumberRule(rule: string): ArrayAssetNumberRuleParseResult {
  const normalizedRule = rule.trim();
  if (!normalizedRule) {
    return { ok: true, rule: '', placeholder: null, seed: null, seedWidth: 0 };
  }

  const validPlaceholders = [...normalizedRule.matchAll(/\$\{(\d+)\}/g)];
  const placeholderLikeTokens = [...normalizedRule.matchAll(/\$\{[^}]*\}/g)];
  const unmatchedPlaceholderStart = normalizedRule.replace(/\$\{[^}]*\}/g, '').includes('${');
  if (validPlaceholders.length !== 1 || placeholderLikeTokens.length !== 1 || unmatchedPlaceholderStart) {
    return { ok: false, error: '非空编号规则必须且只能包含一个 `${非负十进制整数}` 占位符。' };
  }

  const placeholder = validPlaceholders[0][0];
  const seedText = validPlaceholders[0][1];
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed)) {
    return { ok: false, error: '编号规则中的占位符种子必须是安全整数。' };
  }

  return {
    ok: true,
    rule: normalizedRule,
    placeholder,
    seed,
    seedWidth: seedText.length,
  };
}

/** 返回阵列资产编号规则的错误；null 表示规则合法。 */
export function getArrayAssetNumberRuleError(rule: string): string | null {
  const result = parseArrayAssetNumberRule(rule);
  return result.ok ? null : result.error;
}

/** 根据源编号末尾十进制数字生成递增编号。 */
function createNumberFromTrailingDecimal(
  prefix: string,
  trailingDecimal: string,
  copyIndex: number,
): ArrayAssetNumberResult {
  const seed = Number(trailingDecimal);
  if (!Number.isSafeInteger(seed)) {
    return { ok: false, error: '源编号末尾数字必须是安全整数。' };
  }

  const nextSeed = seed + copyIndex;
  if (!Number.isSafeInteger(nextSeed)) {
    return { ok: false, error: '源编号末尾数字递增后超过安全整数范围。' };
  }

  return createValidatedAssetNumber(prefix + formatDecimalWithWidth(nextSeed, trailingDecimal.length));
}

/**
 * 生成阵列副本资产编号。
 * copyIndex 从 1 开始；`${1}-1-1` 生成 `2-1-1`、`3-1-1`，`${001}` 生成 `002`、`003`。
 */
export function createArrayAssetNumber(
  sourceNumber: string,
  copyIndex: number,
  rule: string,
): ArrayAssetNumberResult {
  if (!isPositiveSafeInteger(copyIndex)) {
    return { ok: false, error: '阵列副本序号必须是从 1 开始的安全整数。' };
  }

  const ruleResult = parseArrayAssetNumberRule(rule);
  if (!ruleResult.ok) return ruleResult;

  if (ruleResult.placeholder !== null && ruleResult.seed !== null) {
    const nextSeed = ruleResult.seed + copyIndex;
    if (!Number.isSafeInteger(nextSeed)) {
      return { ok: false, error: '编号规则递增后的整数超过安全整数范围。' };
    }

    return createValidatedAssetNumber(
      ruleResult.rule.replace(
        ruleResult.placeholder,
        formatDecimalWithWidth(nextSeed, ruleResult.seedWidth),
      ),
    );
  }

  const normalizedSourceNumber = sourceNumber.trim();
  const trailingNumberMatch = normalizedSourceNumber.match(ARRAY_ASSET_NUMBER_TRAILING_DECIMAL_PATTERN);
  if (trailingNumberMatch) {
    return createNumberFromTrailingDecimal(trailingNumberMatch[1], trailingNumberMatch[2], copyIndex);
  }

  return createValidatedAssetNumber(normalizedSourceNumber + String(copyIndex));
}