import type { OpeningPackageBinding, OpeningScalar } from '../../shared/opening/openingPackage';
import { OpeningField, openingColorInputValue } from './OpeningField';

export function OpeningPackageFields({ binding, disabled, onChange }: {
  binding: OpeningPackageBinding; disabled: boolean; onChange: (key: string, value: OpeningScalar) => void;
}) {
  const { definition, config } = binding;
  const included = new Set(definition.uiSchema.groups.flatMap(group => group.fields));
  const missing = Object.keys(definition.schema.properties).filter(key => !included.has(key));
  const groups = [...definition.uiSchema.groups, ...(missing.length ? [{ title: '其它配置', fields: missing }] : [])];
  function fieldControl(key: string) {
    const field = definition.schema.properties[key];
    if (!field) return null;
    const label = field.title ?? key;
    const value = config.values[key];
    const imageOnly = config.stages.some(stage => stage.backgroundKey === key || stage.logoKey === key);
    let control;
    if (field.enum) control = <label className="inspector-row"><span>{label}</span><select aria-label={label} value={String(value)} disabled={disabled}
      onChange={event => { const match = field.enum?.find(option => String(option) === event.target.value); if (match !== undefined) onChange(key, match); }}>
      {field.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select></label>;
    else if (field.type === 'boolean') control = <label className="inspector-row"><span>{label}</span><input type="checkbox" checked={value === true} disabled={disabled}
      onChange={event => onChange(key, event.target.checked)} /></label>;
    else if (field.format === 'asset') control = <label className="inspector-row"><span>{label}</span><select aria-label={label} value={String(value)} disabled={disabled}
      onChange={event => onChange(key, event.target.value)}><option value="">不使用素材</option>
      {definition.manifest.assets.filter(asset => !imageOnly || asset.type === 'image').map(asset => <option key={asset.id} value={asset.id}>{asset.id}</option>)}
    </select></label>;
    else if (field.format === 'color') control = <div className="opening-package-color-field">
      <OpeningField label={label} value={String(value)} disabled={disabled} maxLength={field.maxLength} onCommit={text => onChange(key, text)} />
      <label className="inspector-row"><span>选取{label}</span><input type="color" aria-label={`选取${label}`} disabled={disabled} value={openingColorInputValue(String(value))}
        onChange={event => onChange(key, event.target.value)} /></label>
    </div>;
    else control = <OpeningField label={label} value={field.type === 'number' ? Number(value) : String(value)} disabled={disabled}
      multiline={field.format === 'multiline'} min={field.minimum} max={field.maximum} maxLength={field.maxLength}
      onCommit={text => onChange(key, field.type === 'number' ? Number(text) : text)} />;
    return <div key={key}>{control}{field.description ? <p className="muted">{field.description}</p> : null}</div>;
  }
  return <div className="opening-package-fields">{groups.map((group, index) => <details key={`${group.title}:${index}`} open>
    <summary>{group.title}</summary>{group.fields.map(fieldControl)}
  </details>)}</div>;
}
