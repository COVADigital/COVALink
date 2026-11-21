/**
 * One CSV row (RFC 4180 quoting). A cell that a spreadsheet would read as a
 * formula (starting with = + - @, a tab or a carriage return) gets a leading
 * apostrophe, so an address or name typed by a visitor can't run in the
 * owner's spreadsheet.
 */
export function csvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => {
      const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    })
    .join(",");
}
