/** 仅识别 ASCII C0 控制码（U+0000 到 U+001F），不包含 DEL 或 C1。 */
export function containsAsciiControlCharacters(value: string): boolean {
  return containsAsciiControlCharactersOr(value, '');
}

/** 混合路径字符校验共用一次扫描，避免拆分表达式后重复读取调用方属性。 */
export function containsAsciiControlCharactersOr(value: string, additionalCharacters: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32 || additionalCharacters.includes(value[index])) return true;
  }
  return false;
}

/** replacement 按字面文本替换每个 C0 码元；路径规范化调用固定使用下划线。 */
export function replaceAsciiControlCharacters(value: string, replacement: string): string {
  let result = '';
  let previousEnd = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) >= 32) continue;
    result += value.slice(previousEnd, index) + replacement;
    previousEnd = index + 1;
  }
  return previousEnd === 0 ? value : result + value.slice(previousEnd);
}

/** glTF/GLB JSON 仅剥除实际末尾的 NUL 或空格，保留其他空白与换行。 */
export function trimTrailingNullAndSpaceCharacters(value: string): string {
  let end = value.length;
  while (end > 0 && (value.charCodeAt(end - 1) === 0 || value.charCodeAt(end - 1) === 32)) end--;
  return end === value.length ? value : value.slice(0, end);
}
