/**
 * One CSV row (RFC 4180 quoting). A cell that a spreadsheet would read as a
 * formula (starting with = + - @, a tab or a carriage return) gets a leading
 * apostrophe, so an address or name typed by a visitor can't run in the
 * owner's spreadsheet. A cell containing `;` is quoted too, so it stays one
 * field in spreadsheets that use `;` as the separator (otherwise a payload
 * after the `;` would start a new field and be read as a formula).
 */
export function csvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => {
      const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      return /[",;\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    })
    .join(",");
}
