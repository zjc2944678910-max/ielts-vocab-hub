"use strict";

const fs = require("node:fs");
const vm = require("node:vm");

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) throw new Error("usage: node export_ielts.js dict.js output.json");

const context = {};
vm.runInNewContext(`${fs.readFileSync(sourcePath, "utf8")}\nthis.__db=ieltsFullDatabase;this.__mixed=paraphrasePairsFull;`, context);
const records = [...context.__db, ...context.__mixed.filter(item => item?.word)];
const byWord = new Map();
const unique = values => [...new Set((values || []).filter(Boolean).map(value => typeof value === "string" ? value.trim() : value))];
const uniqueExamples = values => {
  const seen = new Set();
  return (values || []).filter(item => {
    const key = `${item?.en || ""}\n${item?.cn || ""}`;
    if (!item?.en || seen.has(key)) return false;
    seen.add(key); return true;
  });
};

for (const item of records) {
  const key = String(item.word || "").trim().toLowerCase();
  if (!key) continue;
  if (!byWord.has(key)) {
    byWord.set(key, {
      ...item,
      related_topics: [],
      catalogs: ["ielts"],
      source_tags: ["ielts"],
      classification_source: "curated",
      manual_fields: [],
      learning_mode: /writing|speaking/i.test(item.module || "") ? "production" : "recognition"
    });
    continue;
  }
  const current = byWord.get(key);
  if (item.topic && item.topic !== current.topic) current.related_topics = unique([...current.related_topics, item.topic]);
  for (const field of ["synonyms", "antonyms", "collocations"]) current[field] = unique([...(current[field] || []), ...(item[field] || [])]);
  current.examples = uniqueExamples([...(current.examples || []), ...(item.examples || [])]);
  if (/writing|speaking/i.test(item.module || "")) current.learning_mode = "production";
}

const output = [...byWord.values()];
if (output.length !== 185) throw new Error(`expected 185 unique IELTS entries, got ${output.length}`);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

