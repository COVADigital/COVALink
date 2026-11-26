/**
 * One CSV row (RFC 4180 quoting). A cell a spreadsheet would read as a formula
 * (starting with = + - @, a tab or a carriage return) gets a leading
 * apostrophe, so an address or name typed by a visitor can't run in the
 * owner's spreadsheet. Spreadsheets that use `;` as the separator honour a
 * quote only at the very start of a field, so inside a quoted cell a `;` or a
 * line break can start a new field or record. An apostrophe is therefore also
 * inserted after every `;`, CR or LF that precedes one of those characters or
 * a double quote (a CRLF pair stays intact). That protects every column and
 * either separator, at the cost of a visible apostrophe in such rare cells.
 */
export function csvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => {
      const prefixed = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      const safe = prefixed.replace(/([;\r\n])(?=[=+\-@\t\r"])/g, "$1'");
      return /[",;\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    })
    .join(",");
}
