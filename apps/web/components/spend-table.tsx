"use client";

import Link from "next/link";
import { Badge, Cell, Row, Table, money } from "@/components/ui";
import { useUrlState } from "@/components/list-controls";
import { readParam } from "@/lib/listControls";
import { SPEND_COLUMNS, SPEND_COLUMN_KEYS, sortSpendRows, type SpendRow } from "@/lib/spendSort";

/** The per-agent spend table, sortable by any column; the sort is in the URL. */
export function SpendTable({ rows }: { rows: SpendRow[] }) {
  const url = useUrlState();
  const column = readParam(url.get("sort"), SPEND_COLUMN_KEYS, "season");
  const dir = readParam(url.get("dir"), ["asc", "desc"], "desc") as "asc" | "desc";
  const sorted = sortSpendRows(rows, column, dir);

  const onSort = (key: string) => {
    if (key === column) url.set({ dir: dir === "desc" ? "asc" : "desc" });
    else url.set({ sort: key === "season" ? undefined : key, dir: undefined });
  };

  return (
    <Table
      head={SPEND_COLUMNS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onSort(key)}
          className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-accent ${
            key === column ? "text-accent" : ""
          }`}
          aria-sort={key === column ? (dir === "asc" ? "ascending" : "descending") : undefined}
        >
          {label}
          {key === column ? <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span> : null}
        </button>
      ))}
    >
      {sorted.map((r) => (
        <Row key={r.key}>
          <Cell>
            <Link href={r.href} className="font-medium hover:text-accent">
              {r.name}
            </Link>
            <span className="ml-1.5 text-xs text-muted">{r.model}</span>
            {r.alarms > 0 ? (
              <span className="ml-1.5">
                <Badge tone="warn">
                  {r.alarms} alarm{r.alarms === 1 ? "" : "s"}
                </Badge>
              </span>
            ) : null}
          </Cell>
          <Cell align="right">{money(r.today)}</Cell>
          <Cell align="right">{money(r.week)}</Cell>
          <Cell align="right">{money(r.season)}</Cell>
          <Cell align="right">{money(r.paid)}</Cell>
          <Cell align="right">{r.sessions}</Cell>
          <Cell align="right">{r.perSession === null ? "—" : money(r.perSession)}</Cell>
          <Cell align="right">{r.perPoint === null ? "—" : `$${r.perPoint.toFixed(3)}`}</Cell>
          <Cell align="right">{r.perWin === null ? "—" : money(r.perWin)}</Cell>
          <Cell align="right">{r.input.toLocaleString()}</Cell>
          <Cell align="right">{r.output.toLocaleString()}</Cell>
          <Cell align="right">{r.reasoning.toLocaleString()}</Cell>
          <Cell align="right">{r.cached.toLocaleString()}</Cell>
        </Row>
      ))}
    </Table>
  );
}
