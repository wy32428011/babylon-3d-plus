import type { AuthoringIssue, AuthoringParameter, AuthoringProject, ParameterValue } from './types';

/** 完整闭包；导出脚本直接嵌入此函数，不另写表达式解释器。 */
export function createExpressionEvaluator() {
  type Values = Record<string, ParameterValue>;
  type Ast = { kind: 'number'; value: number } | { kind: 'name'; name: string }
    | { kind: 'unary'; op: string; child: Ast }
    | { kind: 'binary'; op: string; left: Ast; right: Ast }
    | { kind: 'call'; name: string; args: Ast[] }
    | { kind: 'conditional'; condition: Ast; yes: Ast; no: Ast };
  const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const constants: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E, true: 1, false: 0 };
  const functions: Record<string, { min: number; max: number; run: (...args: number[]) => number }> = {
    abs: { min: 1, max: 1, run: Math.abs }, ceil: { min: 1, max: 1, run: Math.ceil },
    floor: { min: 1, max: 1, run: Math.floor }, round: { min: 1, max: 1, run: Math.round },
    sqrt: { min: 1, max: 1, run: Math.sqrt }, sign: { min: 1, max: 1, run: Math.sign },
    min: { min: 1, max: 32, run: Math.min }, max: { min: 1, max: 32, run: Math.max },
    pow: { min: 2, max: 2, run: Math.pow }, sin: { min: 1, max: 1, run: Math.sin },
    cos: { min: 1, max: 1, run: Math.cos }, tan: { min: 1, max: 1, run: Math.tan },
    clamp: { min: 3, max: 3, run: (value, min, max) => {
      if (min > max) throw new Error('clamp 的下界不能大于上界');
      return Math.max(min, Math.min(max, value));
    } },
  };
  const precedence: Record<string, number> = {
    '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
    '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8, '**': 8,
  };
  const cache = new Map<string, { ast: Ast; dependencies: string[] }>();
  const finite = (value: number): number => {
    if (!Number.isFinite(value)) throw new Error('表达式产生了非有限数值');
    return value;
  };
  function compile(expression: string) {
    if (typeof expression !== 'string' || !expression.trim()) throw new Error('表达式不能为空');
    if (expression.length > 4096) throw new Error('表达式超过 4096 字符限制');
    const cached = cache.get(expression);
    if (cached) return cached;
    const tokens: string[] = [];
    let offset = 0;
    while (offset < expression.length) {
      const text = expression.slice(offset);
      const whitespace = /^\s+/.exec(text);
      if (whitespace) { offset += whitespace[0].length; continue; }
      const match = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|&&|\|\||==|!=|<=|>=|[+\-*/%^(),!<>?:])/.exec(text);
      if (!match) throw new Error(`表达式第 ${offset + 1} 个字符不受支持`);
      tokens.push(match[0]); offset += match[0].length;
      if (tokens.length > 1024) throw new Error('表达式过于复杂');
    }
    let cursor = 0;
    const references = new Set<string>();
    const peek = () => tokens[cursor] ?? '';
    const take = (expected: string) => {
      if (tokens[cursor++] !== expected) throw new Error(`表达式缺少 ${expected}`);
    };
    function parse(minimum: number, depth: number): Ast {
      if (depth > 64) throw new Error('表达式嵌套超过 64 层');
      const token = tokens[cursor++];
      let left: Ast;
      if (token === '+' || token === '-' || token === '!') {
        left = { kind: 'unary', op: token, child: parse(7, depth + 1) };
      } else if (token === '(') {
        left = parse(0, depth + 1); take(')');
      } else if (token && /^(?:\d|\.)/.test(token)) {
        left = { kind: 'number', value: finite(Number(token)) };
      } else if (token && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !forbidden.has(token)) {
        if (peek() === '(') {
          if (!own(functions, token)) throw new Error(`不支持函数 ${token}`);
          cursor++;
          const args: Ast[] = [];
          if (peek() !== ')') {
            do {
              args.push(parse(0, depth + 1));
              if (args.length > 32) throw new Error('函数参数过多');
              if (peek() !== ',') break;
              cursor++;
            } while (true);
          }
          take(')');
          const fn = functions[token];
          if (args.length < fn.min || args.length > fn.max) throw new Error(`${token} 的参数数量不正确`);
          left = { kind: 'call', name: token, args };
        } else if (own(constants, token)) {
          left = { kind: 'number', value: constants[token] };
        } else {
          references.add(token); left = { kind: 'name', name: token };
        }
      } else {
        throw new Error(`表达式中出现非法项 ${token ?? '末尾'}`);
      }
      while (own(precedence, peek()) && precedence[peek()] >= minimum) {
        const op = tokens[cursor++];
        const right = parse(precedence[op] + (op === '^' || op === '**' ? 0 : 1), depth + 1);
        left = { kind: 'binary', op, left, right };
      }
      if (minimum === 0 && peek() === '?') {
        cursor++;
        const yes = parse(0, depth + 1); take(':');
        left = { kind: 'conditional', condition: left, yes, no: parse(0, depth + 1) };
      }
      return left;
    }
    const ast = parse(0, 0);
    if (cursor !== tokens.length) throw new Error(`表达式中有多余内容 ${peek()}`);
    const compiled = { ast, dependencies: [...references] };
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(expression, compiled);
    return compiled;
  }
  function execute(ast: Ast, values: Values): number {
    switch (ast.kind) {
      case 'number': return ast.value;
      case 'name': {
        if (!own(values, ast.name)) throw new Error(`未知参数 ${ast.name}`);
        const value = values[ast.name];
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value !== 'number') throw new Error(`参数 ${ast.name} 不是数值或布尔值`);
        return finite(value);
      }
      case 'unary': {
        const value = execute(ast.child, values);
        return ast.op === '-' ? -value : ast.op === '!' ? Number(!value) : value;
      }
      case 'conditional': return execute(ast.condition, values) ? execute(ast.yes, values) : execute(ast.no, values);
      case 'call': return finite(functions[ast.name].run(...ast.args.map(arg => execute(arg, values))));
      case 'binary': {
        const left = execute(ast.left, values);
        if (ast.op === '&&') return left ? Number(Boolean(execute(ast.right, values))) : 0;
        if (ast.op === '||') return left ? 1 : Number(Boolean(execute(ast.right, values)));
        const right = execute(ast.right, values);
        switch (ast.op) {
          case '+': return finite(left + right);
          case '-': return finite(left - right);
          case '*': return finite(left * right);
          case '/': case '%':
            if (right === 0) throw new Error('表达式不能除以零');
            return finite(ast.op === '/' ? left / right : left % right);
          case '^': case '**': return finite(Math.pow(left, right));
          case '<': return Number(left < right);
          case '>': return Number(left > right);
          case '<=': return Number(left <= right);
          case '>=': return Number(left >= right);
          case '==': return Number(left === right);
          case '!=': return Number(left !== right);
          default: throw new Error('未知表达式运算符');
        }
      }
    }
  }
  function evaluateExpression(expression: string, values: Values = {}): number {
    const compiled = compile(expression);
    // 即使某个条件分支暂未运行，未知引用也不能被隐藏到导出之后。
    for (const key of compiled.dependencies) if (!own(values, key)) throw new Error(`未知参数 ${key}`);
    return execute(compiled.ast, values);
  }
  function dependencies(expression: string): string[] { return [...compile(expression).dependencies]; }
  const colorPattern = /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i;
  function checkValue(parameter: AuthoringParameter, value: ParameterValue, label: string) {
    if (parameter.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值`);
      if (parameter.min !== undefined && value < parameter.min) throw new Error(`${label}小于下界 ${parameter.min}`);
      if (parameter.max !== undefined && value > parameter.max) throw new Error(`${label}大于上界 ${parameter.max}`);
    } else if (parameter.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
    } else if (parameter.type === 'color') {
      if (typeof value !== 'string' || !colorPattern.test(value)) throw new Error(`${label}必须是 #RGB 或 #RRGGBB 颜色`);
    } else if (parameter.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
    } else throw new Error('不支持的参数类型');
  }
  function resolveParameterValues(parameters: AuthoringParameter[]): { values: Values; issues: AuthoringIssue[] } {
    const values: Values = Object.create(null);
    const issues: AuthoringIssue[] = [];
    const definitions = new Map<string, AuthoringParameter>();
    const invalid = new Set<string>();
    const status = new Map<string, 'visiting' | 'done' | 'failed'>();
    const path: string[] = [];
    const issue = (key: string, message: string) => issues.push({ code: 'parameter.invalid', severity: 'error', parameterKey: key, message });
    if (!Array.isArray(parameters)) return { values, issues: [{ code: 'parameter.invalid', severity: 'error', message: '参数列表不合法' }] };
    for (const parameter of parameters) {
      if (!parameter || typeof parameter.key !== 'string') { issue('', '参数缺少 key'); continue; }
      const key = parameter.key;
      if (definitions.has(key)) { issue(key, `参数 ${key} 重复定义`); invalid.add(key); continue; }
      definitions.set(key, parameter);
      try {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || forbidden.has(key) || own(constants, key) || own(functions, key)) {
          throw new Error('参数 key 必须为非保留的英文标识符');
        }
        for (const bound of [parameter.min, parameter.max, parameter.step]) {
          if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw new Error('参数范围或步长不是有限数值');
        }
        if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) throw new Error('参数下界大于上界');
        if (parameter.step !== undefined && parameter.step <= 0) throw new Error('参数步长必须为正数');
        checkValue(parameter, parameter.defaultValue, '默认值');
        if (parameter.expression?.trim()) {
          if (parameter.type !== 'number' && parameter.type !== 'boolean') throw new Error('仅数值和布尔参数支持派生表达式');
          compile(parameter.expression);
        } else checkValue(parameter, parameter.value, '当前值');
      } catch (error) { invalid.add(key); issue(key, error instanceof Error ? error.message : String(error)); }
    }
    function visit(key: string): ParameterValue {
      if (!definitions.has(key)) throw new Error(`未知参数 ${key}`);
      if (invalid.has(key) || status.get(key) === 'failed') throw new Error(`依赖参数 ${key} 无效`);
      if (status.get(key) === 'done') return values[key];
      if (status.get(key) === 'visiting') throw new Error(`参数循环依赖：${[...path.slice(path.indexOf(key)), key].join(' → ')}`);
      if (path.length >= 128) throw new Error('参数依赖深度超过 128 层');
      status.set(key, 'visiting'); path.push(key);
      const parameter = definitions.get(key)!;
      try {
        let value = parameter.value;
        if (parameter.expression?.trim()) {
          for (const dependency of dependencies(parameter.expression)) visit(dependency);
          const evaluated = evaluateExpression(parameter.expression, values);
          value = parameter.type === 'boolean' ? Boolean(evaluated) : evaluated;
        }
        checkValue(parameter, value, '求值结果');
        values[key] = value; status.set(key, 'done'); return value;
      } catch (error) { status.set(key, 'failed'); throw error; }
      finally { path.pop(); }
    }
    for (const key of definitions.keys()) {
      if (invalid.has(key)) continue;
      try { visit(key); }
      catch (error) { issue(key, error instanceof Error ? error.message : String(error)); }
    }
    return { values, issues };
  }
  function validateProjectUnchecked(project: AuthoringProject): AuthoringIssue[] {
    const issues: AuthoringIssue[] = [];
    const add = (code: string, message: string, location: Partial<AuthoringIssue> = {}) => {
      issues.push({ code, severity: 'error', message, ...location });
    };
    if (!project || project.schema !== 'zending.parametric-authoring' || project.version !== 1) {
      add('project.schema', '不支持的参数化工程格式'); return issues;
    }
    for (const key of ['parameters', 'nodes', 'parts', 'rules', 'regions', 'layers', 'textureAssets'] as const) {
      if (!Array.isArray(project[key])) add('project.structure', `工程缺少 ${key} 列表`);
    }
    if (issues.length) return issues;
    const resolved = resolveParameterValues(project.parameters);
    issues.push(...resolved.issues);
    const values = resolved.values;
    if (!project.source) add('source.missing', '工程未绑定源模型');
    else if (!Number.isFinite(project.source.unitScale) || project.source.unitScale <= 0) add('source.unit', '源模型单位倍率必须为正数');
    if (!project.limits || !Number.isInteger(project.limits.maxInstances) || project.limits.maxInstances < 1 || project.limits.maxInstances > 1000) add('budget.instances', '实例预算必须是 1–1000 的整数');
    if (!project.limits || !Number.isInteger(project.limits.maxLayers) || project.limits.maxLayers < 1 || project.limits.maxLayers > 8) add('budget.layers', '外观图层预算必须是 1–8 的整数');
    if (project.layers.filter(layer => layer.enabled).length > (project.limits?.maxLayers ?? 8)) add('budget.layers', '启用的外观图层超过预算');
    const unique = <T extends { id: string }>(items: T[], label: string): Map<string, T> => {
      const map = new Map<string, T>();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id || map.has(item.id)) add('id.duplicate', `${label}存在空 ID 或重复 ID`);
        else map.set(item.id, item);
      }
      return map;
    };
    const nodes = unique(project.nodes, '节点');
    unique(project.parts, '部件组'); unique(project.rules, '规则');
    const regions = unique(project.regions, '区域');
    unique(project.layers, '图层');
    const assets = unique(project.textureAssets, '图像资产');
    for (const node of nodes.values()) {
      const visited = new Set([node.id]);
      let parent = node.parentId;
      while (parent) {
        if (visited.has(parent)) { add('node.cycle', '节点层级存在循环', { nodeId: node.id }); break; }
        visited.add(parent);
        if (!nodes.has(parent)) { add('node.parent', '父节点不存在', { nodeId: node.id }); break; }
        parent = nodes.get(parent)!.parentId;
      }
    }
    const expand = (targets: string[]): string[] => {
      const output = new Set<string>();
      for (const node of nodes.values()) {
        if (!node.isMesh) continue;
        let current: string | undefined = node.id;
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
          if (targets.includes(current)) { output.add(node.id); break; }
          seen.add(current); current = nodes.get(current)?.parentId;
        }
      }
      return [...output];
    };
    function targetsValid(targets: string[], location: Partial<AuthoringIssue>) {
      if (!Array.isArray(targets) || !targets.length) { add('target.empty', '至少选择一个目标节点', location); return false; }
      for (const id of targets) if (!nodes.has(id)) add('target.missing', `目标节点 ${id} 不存在`, location);
      return true;
    }
    for (const part of project.parts) targetsValid(part.nodeIds, {});
    const writers = new Map<string, string>();
    let minimumArrayInstances = 0;
    for (const rule of project.rules) {
      if (!rule.enabled) continue;
      const location = { ruleId: rule.id };
      if (!targetsValid(rule.targets, location)) continue;
      if (!['x', 'y', 'z'].includes(rule.axis)) add('rule.axis', '规则轴必须是 x、y 或 z', location);
      if (!['min', 'center', 'max'].includes(rule.anchor)) add('rule.anchor', '规则锚点无效', location);
      if (!['resize', 'stretch', 'translate', 'rotate', 'array', 'visibility', 'color'].includes(rule.type)) { add('rule.type', '不支持的规则类型', location); continue; }
      const channel = rule.type === 'resize' || rule.type === 'stretch' ? `dimension:${rule.axis}`
        : rule.type === 'translate' ? `translate:${rule.axis}` : rule.type === 'rotate' ? 'rotate' : rule.type;
      const expanded = expand(rule.targets);
      if (!expanded.length) add('target.geometry', '规则目标没有可编辑网格', location);
      for (const id of expanded) {
        const key = `${id}/${channel}`;
        if (writers.has(key)) add('rule.conflict', `与规则 ${writers.get(key)} 重复写入同一目标属性`, { ...location, nodeId: id });
        writers.set(key, rule.id);
      }
      try {
        if (rule.type === 'color') {
          const color = own(values, rule.expression) ? values[rule.expression] : rule.expression;
          if (typeof color !== 'string' || !colorPattern.test(color)) throw new Error('颜色规则需要颜色参数 key 或 #RGB / #RRGGBB');
        } else if (rule.type === 'array') {
          if (rule.arrayMode !== undefined && !['count', 'fill'].includes(rule.arrayMode)) throw new Error('不支持的阵列模式');
          const countExpressions = rule.counts ?? [rule.axis === 'x' ? rule.expression : '1', rule.axis === 'y' ? rule.expression : '1', rule.axis === 'z' ? rule.expression : '1'];
          if (countExpressions.length !== 3 || (rule.steps && rule.steps.length !== 3)) throw new Error('阵列数量和步距必须包含三个轴');
          let count = 1;
          for (let axis = 0; axis < 3; axis++) {
            if (rule.arrayMode === 'fill' && ['x', 'y', 'z'][axis] === rule.axis) continue;
            const value = evaluateExpression(countExpressions[axis], values);
            if (!Number.isInteger(value) || value < 1) throw new Error('阵列数量必须为正整数，包含源件');
            count *= value;
          }
          minimumArrayInstances += count * expanded.length;
          if (!Number.isSafeInteger(minimumArrayInstances) || minimumArrayInstances > (project.limits?.maxInstances ?? 1000)) throw new Error('阵列合计超过实例预算，不能截断');
          if (rule.steps) for (const step of rule.steps) evaluateExpression(step, values);
          if (rule.arrayMode === 'fill') {
            if (evaluateExpression(rule.fillSpan || rule.expression, values) <= 0) throw new Error('填充跨度必须为正数');
            if (evaluateExpression(rule.gap || '0', values) < 0) throw new Error('填充间隙不能为负数');
          }
        } else {
          const value = evaluateExpression(rule.expression, values);
          if ((rule.type === 'resize' || rule.type === 'stretch') && value <= 0) throw new Error('目标尺寸必须为正数');
          if (rule.type === 'stretch') {
            const start = rule.fixedStart ?? 0; const end = rule.fixedEnd ?? 0;
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) throw new Error('固定端长度必须是非负有限数值');
            if (value <= start + end) throw new Error('目标尺寸必须大于两固定端长度之和');
          }
        }
      } catch (error) { add('rule.invalid', error instanceof Error ? error.message : String(error), location); }
    }
    const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(item => typeof item === 'number' && Number.isFinite(item));
    for (const region of project.regions) {
      const location = { regionId: region.id };
      targetsValid(region.targets, location);
      if (!['whole', 'faces', 'rectangle', 'polygon'].includes(region.kind)) add('region.kind', '区域类型无效', location);
      if (!vector(region.offset, 2) || !Number.isFinite(region.rotation)) add('region.transform', '区域偏移或角度无效', location);
      if (region.kind === 'rectangle' || region.kind === 'polygon') {
        if (![region.width, region.height, region.depth].every(value => Number.isFinite(value) && value > 0)) add('region.size', '投影区域宽高深度必须为正数', location);
        const anchor = region.anchor;
        if (!anchor || !expand(region.targets).includes(anchor.nodeId) || !Number.isInteger(anchor.faceIndex) || anchor.faceIndex < 0
          || !vector(anchor.barycentric, 3) || anchor.barycentric.some(value => value < -1e-5 || value > 1 + 1e-5)
          || Math.abs(anchor.barycentric.reduce((sum, value) => sum + value, 0) - 1) > 1e-5
          || !vector(anchor.point, 3) || !vector(anchor.normal, 3) || !vector(anchor.tangent, 3)) add('region.anchor', '投影区域缺少有效表面锚点', location);
        if (anchor && nodes.has(anchor.nodeId) && anchor.faceIndex >= Math.floor((nodes.get(anchor.nodeId)!.indexCount || nodes.get(anchor.nodeId)!.vertexCount) / 3)) add('region.topology', '锚点面索引超出源拓扑', location);
      }
      if (region.kind === 'polygon' && (!Array.isArray(region.points) || region.points.length < 3 || !region.points.every(point => vector(point, 2)))) add('region.polygon', '多边形至少需要三个有限二维点', location);
      if (region.kind === 'faces') {
        let faceCount = 0;
        for (const [id, faces] of Object.entries(region.faces ?? {})) {
          const node = nodes.get(id);
          if (!node || !expand(region.targets).includes(id) || !Array.isArray(faces) || faces.some(face => !Number.isInteger(face) || face < 0 || face >= Math.floor((node.indexCount || node.vertexCount) / 3))) add('region.faces', '区域面索引或目标无效', location);
          else faceCount += faces.length;
        }
        if (!faceCount) add('region.faces', '面区域至少需要一个面', location);
      }
    }
    const numericBindings = new Set(['width', 'height', 'rotation', 'opacity', 'offsetU', 'offsetV', 'repeatU', 'repeatV']);
    for (const layer of project.layers) {
      if (!layer.enabled) continue;
      const location = { layerId: layer.id };
      if (!regions.has(layer.regionId)) add('layer.region', '图层引用的区域不存在', location);
      if (!['color', 'decal', 'texture'].includes(layer.kind)) add('layer.kind', '图层类型无效', location);
      if (layer.kind !== 'color' && (!layer.textureId || !assets.has(layer.textureId))) add('layer.texture', '图层缺少图像资产', location);
      if (!['tint', 'replace'].includes(layer.blend) || !['fixed', 'scale', 'tile'].includes(layer.follow) || ![0, 1].includes(layer.uvChannel)) add('layer.mode', '图层混合、跟随或 UV 模式无效', location);
      if (!colorPattern.test(layer.color) || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) add('layer.color', '图层颜色或透明度无效', location);
      if (![layer.width, layer.height].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(layer.rotation) || !vector(layer.offset, 2) || !vector(layer.repeat, 2) || layer.repeat.some(value => value <= 0)) add('layer.transform', '图层尺寸、平铺或偏移无效', location);
      for (const [key, expression] of Object.entries(layer.bindings ?? {})) {
        if (!expression) continue;
        try {
          if (key === 'color' || key === 'visible') {
            if (!own(values, expression)) throw new Error(`未知参数 ${expression}`);
            const value = values[expression];
            if (key === 'color' && (typeof value !== 'string' || !colorPattern.test(value))) throw new Error('颜色绑定必须引用颜色参数');
            if (key === 'visible' && typeof value !== 'boolean') throw new Error('可见性绑定必须引用布尔参数');
          } else if (numericBindings.has(key)) {
            const value = evaluateExpression(expression, values);
            if (['width', 'height', 'repeatU', 'repeatV'].includes(key) && value <= 0) throw new Error(`${key} 必须为正数`);
            if (key === 'opacity' && (value < 0 || value > 1)) throw new Error('opacity 必须在 0–1 之间');
          } else throw new Error(`不支持图层绑定 ${key}`);
        } catch (error) { add('layer.binding', error instanceof Error ? error.message : String(error), location); }
      }
    }
    return issues;
  }
  function validateProject(project: AuthoringProject): AuthoringIssue[] {
    try { return validateProjectUnchecked(project); }
    catch (error) {
      return [{ code: 'project.structure', severity: 'error', message: `工程结构无效：${error instanceof Error ? error.message : String(error)}` }];
    }
  }
  return { evaluate: evaluateExpression, evaluateExpression, dependencies, resolveParameterValues, validateProject };
}

const evaluator = createExpressionEvaluator();
export const evaluateExpression = evaluator.evaluateExpression;
export const resolveParameterValues = evaluator.resolveParameterValues;
export const validateProject = evaluator.validateProject;
