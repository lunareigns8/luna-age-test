const WEIGHTS = [7, 3, 1];

export function normalizeOcrText(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^\nA-Z0-9< «‹〈＜:\-]/g, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^MRZ[:\-\s]*/i, "")
        .replace(/^LINE\s*[123][:\-\s]*/i, "")
        .replace(/\s+/g, "")
        .replace(/[«‹〈＜]/g, "<")
    )
    .filter(Boolean)
    .join("\n");
}

export function extractMrzLines(text) {
  const cleanedLines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let original = cleanedLines
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.length >= 25 && /^[A-Z0-9<]+$/.test(item.line));

  // Manual input sometimes comes as one long wrapped string. Rebuild common MRZ formats.
  if (original.length < 2) {
    const compact = cleanedLines.join("").replace(/[^A-Z0-9<]/g, "");
    const rebuilt = [];

    // Prefer exact complete lengths first. A TD1 MRZ is 90 chars, which is also
    // greater than 88; checking TD3 first would incorrectly cut TD1 as TD3.
    if (compact.length === 90) rebuilt.push(compact.slice(0, 30), compact.slice(30, 60), compact.slice(60, 90));
    else if (compact.length === 88) rebuilt.push(compact.slice(0, 44), compact.slice(44, 88));
    else if (compact.length === 72) rebuilt.push(compact.slice(0, 36), compact.slice(36, 72));
    else if (compact.length > 90 && compact.length % 30 === 0) rebuilt.push(compact.slice(0, 30), compact.slice(30, 60), compact.slice(60, 90));
    else if (compact.length > 88) rebuilt.push(compact.slice(0, 44), compact.slice(44, 88));
    else if (compact.length > 72) rebuilt.push(compact.slice(0, 36), compact.slice(36, 72));

    if (rebuilt.length) {
      original = rebuilt.map((line, index) => ({ line, index }));
    }
  }

  const exact44 = original.filter((item) => item.line.length === 44);
  if (exact44.length >= 2) return exact44.slice(0, 2).map((item) => item.line);

  const exact30 = original.filter((item) => item.line.length === 30);
  if (exact30.length >= 3) return exact30.slice(0, 3).map((item) => item.line);

  const exact36 = original.filter((item) => item.line.length === 36);
  if (exact36.length >= 2) return exact36.slice(0, 2).map((item) => item.line);

  return original
    .map((item) => ({ ...item, score: scoreLine(item.line) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line);
}

function scoreLine(line) {
  let score = 0;
  if (line.includes("<")) score += 20;
  if (/^[PVIAC][A-Z0-9<]/.test(line)) score += 10;
  if ([30, 36, 44].includes(line.length)) score += 20;
  score += Math.min(22, line.length / 2);
  score += (line.match(/</g) || []).length;
  return score;
}

export function parseMRZ(lines) {
  if (!Array.isArray(lines)) lines = extractMrzLines(normalizeOcrText(lines));
  lines = lines.map((line) => line.trim());

  if (lines.length >= 2 && lines[0].length >= 40 && lines[1].length >= 40) {
    return parseTD3(lines[0].padEnd(44, "<").slice(0, 44), lines[1].padEnd(44, "<").slice(0, 44));
  }

  if (lines.length >= 3 && lines[0].length >= 28 && lines[1].length >= 28 && lines[2].length >= 28) {
    return parseTD1(
      lines[0].padEnd(30, "<").slice(0, 30),
      lines[1].padEnd(30, "<").slice(0, 30),
      lines[2].padEnd(30, "<").slice(0, 30)
    );
  }

  if (lines.length >= 2 && lines[0].length >= 34 && lines[1].length >= 34) {
    return parseTD2(lines[0].padEnd(36, "<").slice(0, 36), lines[1].padEnd(36, "<").slice(0, 36));
  }

  throw new Error("Could not find valid TD3, TD2, or TD1 MRZ lines. Try a clearer photo or wider crop.");
}

function parseTD3(line1, line2) {
  const names = parseNames(line1.slice(5));
  const documentNumber = line2.slice(0, 9);
  const documentNumberCheck = fixDigit(line2[9]);
  const birthDate = fixNumeric(line2.slice(13, 19));
  const birthDateCheck = fixDigit(line2[19]);
  const expiryDate = fixNumeric(line2.slice(21, 27));
  const expiryDateCheck = fixDigit(line2[27]);
  const personalNumber = line2.slice(28, 42);
  const personalNumberCheck = fixDigit(line2[42]);

  const checks = [
    check("Document number", documentNumber, documentNumberCheck),
    check("Birth date", birthDate, birthDateCheck),
    check("Expiry date", expiryDate, expiryDateCheck),
    check("Personal number", personalNumber, personalNumberCheck),
    check("Composite", documentNumber + documentNumberCheck + birthDate + birthDateCheck + expiryDate + expiryDateCheck + personalNumber + personalNumberCheck, fixDigit(line2[43])),
  ];

  return {
    format: "TD3 passport",
    rawLines: [line1, line2],
    documentType: clean(line1.slice(0, 2)),
    issuingCountry: cleanAlpha(line1.slice(2, 5)),
    surname: names.surname,
    givenNames: names.givenNames,
    documentNumber: clean(documentNumber),
    nationality: cleanAlpha(line2.slice(10, 13)),
    birthDate: formatDate(birthDate, "birth"),
    sex: normalizeSex(line2[20]),
    expirationDate: formatDate(expiryDate, "expiry"),
    personalNumber: clean(personalNumber),
    checks,
    valid: checks.every((c) => c.valid),
  };
}

function parseTD2(line1, line2) {
  const names = parseNames(line1.slice(5));
  const documentNumber = line2.slice(0, 9);
  const documentNumberCheck = fixDigit(line2[9]);
  const birthDate = fixNumeric(line2.slice(13, 19));
  const birthDateCheck = fixDigit(line2[19]);
  const expiryDate = fixNumeric(line2.slice(21, 27));
  const expiryDateCheck = fixDigit(line2[27]);
  const optionalData = line2.slice(28, 35);

  const checks = [
    check("Document number", documentNumber, documentNumberCheck),
    check("Birth date", birthDate, birthDateCheck),
    check("Expiry date", expiryDate, expiryDateCheck),
    check("Composite", documentNumber + documentNumberCheck + birthDate + birthDateCheck + expiryDate + expiryDateCheck + optionalData, fixDigit(line2[35])),
  ];

  return {
    format: "TD2 identity/travel document",
    rawLines: [line1, line2],
    documentType: clean(line1.slice(0, 2)),
    issuingCountry: cleanAlpha(line1.slice(2, 5)),
    surname: names.surname,
    givenNames: names.givenNames,
    documentNumber: clean(documentNumber),
    nationality: cleanAlpha(line2.slice(10, 13)),
    birthDate: formatDate(birthDate, "birth"),
    sex: normalizeSex(line2[20]),
    expirationDate: formatDate(expiryDate, "expiry"),
    personalNumber: clean(optionalData),
    checks,
    valid: checks.every((c) => c.valid),
  };
}

function parseTD1(line1, line2, line3) {
  const names = parseNames(line3);
  const documentNumber = line1.slice(5, 14);
  const documentNumberCheck = fixDigit(line1[14]);
  const birthDate = fixNumeric(line2.slice(0, 6));
  const birthDateCheck = fixDigit(line2[6]);
  const expiryDate = fixNumeric(line2.slice(8, 14));
  const expiryDateCheck = fixDigit(line2[14]);
  const optional1 = line1.slice(15, 30);
  const optional2 = line2.slice(18, 29);

  const checks = [
    check("Document number", documentNumber, documentNumberCheck),
    check("Birth date", birthDate, birthDateCheck),
    check("Expiry date", expiryDate, expiryDateCheck),
    check("Composite", documentNumber + documentNumberCheck + optional1 + birthDate + birthDateCheck + expiryDate + expiryDateCheck + optional2, fixDigit(line2[29])),
  ];

  return {
    format: "TD1 identity card",
    rawLines: [line1, line2, line3],
    documentType: clean(line1.slice(0, 2)),
    issuingCountry: cleanAlpha(line1.slice(2, 5)),
    documentNumber: clean(documentNumber),
    nationality: cleanAlpha(line2.slice(15, 18)),
    birthDate: formatDate(birthDate, "birth"),
    sex: normalizeSex(line2[7]),
    expirationDate: formatDate(expiryDate, "expiry"),
    personalNumber: clean(optional1 + optional2),
    surname: names.surname,
    givenNames: names.givenNames,
    checks,
    valid: checks.every((c) => c.valid),
  };
}

function check(name, value, actual) {
  const expected = String(checkDigit(value));
  return { name, value, expected, actual, valid: expected === actual };
}

export function checkDigit(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += charValue(input[i]) * WEIGHTS[i % 3];
  return sum % 10;
}

function charValue(char) {
  if (char === "<") return 0;
  if (/[0-9]/.test(char)) return Number(char);
  if (/[A-Z]/.test(char)) return char.charCodeAt(0) - 55;
  return 0;
}

function parseNames(field) {
  const [surname = "", given = ""] = field.split("<<");
  return { surname: cleanName(surname), givenNames: cleanName(given) };
}

function fixNumeric(value) {
  return String(value || "")
    .replace(/[OQD]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2");
}

function fixDigit(value) {
  return fixNumeric(value).replace(/[^0-9]/g, "").slice(0, 1) || String(value || "");
}

function clean(value) {
  return String(value || "").replace(/</g, " ").trim();
}

function cleanAlpha(value) {
  return clean(value)
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B");
}

function cleanName(value) {
  return cleanAlpha(value).replace(/\s+/g, " ");
}

function normalizeSex(value) {
  const sex = cleanAlpha(value).trim();
  if (sex === "M" || sex === "F" || sex === "X") return sex;
  return "Unspecified";
}

function formatDate(yymmdd, type) {
  if (!/^\d{6}$/.test(yymmdd)) return yymmdd;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);

  // MRZ stores dates as YYMMDD. For a reader project, keep the conversion
  // predictable instead of guessing based on the current day.
  // 00-59 => 2000-2059, 60-99 => 1960-1999.
  const century = yy >= 60 ? "19" : "20";

  return `${century}${String(yy).padStart(2, "0")}-${mm}-${dd}`;
}
