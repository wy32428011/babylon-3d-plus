import type { LightingManagerDiagnostic } from './lightingBakeManagerModel';
import { LightingManagerIcon } from './LightingBakeManagerWidgets';

export type LightingManagerDiagnosticActions = {
  onInspect?: (issue: LightingManagerDiagnostic) => void;
  onFocus?: (issue: LightingManagerDiagnostic) => void;
  onRule?: (issue: LightingManagerDiagnostic) => void;
  onRetry?: (issue: LightingManagerDiagnostic) => void;
};

/** 诊断保留身份并提供已有管理入口；缺失旧节点不提供不可执行的场景定位。 */
export function LightingBakeManagerDiagnostics({ issues, onInspect, onFocus, onRule, onRetry }: LightingManagerDiagnosticActions & { issues: readonly LightingManagerDiagnostic[] }) {
  return <>{(['error', 'warning', 'info'] as const).map(severity => {
    const group = issues.filter(issue => issue.severity === severity);
    if (!group.length) return null;
    return <section key={severity} className={'lighting-manager-diagnostic-group is-' + severity}>
      <h4>{severity === 'error' ? '阻止烘焙' : severity === 'warning' ? '需要处理' : '提示'} <span>{group.length}</span></h4>
      <ul className="lighting-manager-diagnostics">{group.map(issue => <li key={issue.id}>
        <LightingManagerIcon name="warning" size={16} /><div><p>{issue.message}</p>
          {(issue.entityId || issue.nodeKey || issue.assetId) && <small className="lighting-manager-diagnostic-identity">
            {issue.entityName ?? issue.entityId}{issue.nodeKey && <span> · {issue.nodeKey}</span>}{issue.assetId && <span> · 资产 {issue.assetId}</span>}
          </small>}
          {(issue.expectedResourceIdentity || issue.actualResourceIdentity) && <details><summary>资源身份</summary><p>预期：{issue.expectedResourceIdentity ?? '未记录'}<br />当前：{issue.actualResourceIdentity ?? '未提供'}</p></details>}
          <div className="lighting-manager-diagnostic-actions">
            {issue.entityId && onInspect && <button type="button" onClick={() => onInspect(issue)}>查看对象</button>}
            {issue.entityId && issue.locatable && onFocus && <button type="button" onClick={() => onFocus(issue)}>定位部件</button>}
            {issue.ruleId && onRule && <button type="button" onClick={() => onRule(issue)}>查看规则</button>}
            {issue.action && onRetry && <button type="button" onClick={() => onRetry(issue)}>重新检查</button>}
          </div>
        </div></li>)}</ul>
    </section>;
  })}</>;
}
