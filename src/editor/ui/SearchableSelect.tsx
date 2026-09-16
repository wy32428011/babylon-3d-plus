import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export type SearchableSelectOption = {
  value: string;
  label: string;
  keywords?: string[];
};

type SearchableSelectProps = {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** 当前值不在 options 中（如实体已删除）时的展示文案。 */
  missingLabel?: (value: string) => string | null;
  noMatchText?: string;
};

/** 可输入过滤的下拉选择器：聚焦展开全量，输入按 label/keywords 小写 substring 过滤，startsWith 命中优先。 */
export function SearchableSelect(props: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = props.options.find((option) => option.value === props.value);
  const displayLabel = selected?.label
    ?? (props.value ? props.missingLabel?.(props.value) ?? props.value : '');

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return props.options;
    const startsWith: SearchableSelectOption[] = [];
    const contains: SearchableSelectOption[] = [];
    for (const option of props.options) {
      const texts = [option.label, ...(option.keywords ?? [])].map((text) => text.toLowerCase());
      if (texts.some((text) => text.startsWith(keyword))) startsWith.push(option);
      else if (texts.some((text) => text.includes(keyword))) contains.push(option);
    }
    return [...startsWith, ...contains];
  }, [props.options, query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.searchable-select__option--active')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function close(): void {
    setOpen(false);
    setQuery('');
  }

  function commit(option: SearchableSelectOption): void {
    props.onChange(option.value);
    close();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (filtered.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + filtered.length) % filtered.length);
    } else if (event.key === 'Enter') {
      if (!open || filtered.length === 0) return;
      event.preventDefault();
      commit(filtered[activeIndex] ?? filtered[0]);
    } else if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      close();
    }
  }

  return (
    <div className="searchable-select">
      <input
        aria-label={props.ariaLabel}
        className="searchable-select__input"
        disabled={props.disabled}
        placeholder={open ? displayLabel : undefined}
        value={open ? query : displayLabel}
        onBlur={close}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery('');
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      {open ? (
        <ul
          className="searchable-select__list"
          onMouseDown={(event) => event.preventDefault()}
          ref={listRef}
          role="listbox"
        >
          {filtered.map((option, index) => (
            <li
              aria-selected={option.value === props.value}
              className={`searchable-select__option${index === activeIndex ? ' searchable-select__option--active' : ''}`}
              key={option.value || '__empty__'}
              onClick={() => commit(option)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
            >
              {option.label}
            </li>
          ))}
          {filtered.length === 0 ? <li className="searchable-select__empty">{props.noMatchText ?? '无匹配'}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
