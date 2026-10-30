import { expect, test } from "bun:test";
import { groupExports } from "./fetch.ts";

const file = (name: string, createdTime: string) => ({ id: name, name, mimeType: "application/x-zip-compressed", createdTime });

test("groups multi-part exports and picks the newest", () => {
  const exports = groupExports([
    file("takeout-20261001T060000Z-002.zip", "2026-10-01T06:20:00Z"),
    file("takeout-20261001T060000Z-001.zip", "2026-10-01T06:10:00Z"),
    file("takeout-20260827T120000Z-001.zip", "2026-08-27T12:10:00Z"),
    file("takeout-notes.txt", "2026-10-02T00:00:00Z"),
  ]);
  expect(exports.map(e => e.key)).toEqual(["takeout-20261001T060000Z", "takeout-20260827T120000Z"]);
  expect(exports[0]!.parts.map(p => p.name)).toEqual(["takeout-20261001T060000Z-001.zip", "takeout-20261001T060000Z-002.zip"]);
});

test("keeps the archive_browser part and the data part (-1-001) of one export together", () => {
  const exports = groupExports([
    file("takeout-20261027T154352Z-001.zip", "2026-10-27T15:49:17Z"),
    file("takeout-20261027T154352Z-1-001.zip", "2026-10-27T15:49:03Z"),
    file("takeout-20260927T154126Z-001.zip", "2026-09-27T15:46:35Z"),
    file("takeout-20260927T154126Z-1-001.zip", "2026-09-27T15:46:32Z"),
  ]);
  expect(exports.map(e => e.key)).toEqual(["takeout-20261027T154352Z", "takeout-20260927T154126Z"]);
  expect(exports[0]!.parts.map(p => p.name)).toEqual(["takeout-20261027T154352Z-001.zip", "takeout-20261027T154352Z-1-001.zip"]);
});
