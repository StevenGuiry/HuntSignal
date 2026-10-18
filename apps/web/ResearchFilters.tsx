import { useEffect, useState } from "react";
import {
  emptyResearchFilters,
  researchFilterKeys,
  type ResearchFilterState,
} from "../../packages/research-filters";

export function ResearchFilters({
  values,
  onApply,
}: {
  values: ResearchFilterState;
  onApply: (values: ResearchFilterState) => void;
}) {
  const pick = () =>
    Object.fromEntries(
      researchFilterKeys.map((k) => [k, values[k]]),
    ) as ResearchFilterState;
  const [draft, setDraft] = useState(pick),
    [facets, setFacets] = useState<{
      programs: { program: string; count: number }[];
      currencies: string[];
    }>({ programs: [], currencies: [] });
  const [error, setError] = useState("");
  const current = JSON.stringify(researchFilterKeys.map((k) => values[k]));
  useEffect(() => {
    setDraft(pick());
    setError("");
  }, [current]);
  useEffect(() => {
    const c = new AbortController();
    fetch("/api/search/facets", { signal: c.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setFacets)
      .catch(() => {});
    return () => c.abort();
  }, []);
  const field = (key: keyof ResearchFilterState, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const active = researchFilterKeys.some((k) => !!values[k]);
  return (
    <details className="research-filters" open={active || undefined}>
      <summary>
        Program, severity & bounty{active ? " · filters active" : ""}
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            (draft.bountyMin !== "" || draft.bountyMax !== "") &&
            !draft.currency
          ) {
            setError("Choose a currency for the amount range.");
            return;
          }
          if (
            draft.bountyMin !== "" &&
            draft.bountyMax !== "" &&
            Number(draft.bountyMin) > Number(draft.bountyMax)
          ) {
            setError("Minimum bounty must not exceed maximum.");
            return;
          }
          setError("");
          onApply({ ...draft, program: draft.program.trim() });
        }}
      >
        <label>
          Program
          <input
            aria-label="Program"
            list="program-options"
            maxLength={150}
            value={draft.program}
            onChange={(e) => field("program", e.target.value)}
            placeholder="Exact program name"
          />
          <datalist id="program-options">
            {facets.programs.map((p) => (
              <option key={p.program} value={p.program}>
                {p.count} documents
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Severity
          <select
            aria-label="Severity"
            value={draft.severity}
            onChange={(e) => field("severity", e.target.value)}
          >
            <option value="">All severities</option>
            <option value="high-critical">High + Critical</option>
            {["critical", "high", "medium", "low", "informational", "none"].map(
              (s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Bounty
          <select
            aria-label="Bounty disclosure"
            value={draft.bounty}
            onChange={(e) => field("bounty", e.target.value)}
          >
            <option value="">All reports</option>
            <option value="disclosed">Disclosed amount / reward</option>
            <option value="undisclosed">Checked, not disclosed</option>
          </select>
        </label>
        <label>
          Currency
          <select
            aria-label="Bounty currency"
            value={draft.currency}
            onChange={(e) => field("currency", e.target.value)}
          >
            <option value="">Any currency</option>
            {[
              ...new Set([
                ...facets.currencies,
                ...(draft.currency ? [draft.currency] : []),
              ]),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Minimum bounty
          <input
            aria-label="Minimum bounty"
            type="number"
            min="0"
            max="1000000000000"
            step="0.01"
            value={draft.bountyMin}
            onChange={(e) => field("bountyMin", e.target.value)}
            placeholder="No minimum"
          />
        </label>
        <label>
          Maximum bounty
          <input
            aria-label="Maximum bounty"
            type="number"
            min="0"
            max="1000000000000"
            step="0.01"
            value={draft.bountyMax}
            onChange={(e) => field("bountyMax", e.target.value)}
            placeholder="No maximum"
          />
        </label>
        <div className="research-filter-actions">
          <button className="primary-button" type="submit">
            Apply filters
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setDraft(emptyResearchFilters);
              onApply(emptyResearchFilters);
            }}
          >
            Clear report filters
          </button>
        </div>
        <p>
          Amounts use the disclosed currency without conversion. Severity is the
          latest checked source rating; result badges identify unresolved
          reports.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
