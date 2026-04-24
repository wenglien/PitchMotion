export default function TabBar({ active, onSelect }) {
  const tabs = [
    { id: "upload",   label: "Analyze"  },
    { id: "result",   label: "Result"   },
    { id: "history",  label: "History"  },
    { id: "settings", label: "Settings" },
  ];

  return (
    <nav className="tab-bar">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab-item${active === t.id ? " active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
