#!/usr/bin/env python3
"""Build the CET-6 seed word list from the supplied PDF.

The PDF is a two-column vocabulary booklet.  We keep the source order and
repair a handful of obvious text-extraction artefacts (for example, a word
whose first letters were moved to the following line).  Everything else is
normalised, de-duplicated and enriched with an IPA pronunciation.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".deps"))

from pypdf import PdfReader  # noqa: E402
import eng_to_ipa  # noqa: E402

PDF = ROOT / "大学英语六级词汇乱序版.pdf"
OUT = ROOT / "data" / "words.seed.json"

POS_TOKEN = r"(?:v\.aux\.?|n\.|vt\.|vi\.|v\.|a\.|ad\.|prep\.|conj\.|pron\.|num\.|art\.|int\.|aux\.|abbr\.)"
POS_SEQ = rf"{POS_TOKEN}(?:\s*&\s*{POS_TOKEN})*"
ENTRY_RE = re.compile(
    rf"([A-Za-z][A-Za-z'\-]*(?:\([a-z]+\))?)\s*({POS_SEQ})"
)

FIXES = {
    "rmost": "outermost",
    "outeintegral": "integral",
    "iinfinitely": "infinitely",
    "ndefinite": "indefinite",
    "mishief": "mischief",
    "ile": "tile",
    "twatt": "watt",
}

PROPER = {
    "jesus", "islam", "catholic", "heaven", "jupiter", "saturn", "venus",
    "mars", "christ", "buddhism", "egyptian", "roman", "moslem", "christian",
    "thanksgiving",
}

POS_MARKER = re.compile(
    r"(?<=[\u4e00-\u9fff）)])\s*(?=(?:v\.aux|n|vt|vi|v|a|ad|prep|conj|pron|num|art|int|aux|abbr)\.)"
)

IPA_OVERRIDES = {
    "jewellery": "/ˈdʒuːəlri/",
    "regenerative": "/rɪˈdʒenərətɪv/",
    "subscript": "/ˈsʌbskrɪpt/",
    "southwards": "/ˈsaʊθwədz/",
    "faultless": "/ˈfɔːltləs/",
    "nought": "/nɔːt/",
    "dependant": "/dɪˈpendənt/",
    "paralyse": "/ˈpærəlaɪz/",
    "tradesman": "/ˈtreɪdzmən/",
    "motorway": "/ˈməʊtəweɪ/",
    "sitting-room": "/ˈsɪtɪŋ ruːm/",
    "destine": "/ˈdestɪn/",
    "gramophone": "/ˈɡræməfəʊn/",
    "second-hand": "/ˌsekənd ˈhænd/",
    "vigour": "/ˈvɪɡə/",
    "workpiece": "/ˈwɜːkpiːs/",
    "flavour": "/ˈfleɪvə/",
    "by-product": "/ˈbaɪ prɒdʌkt/",
    "offence": "/əˈfens/",
    "waggon": "/ˈwæɡən/",
    "pyjamas": "/pəˈdʒɑːməz/",
    "pedlar": "/ˈpedlə/",
    "entreat": "/ɪnˈtriːt/",
}


def clean_ipa(word: str) -> str:
    """Return a compact, display-friendly IPA transcription."""
    if word in IPA_OVERRIDES:
        return IPA_OVERRIDES[word]
    try:
        raw = eng_to_ipa.convert(word)
    except Exception:
        raw = ""
    if not raw or "*" in raw or not re.search(r"[a-zɑæɒɔəɜɛɪʊʌθðʃʒŋɹɾʔˈˌː]", raw):
        return IPA_OVERRIDES.get(word, "")
    raw = raw.split(",")[0].strip()
    raw = (
        raw.replace("ʧ", "tʃ")
        .replace("ʤ", "dʒ")
        .replace("ɚ", "ər")
        .replace("ɝ", "ɜːr")
        .replace("ˈˈ", "ˈ")
    )
    raw = re.sub(r"\s+", " ", raw)
    return f"/{raw.strip('/')}/"


def clean_meaning(text: str) -> str:
    text = text.strip(" ;；,，&")
    text = re.sub(r"\s+", " ", text)
    # Separate a newly introduced part of speech from the Chinese sense.
    text = POS_MARKER.sub("；", text)
    # "vt.&vi." -> "vt. / vi."
    text = re.sub(r"(?<=\.)\s*&\s*(?=[a-z]+\.)", " / ", text)
    # A few definitions are truncated inside a parenthesis in the source.
    if text.count("(") > text.count(")"):
        text += ")"
    text = re.sub(r"[；;]\s*[；;]+", "；", text)
    text = re.sub(
        r"((?:v\.aux|n|vt|vi|v|a|ad|prep|conj|pron|num|art|int|aux|abbr)\.)(?=[\u4e00-\u9fff(])",
        r"\1 ",
        text,
    )
    text = re.sub(r"\s+([；，。])", r"\1", text)
    text = re.sub(r"([；，。])\s+", r"\1", text)
    text = text.strip(" ；;，,")
    return text


def parse_entries() -> list[dict]:
    reader = PdfReader(str(PDF))
    lines: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line == "新东方国际教育" or re.fullmatch(r"\d+", line):
                continue
            # The final page contains four private-use glyphs from the PDF
            # generator.  They carry no vocabulary content.
            if not re.match(r"[A-Za-z\u4e00-\u9fff]", line):
                continue
            # Two definitions wrap onto their own visual line.
            if not re.match(r"[A-Za-z]", line) and re.search(r"[\u4e00-\u9fff]", line):
                if lines:
                    lines[-1] += line
                continue
            lines.append(line)

    # Two entries lost their part-of-speech dot in extraction.
    normalised: list[str] = []
    for line in lines:
        line = line.replace(" bulletin 告示", " bulletin n.告示")
        line = re.sub(r" allowance n ", " allowance n. ", line)
        normalised.append(line)

    records: list[dict] = []
    for line in normalised:
        matches = list(ENTRY_RE.finditer(line))
        if not matches:
            continue
        for i, match in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
            word = match.group(1)
            pos = match.group(2).replace(" ", "")
            meaning = clean_meaning(line[match.end():end])
            if not meaning:
                continue
            records.append({"word": word, "pos": pos, "meaning": meaning})
    return records


def normalise(records: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for rec in records:
        word = rec["word"].lower()
        word = FIXES.get(word, word)
        word = re.sub(r"\([a-z]+\)$", "", word)
        display = word.capitalize() if word in PROPER else word
        key = display.lower()
        pos = rec["pos"]
        if "&" in pos:
            pos = " / ".join(p.strip() for p in pos.split("&"))
        if key in merged:
            old = merged[key]
            if rec["meaning"] not in old["meaning"]:
                old["meaning"] = old["meaning"].rstrip("；") + "；" + rec["meaning"]
            if pos not in old["pos"]:
                old["pos"] += " / " + pos
            continue
        merged[key] = {
            "word": display,
            "pos": pos,
            "meaning": clean_meaning(rec["meaning"]),
            "phonetic": clean_ipa(display.lower()),
            "starred": False,
            "status": "new",
            "note": "",
            "source": "pdf",
            "order": len(merged) + 1,
        }
    return list(merged.values())


def main() -> None:
    records = normalise(parse_entries())
    for idx, rec in enumerate(records, 1):
        rec["id"] = f"w{idx:04d}"
        rec["createdAt"] = "2026-10-28T00:00:00+08:00"
    payload = {
        "version": 1,
        "title": "大学英语六级词汇 · 乱序版",
        "source": PDF.name,
        "count": len(records),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "words": records,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    missing_ipa = [r["word"] for r in records if not r["phonetic"]]
    print(f"Wrote {len(records)} words to {OUT}")
    print(f"IPA coverage: {len(records) - len(missing_ipa)}/{len(records)}")
    if missing_ipa:
        print("Missing IPA:", ", ".join(missing_ipa[:40]))


if __name__ == "__main__":
    main()
