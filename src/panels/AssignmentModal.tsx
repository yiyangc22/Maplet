// Shown on every raw-table load (cat_prototype_10). The header/type notation is no
// longer read — instead the app proposes a structure (id, coordinate maps, a
// numerical/categorical type per column) from the column names + values, and the
// user confirms or edits it here before the dataset builds. Each column gets ONE
// role: ignore, id, a coordinate axis of one of up to four maps (map 0 = the main
// viewer, 1-3 = the smaller auxiliary viewers), numerical, or categorical.

import { useMemo, useState } from 'react';
import { useStore } from '../model/store';
import { Modal } from '../ui/Modal';
import type { Assignment, ColumnInspect, InspectRole, MapAssign, VarType } from '../../shared/table';

const MAX_MAPS = 4; // main viewer + 3 auxiliary viewers

// Encode a role as the <select> value, and back.
function roleToValue(r: InspectRole): string {
  if (r.kind === 'coord') return `c:${r.map}:${r.axis}`;
  return r.kind; // id | grad | cat | ignore
}
function valueToRole(v: string): InspectRole {
  if (v.startsWith('c:')) {
    const [, m, axis] = v.split(':');
    return { kind: 'coord', map: Number(m), axis: axis as 'x' | 'y' | 'z' };
  }
  return { kind: v as 'id' | 'grad' | 'cat' | 'ignore' };
}

// Turn the per-column roles into a validated Assignment, or an error to show.
function rolesToAssignment(
  columns: ColumnInspect[],
  roles: InspectRole[],
  delimiter: Assignment['delimiter'],
): { assignment?: Assignment; error?: string } {
  const header = columns.map((c) => c.name);
  let idIdx = -1;
  const mapAxes = new Map<number, { x?: number; y?: number; z?: number }>();
  const axisTaken = new Map<string, number>();
  const variables: { idx: number; type: VarType }[] = [];

  for (let i = 0; i < roles.length; i++) {
    const r = roles[i];
    if (r.kind === 'id') {
      if (idIdx >= 0) return { error: `Two columns are set as id (“${header[idIdx]}” and “${header[i]}”). Pick one.` };
      idIdx = i;
    } else if (r.kind === 'coord') {
      const key = `${r.map}:${r.axis}`;
      if (axisTaken.has(key)) {
        return { error: `Map ${r.map} ${r.axis.toUpperCase()} is assigned twice (“${header[axisTaken.get(key) as number]}” and “${header[i]}”).` };
      }
      axisTaken.set(key, i);
      const ax = mapAxes.get(r.map) ?? {};
      ax[r.axis] = i;
      mapAxes.set(r.map, ax);
    } else if (r.kind === 'grad' || r.kind === 'cat') {
      variables.push({ idx: i, type: r.kind });
    }
  }

  const maps: MapAssign[] = [];
  for (const [index, ax] of [...mapAxes.entries()].sort((a, b) => a[0] - b[0])) {
    if (ax.x == null || ax.y == null) {
      return { error: `Map ${index} needs both an X and a Y column (${ax.x == null ? 'X' : 'Y'} is missing).` };
    }
    maps.push({ index, xi: ax.x, yi: ax.y, zi: ax.z ?? -1 });
  }
  if (!maps.length) return { error: 'Assign at least one map — an X and a Y column for map 0 (the main viewer).' };
  return { assignment: { delimiter, header, idIdx, maps, variables } };
}

export default function AssignmentModal() {
  const prompt = useStore((s) => s.assignPrompt);
  const confirm = useStore((s) => s.confirmAssignment);
  const cancel = useStore((s) => s.cancelAssignment);
  const [roles, setRoles] = useState<InspectRole[]>([]);
  const [seededFor, setSeededFor] = useState<ColumnInspect[] | null>(null);

  // Seed the editable roles from the proposal the first time this prompt appears.
  if (prompt && seededFor !== prompt.columns) {
    setRoles(prompt.columns.map((c) => c.role));
    setSeededFor(prompt.columns);
  }

  const { assignment, error } = useMemo(
    () => (prompt ? rolesToAssignment(prompt.columns, roles, prompt.proposal.delimiter) : { assignment: undefined, error: undefined }),
    [prompt, roles],
  );

  if (!prompt) return null;

  const setRole = (i: number, v: string) => setRoles((rs) => rs.map((r, j) => (j === i ? valueToRole(v) : r)));
  // How many maps to offer in every row's dropdown. Derived from the RAW roles (the
  // highest map index any column is currently assigned to) — NOT from the validated
  // `assignment`, which is null whenever a map is half-assigned (e.g. its X is set
  // but its Y isn't). Using the assignment made map 2/3's options disappear mid-edit,
  // which also snapped that <select> back to its first option ("numerical"). We show
  // every map in use plus one empty map to grow into, capped at MAX_MAPS.
  const maxMapUsed = roles.reduce((m, r) => (r.kind === 'coord' ? Math.max(m, r.map) : m), -1);
  const mapsToShow = Math.min(MAX_MAPS, Math.max(maxMapUsed + 2, 2));

  return (
    <Modal
      title="Assign columns"
      onClose={cancel}
      width={640}
      actions={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn-active" disabled={!assignment} onClick={() => assignment && confirm(assignment)}>
            Load {prompt.rowCount.toLocaleString()} cells
          </button>
        </>
      }
    >
      <p className="mb-2">
        Set what each column of <b>{prompt.sourceName}</b> is. Pick an <b>X</b> and a <b>Y</b> (and optionally <b>Z</b>) for
        <b> map 0</b> — the main viewer — and, if you have other embeddings (a UMAP, a second assay), assign them to maps 1–
        {MAX_MAPS - 1}, each shown in its own smaller viewer. Everything else is a <b>numerical</b> or <b>categorical</b>{' '}
        variable to colour and filter by. The app guessed from the names and values below; change anything that&rsquo;s wrong.
      </p>
      <div className="mb-2 max-h-[46vh] overflow-y-auto border" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
              <th className="px-2 py-1 text-left font-[500]">column</th>
              <th className="px-2 py-1 text-left font-[500]">example values</th>
              <th className="px-2 py-1 text-left font-[500]">role</th>
            </tr>
          </thead>
          <tbody>
            {prompt.columns.map((c, i) => (
              <tr key={c.idx} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="max-w-[160px] truncate px-2 py-1" style={{ color: 'var(--text)' }} title={c.name}>
                  {c.name}
                  <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                    {c.numeric ? 'num' : `${c.distinct > 2000 ? '2000+' : c.distinct} distinct`}
                  </span>
                </td>
                <td className="max-w-[190px] truncate px-2 py-1 mono-num" style={{ color: 'var(--faint)' }} title={c.samples.join(', ')}>
                  {c.samples.join(', ') || '—'}
                </td>
                <td className="px-2 py-1">
                  <RoleSelect value={roleToValue(roles[i] ?? c.role)} mapsToShow={mapsToShow} onChange={(v) => setRole(i, v)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="min-h-[18px] text-[11px]" style={{ color: error ? 'var(--warn)' : 'var(--faint)' }}>
        {error ??
          (assignment
            ? `${assignment.maps.length} map${assignment.maps.length === 1 ? '' : 's'} · ${assignment.variables.length} variable${
                assignment.variables.length === 1 ? '' : 's'
              }${assignment.idIdx < 0 ? ' · ids from row number' : ''}`
            : '')}
      </div>
    </Modal>
  );
}

// The per-column role picker. Coordinate axes are grouped per map; maps beyond the
// ones currently in use (plus one spare, up to MAX_MAPS) are offered so the user can
// add a new map without a separate control. `mapsToShow` is computed by the parent
// from the raw roles so a half-assigned map never drops out of the list.
function RoleSelect({ value, mapsToShow, onChange }: { value: string; mapsToShow: number; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="field w-full text-[11px]"
    >
      <option value="grad">numerical</option>
      <option value="cat">categorical</option>
      <option value="id">id</option>
      {Array.from({ length: mapsToShow }, (_, m) => (
        <optgroup key={m} label={m === 0 ? 'map 0 (main viewer)' : `map ${m} (aux viewer)`}>
          <option value={`c:${m}:x`}>{`map ${m} · X`}</option>
          <option value={`c:${m}:y`}>{`map ${m} · Y`}</option>
          <option value={`c:${m}:z`}>{`map ${m} · Z`}</option>
        </optgroup>
      ))}
      <option value="ignore">ignore</option>
    </select>
  );
}
