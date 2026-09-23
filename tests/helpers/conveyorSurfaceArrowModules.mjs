import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

/** 在 Node 中读取实际 TS 模块，保持 Babylon 和遥测 Store 单实例，不生成仓库编译产物。 */
export async function loadConveyorArrowModules(paths) {
  const root = new URL('../../', import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
        const target = new URL(specifier, context.parentURL);
        for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
          const url = new URL(target.href + suffix);
          if (existsSync(url) && /\.(?:ts|tsx)$/.test(url.pathname)) return { url: url.href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(root.href) && !url.includes('/node_modules/') && /\.tsx?$/.test(url)) {
        return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText };
      }
      return nextLoad(url, context);
    },
  });
  try { return await Promise.all(paths.map(path => import(new URL(path, root).href))); }
  finally { hooks.deregister(); }
}
