import { useId, useState, type ReactNode } from 'react';
import './CollapsibleFieldset.css';

type CollapsibleFieldsetProps = {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
};

export function CollapsibleFieldset({ title, children, className, disabled }: CollapsibleFieldsetProps) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();

  return (
    <fieldset className={['transform-fieldset', 'collapsible-fieldset', className].filter(Boolean).join(' ')} disabled={disabled}>
      <legend>
        <button
          className="collapsible-fieldset-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="collapsible-fieldset-arrow" aria-hidden="true" />
          <span>{title}</span>
        </button>
      </legend>
      {/* 保留控件挂载，收起时不丢失输入草稿和内部编辑状态。 */}
      <div id={contentId} className="collapsible-fieldset-content" hidden={!expanded}>
        {children}
      </div>
    </fieldset>
  );
}
