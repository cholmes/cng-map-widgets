// @cng/format-shapefile -- dBase III (.dbf) attribute-table writer.
// Zero dependencies: this is ~150 lines of fixed-width binary layout, not
// worth a package. Surfaces Shapefile's real limits as warnings (design
// doc's error-taxonomy requirement) instead of mangling data silently:
// field names over 10 bytes are truncated/deduped, numeric values that
// overflow their declared field width are clamped with '*' padding (the
// classic dBase overflow marker GDAL itself recognizes), and a DATE value
// with a non-midnight time-of-day loses that time component (dBase III's
// 'D' type is date-only).

/** @param {string} name @param {Set<string>} used @returns {{ name: string, truncated: boolean }} */
function dbfFieldName(name, used) {
  let base = String(name).slice(0, 10).toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'FIELD';
  let truncated = base !== String(name).toUpperCase();
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) {
    const suffix = String(n);
    candidate = base.slice(0, 10 - suffix.length) + suffix;
    truncated = true;
    n += 1;
  }
  used.add(candidate);
  return { name: candidate, truncated };
}

/**
 * @param {string} schemaType - this project's declared column type
 *   ('string'|'int*'|'uint*'|'float*'|'boolean'|'timestamp'|...).
 * @returns {{ type: 'C'|'N'|'F'|'L'|'D', length: number, decimals: number }}
 */
function dbfFieldSpec(schemaType) {
  if (schemaType === 'boolean') return { type: 'L', length: 1, decimals: 0 };
  if (schemaType === 'timestamp') return { type: 'D', length: 8, decimals: 0 };
  if (typeof schemaType === 'string' && schemaType.startsWith('float')) return { type: 'F', length: 32, decimals: 10 };
  // length 18, not 20: GDAL's shapefile driver infers OFTInteger64 for an
  // N field with 0 decimals only when its declared width can't exceed
  // int64's ~19-digit range; 20 digits can represent values int64 can't
  // hold, so GDAL defensively reads it back as a Real instead (found
  // empirically -- see test/shapefile-write.test.js).
  if (typeof schemaType === 'string' && (schemaType.startsWith('int') || schemaType.startsWith('uint'))) return { type: 'N', length: 18, decimals: 0 };
  return { type: 'C', length: 80, decimals: 0 }; // string, and the safe fallback for anything unmapped
}

function formatValue(value, spec, warnings, fieldName) {
  if (value === null || value === undefined) return ' '.repeat(spec.length);
  if (spec.type === 'C') {
    const s = String(value);
    return (s.length > spec.length ? s.slice(0, spec.length) : s).padEnd(spec.length, ' ');
  }
  if (spec.type === 'L') return value ? 'T' : 'F';
  if (spec.type === 'D') {
    const d = value instanceof Date ? value : new Date(value);
    if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds()) {
      warnings.push({ code: 'shapefile-date-truncated', message: `Field "${fieldName}": dBase's DATE type has no time component; the time-of-day on this value was dropped.`, context: { field: fieldName } });
    }
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = d.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }
  // N or F
  const num = typeof value === 'bigint' ? Number(value) : Number(value);
  let text = spec.decimals > 0 ? num.toFixed(spec.decimals) : String(Math.trunc(num));
  if (text.length > spec.length) {
    warnings.push({ code: 'shapefile-numeric-overflow', message: `Field "${fieldName}": value ${value} doesn't fit its ${spec.length}-character dBase field; stored as overflow ("*").`, context: { field: fieldName, value } });
    text = '*'.repeat(spec.length);
  }
  return text.padStart(spec.length, ' ');
}

/**
 * @param {{ name: string, schemaType: string }[]} columns
 * @param {unknown[][]} rows - one array of raw values per row, in `columns` order.
 * @returns {{ bytes: Uint8Array, warnings: { code: string, message: string, context?: object }[] }}
 */
export function writeDbf(columns, rows) {
  const warnings = [];
  const used = new Set();
  const fields = columns.map((c) => {
    const { name, truncated } = dbfFieldName(c.name, used);
    if (truncated) warnings.push({ code: 'shapefile-field-name-truncated', message: `Column "${c.name}" was renamed to "${name}" to fit dBase's 10-character field-name limit.`, context: { original: c.name, renamed: name } });
    return { ...dbfFieldSpec(c.schemaType), name };
  });

  const recordLength = 1 + fields.reduce((sum, f) => sum + f.length, 0); // 1 byte: deletion flag
  const headerLength = 32 + fields.length * 32 + 1;
  const numRecords = rows.length;

  const buf = new Uint8Array(headerLength + numRecords * recordLength + 1);
  const view = new DataView(buf.buffer);

  buf[0] = 0x03; // dBase III, no memo
  const now = new Date();
  buf[1] = Math.max(0, now.getUTCFullYear() - 1900) & 0xff;
  buf[2] = now.getUTCMonth() + 1;
  buf[3] = now.getUTCDate();
  view.setUint32(4, numRecords, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  buf[29] = 0x08; // "language driver id" byte; paired with a sidecar .cpg "UTF-8" file (GDAL's documented modern convention) rather than a legacy codepage number

  let offset = 32;
  for (const f of fields) {
    const nameBytes = new TextEncoder().encode(f.name).slice(0, 10);
    buf.set(nameBytes, offset);
    buf[offset + 11] = f.type.charCodeAt(0);
    buf[offset + 16] = f.length;
    buf[offset + 17] = f.decimals;
    offset += 32;
  }
  buf[offset] = 0x0d; // field descriptor terminator
  offset += 1;

  for (const row of rows) {
    buf[offset] = 0x20; // not deleted
    offset += 1;
    for (let i = 0; i < fields.length; i++) {
      const text = formatValue(row[i], fields[i], warnings, fields[i].name);
      const bytes = new TextEncoder().encode(text);
      buf.set(bytes.slice(0, fields[i].length), offset);
      offset += fields[i].length;
    }
  }
  buf[offset] = 0x1a; // EOF marker

  return { bytes: buf, warnings };
}
