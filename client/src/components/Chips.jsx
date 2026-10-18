export default function Chips({ options, value, onChange, max }) {
  const toggle = (opt) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else if (!max || value.length < max) onChange([...value, opt]);
  };
  return (
    <div className="chips" role="group">
      {options.map((opt) => {
        const on = value.includes(opt);
        return (
          <button
            type="button"
            key={opt}
            className={`chip ${on ? 'chip-on' : ''}`}
            aria-pressed={on}
            onClick={() => toggle(opt)}
            disabled={!on && max && value.length >= max}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export function Tags({ items, shared = [] }) {
  return (
    <div className="tags">
      {items.map((t) => (
        <span key={t} className={`tag ${shared.includes(t) ? 'tag-shared' : ''}`}>{t}</span>
      ))}
    </div>
  );
}
