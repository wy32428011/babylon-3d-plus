import type { ModelParameterBinding, ModelParameterConfig, ModelExpression } from '../../editor/model/modelParameters';

/** 参数升级不回滚资源；只隔离不能执行的绑定，后续独立绑定和规则继续运行。 */
export function executeModelParameterBindings(config: ModelParameterConfig, handlers: {
  apply: (binding: ModelParameterBinding) => void;
  evaluateRule: (expression: ModelExpression) => boolean;
  report: (message: string) => void;
}): void {
  const apply = (binding: ModelParameterBinding) => {
    try { handlers.apply(binding); } catch (error) {
      handlers.report(`参数绑定「${binding.target.name}.${binding.property}」暂时无法执行，已保留模型和参数值：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  config.bindings.forEach(apply);
  for (const rule of config.rules ?? []) {
    let matches = false;
    try { matches = handlers.evaluateRule(rule.when); } catch (error) {
      handlers.report(`参数规则暂时无法执行，已保留模型和参数值：${error instanceof Error ? error.message : String(error)}`);
    }
    if (matches) rule.set.forEach(apply);
  }
}
