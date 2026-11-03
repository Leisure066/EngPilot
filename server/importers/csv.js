"use strict";

/**
 * Minimal CSV line parser for the ECDICT/stardict dump.
 *
 * The dump is one record per physical line: embedded newlines are written as
 * the two characters `\n`, but commas inside translations are normal CSV
 * quoted fields, so quoted commas and doubled quotes must be handled.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' && current === "") {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return { fields, closed: !inQuotes };
}

module.exports = { parseCsvLine };